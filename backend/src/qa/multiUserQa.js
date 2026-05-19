import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  acceptInviteToken,
  assertUserPathAccess,
  createProjectInvite,
  createWorkspaceProjectForUser,
  createUserWithHash,
  getProjectForUser,
  listProjectsForUser,
  tokenHash
} from "../accessControl.js";
import { hashPassword } from "../auth.js";
import { config } from "../config.js";
import { pool, query } from "../db.js";
import { resolveSafePath } from "../structure.js";

async function rejects(fn, pattern) {
  let rejected = false;
  try {
    await fn();
  } catch (error) {
    rejected = true;
    if (pattern) assert.match(error.message, pattern);
  }
  assert.equal(rejected, true, "Expected function to reject");
}

const id = randomUUID().slice(0, 8);
const emailA = `qa-owner-${id}@example.test`;
const emailB = `qa-editor-${id}@example.test`;
const projectName = `QA Multi User ${id}`;
const previousAuthEnabled = config.authEnabled;

try {
  config.authEnabled = true;
  await query("DELETE FROM project_invites WHERE email IN ($1,$2)", [emailA, emailB]);
  await query("DELETE FROM users WHERE email IN ($1,$2)", [emailA, emailB]);

  const passwordHash = await hashPassword("correct-password-123");
  const owner = await createUserWithHash({ email: emailA, passwordHash, displayName: "QA Owner", role: "admin" });
  const projectResult = await createWorkspaceProjectForUser(owner, {
    name: projectName,
    goals: "QA multi-user project",
    basePath: ""
  });
  const project = projectResult.project;

  const ownerProjects = await listProjectsForUser(owner);
  assert.equal(ownerProjects.some((item) => Number(item.id) === Number(project.id)), true);

  const secondPasswordHash = await hashPassword("another-password-123");
  const outsider = await createUserWithHash({ email: emailB, passwordHash: secondPasswordHash, displayName: "QA Editor" });
  const outsiderProjectsBefore = await listProjectsForUser(outsider);
  assert.equal(outsiderProjectsBefore.some((item) => Number(item.id) === Number(project.id)), false);
  await rejects(() => getProjectForUser(project.id, outsider), /Project not found/);

  await query("DELETE FROM users WHERE id=$1", [outsider.id]);
  const invite = await createProjectInvite(project.id, emailB, owner);
  assert.ok(invite.token, "Invite token should be returned once");
  const stored = await query("SELECT token_hash FROM project_invites WHERE id=$1", [invite.id]);
  assert.equal(stored.rows[0].token_hash, tokenHash(invite.token));
  assert.notEqual(stored.rows[0].token_hash, invite.token);

  const accepted = await acceptInviteToken(invite.token, {
    passwordHash: secondPasswordHash,
    displayName: "QA Editor"
  });
  assert.equal(accepted.membership.role, "editor");

  const editorProjects = await listProjectsForUser(accepted.user);
  assert.equal(editorProjects.some((item) => Number(item.id) === Number(project.id)), true);
  await getProjectForUser(project.id, accepted.user, { roles: ["owner", "editor"] });
  await rejects(() => getProjectForUser(project.id, accepted.user, { roles: ["owner"] }), /permission/i);

  const outside = resolveSafePath(path.join(config.fsBasePath, `qa-outside-${id}`));
  await mkdir(outside, { recursive: true });
  await rejects(() => assertUserPathAccess(owner, outside), /outside your personal workspace/i);
  await assertUserPathAccess(owner, project.root_path);
  await rm(outside, { recursive: true, force: true });
} finally {
  config.authEnabled = previousAuthEnabled;
  await query("DELETE FROM projects WHERE name=$1", [projectName]).catch(() => null);
  await query("DELETE FROM users WHERE email IN ($1,$2)", [emailA, emailB]).catch(() => null);
  await pool.end().catch(() => null);
}

console.log("multiUserQa ok");
