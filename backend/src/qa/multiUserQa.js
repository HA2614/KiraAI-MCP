import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  acceptInviteToken,
  assertUserPathAccess,
  createProjectInvite,
  createUserForAdmin,
  createUserWithHash,
  createWorkspaceProjectForUser,
  getUserByEmail,
  getProjectForUser,
  listUsersForAdmin,
  listProjectsForUser,
  sharedProjectsRoot,
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

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const id = randomUUID().slice(0, 8);
const adminEmail = `qa-admin-${id}@example.test`;
const emailA = `qa-owner-${id}@example.test`;
const emailB = `qa-editor-${id}@example.test`;
const projectName = `QA Multi User ${id}`;
const previousAuthEnabled = config.authEnabled;
const cleanupPaths = new Set();

try {
  config.authEnabled = true;
  await query("DELETE FROM project_invites WHERE email IN ($1,$2,$3)", [adminEmail, emailA, emailB]);
  await query("DELETE FROM projects WHERE name=$1", [projectName]);
  await query("DELETE FROM users WHERE email IN ($1,$2,$3)", [adminEmail, emailA, emailB]);

  const passwordHash = await hashPassword("correct-password-123");
  const admin = await createUserWithHash({ email: adminEmail, passwordHash, displayName: "QA Admin", role: "admin" });
  const owner = await createUserWithHash({ email: emailA, passwordHash, displayName: "QA Owner", role: "user" });
  cleanupPaths.add(admin.workspace_root);
  cleanupPaths.add(owner.workspace_root);

  const outside = resolveSafePath(path.join(config.fsBasePath, `qa-outside-${id}`));
  cleanupPaths.add(outside);
  await mkdir(outside, { recursive: true });
  await assertUserPathAccess(admin, outside);
  await rejects(() => assertUserPathAccess(owner, outside), /outside your personal workspace/i);

  const projectResult = await createWorkspaceProjectForUser(owner, {
    name: projectName,
    goals: "QA multi-user project",
    basePath: config.fsBasePath
  });
  let project = projectResult.project;
  cleanupPaths.add(project.root_path);

  assert.equal(isInside(path.join(owner.workspace_root, "projects"), project.root_path), true);
  await stat(project.root_path);
  await assertUserPathAccess(owner, project.root_path);

  const ownerProjects = await listProjectsForUser(owner);
  assert.equal(ownerProjects.some((item) => Number(item.id) === Number(project.id)), true);

  const adminProjects = await listProjectsForUser(admin);
  assert.equal(adminProjects.some((item) => Number(item.id) === Number(project.id)), true);
  await getProjectForUser(project.id, admin, { roles: ["owner"] });
  const adminUsers = await listUsersForAdmin(admin);
  assert.equal(adminUsers.some((item) => item.email === emailA), true);
  await rejects(() => listUsersForAdmin(owner), /Admin access required/i);

  const editorPasswordHash = await hashPassword("another-password-123");
  const createdByAdmin = await createUserForAdmin(admin, {
    email: emailB,
    passwordHash: editorPasswordHash,
    displayName: "QA Editor",
    role: "user"
  });
  assert.equal(createdByAdmin.email, emailB);
  const invite = await createProjectInvite(project.id, emailB, owner);
  assert.ok(invite.token, "Invite token should be returned once");
  const stored = await query("SELECT token_hash FROM project_invites WHERE id=$1", [invite.id]);
  assert.equal(stored.rows[0].token_hash, tokenHash(invite.token));
  assert.notEqual(stored.rows[0].token_hash, invite.token);

  project = await getProjectForUser(project.id, owner, { roles: ["owner"] });
  cleanupPaths.add(project.root_path);
  assert.equal(isInside(sharedProjectsRoot(), project.root_path), true);
  await stat(project.root_path);
  await assertUserPathAccess(owner, project.root_path);

  const accepted = await acceptInviteToken(invite.token, {
    currentUser: await getUserByEmail(emailB),
    displayName: "QA Editor"
  });
  cleanupPaths.add(accepted.user.workspace_root);
  assert.equal(accepted.membership.role, "editor");

  const editorProjects = await listProjectsForUser(accepted.user);
  assert.equal(editorProjects.some((item) => Number(item.id) === Number(project.id)), true);
  await getProjectForUser(project.id, accepted.user, { roles: ["owner", "editor"] });
  await rejects(() => getProjectForUser(project.id, accepted.user, { roles: ["owner"] }), /permission/i);
  await assertUserPathAccess(accepted.user, project.root_path);
  await rejects(() => assertUserPathAccess(accepted.user, outside), /outside your personal workspace/i);
} finally {
  config.authEnabled = previousAuthEnabled;
  await query("DELETE FROM projects WHERE name=$1", [projectName]).catch(() => null);
  await query("DELETE FROM users WHERE email IN ($1,$2,$3)", [adminEmail, emailA, emailB]).catch(() => null);
  for (const target of [...cleanupPaths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    await rm(target, { recursive: true, force: true }).catch(() => null);
  }
  await pool.end().catch(() => null);
}

console.log("multiUserQa ok");
