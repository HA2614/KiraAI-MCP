import { createHash, randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { query } from "./db.js";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "./errors.js";
import { resolveExistingSafePath, resolveSafePath, resolveWritableSafePath } from "./structure.js";

const MEMBER_ROLES = new Set(["owner", "editor"]);

function withSep(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function addDaysMs(date, ms) {
  return new Date(date.getTime() + Number(ms || 0));
}

function sanitizeSlug(value, fallback = "user") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("A valid email address is required");
  }
  return email;
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.displayName || "",
    role: row.role || "user",
    status: row.status || "active",
    workspaceRoot: row.workspace_root || row.workspaceRoot || ""
  };
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

export function createInviteToken() {
  return randomBytes(32).toString("base64url");
}

export async function countUsers() {
  const row = await query("SELECT COUNT(*)::int AS count FROM users");
  return Number(row.rows[0]?.count || 0);
}

export async function getUserById(id) {
  if (!id) return null;
  const row = await query("SELECT * FROM users WHERE id=$1 LIMIT 1", [id]);
  return row.rows[0] || null;
}

export async function getUserByEmail(emailValue) {
  const email = normalizeEmail(emailValue);
  const row = await query("SELECT * FROM users WHERE email=$1 LIMIT 1", [email]);
  return row.rows[0] || null;
}

export async function ensureUserWorkspace(userOrId) {
  const user = typeof userOrId === "object" ? userOrId : await getUserById(userOrId);
  if (!user) throw new NotFoundError("User not found");
  const existing = String(user.workspace_root || "").trim();
  const workspaceRoot = existing || path.join(
    resolveSafePath(config.fsBasePath),
    "users",
    `u_${user.id}_${sanitizeSlug(user.email, "user")}`
  );
  const safeRoot = await resolveWritableSafePath(workspaceRoot);
  await mkdir(safeRoot, { recursive: true });
  if (safeRoot !== existing) {
    const updated = await query(
      "UPDATE users SET workspace_root=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [safeRoot, user.id]
    );
    return updated.rows[0];
  }
  return { ...user, workspace_root: safeRoot };
}

export async function createUserWithHash({ email, passwordHash, displayName = "", role = "user", status = "active" }) {
  const normalizedEmail = normalizeEmail(email);
  if (!passwordHash) throw new ValidationError("Password hash is required");
  const row = await query(
    `INSERT INTO users (email, password_hash, display_name, role, status)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [normalizedEmail, passwordHash, String(displayName || "").trim(), role, status]
  );
  return ensureUserWorkspace(row.rows[0]);
}

export async function touchUserLogin(userId) {
  await query("UPDATE users SET last_login_at=NOW(), updated_at=NOW() WHERE id=$1", [userId]).catch(() => null);
}

export async function ensureLegacyProjectsOwnedBy(userId) {
  if (!userId) return;
  await query(
    `INSERT INTO project_memberships (project_id, user_id, role)
     SELECT p.id, $1, 'owner'
     FROM projects p
     WHERE NOT EXISTS (
       SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id
     )
     ON CONFLICT (project_id, user_id) DO NOTHING`,
    [userId]
  );
  await query(
    `UPDATE projects p
     SET owner_user_id=$1,
         created_by_user_id=COALESCE(created_by_user_id, $1),
         updated_at=NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM project_memberships pm
       WHERE pm.project_id = p.id AND pm.role='owner' AND pm.user_id <> $1
     )
       AND (p.owner_user_id IS NULL OR p.owner_user_id=$1)`,
    [userId]
  );
}

export async function ensureFirstAdmin({ email, passwordHash } = {}) {
  const existing = await countUsers();
  if (existing > 0) {
    const firstAdmin = await query("SELECT * FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
    const fallback = firstAdmin.rows[0] || (await query("SELECT * FROM users ORDER BY id ASC LIMIT 1")).rows[0];
    if (fallback) await ensureLegacyProjectsOwnedBy(fallback.id);
    return fallback || null;
  }
  if (!passwordHash) return null;
  const admin = await createUserWithHash({
    email: email || "admin@kiraai.local",
    passwordHash,
    displayName: "KiraAI Admin",
    role: "admin"
  });
  await ensureLegacyProjectsOwnedBy(admin.id);
  return admin;
}

export async function setupFirstUser({ email, passwordHash, displayName = "" }) {
  if ((await countUsers()) > 0) throw new ForbiddenError("Setup has already been completed", "SETUP_COMPLETE");
  const user = await createUserWithHash({
    email,
    passwordHash,
    displayName: displayName || "KiraAI Admin",
    role: "admin"
  });
  await ensureLegacyProjectsOwnedBy(user.id);
  return user;
}

export async function ensureProjectMembership(projectId, userId, role = "editor") {
  if (!projectId || !userId) return null;
  const normalizedRole = MEMBER_ROLES.has(role) ? role : "editor";
  const row = await query(
    `INSERT INTO project_memberships (project_id, user_id, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET role=CASE
       WHEN project_memberships.role='owner' THEN 'owner'
       ELSE EXCLUDED.role
     END, updated_at=NOW()
     RETURNING *`,
    [projectId, userId, normalizedRole]
  );
  if (normalizedRole === "owner") {
    await query(
      "UPDATE projects SET owner_user_id=$1, created_by_user_id=COALESCE(created_by_user_id, $1), updated_at=NOW() WHERE id=$2",
      [userId, projectId]
    );
  }
  return row.rows[0];
}

function projectSelectSql({ includeMembership = false } = {}) {
  return `SELECT p.*,
              ${includeMembership ? "pm.role" : "NULL"} AS membership_role,
              latest.id AS source_summary_id,
              latest.analysis_version AS source_analysis_version,
              latest.created_at AS source_analysis_created_at,
              latest.duration_ms AS source_analysis_duration_ms,
              latest.model AS source_analysis_model,
              latest_code.id AS latest_code_job_id,
              latest_code.status AS latest_code_job_status,
              latest_code.duration_ms AS latest_code_job_duration_ms,
              latest_code.created_at AS latest_code_job_created_at,
              latest_code.model AS latest_code_job_model
       FROM projects p
       ${includeMembership ? "JOIN project_memberships pm ON pm.project_id = p.id" : ""}
       LEFT JOIN LATERAL (
         SELECT id, analysis_version, created_at, duration_ms, model
         FROM codebase_summaries s
         WHERE s.project_id = p.id OR (p.root_path <> '' AND s.root_path = p.root_path)
         ORDER BY created_at DESC
         LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, status, duration_ms, created_at, model
         FROM code_jobs c
         WHERE c.project_id = p.id OR (p.root_path <> '' AND c.root_path = p.root_path)
         ORDER BY created_at DESC
         LIMIT 1
       ) latest_code ON TRUE`;
}

export async function listProjectsForUser(user) {
  if (!config.authEnabled || !user?.id) {
    const rows = await query(`${projectSelectSql()} ORDER BY p.created_at DESC`);
    return rows.rows;
  }
  const rows = await query(
    `${projectSelectSql({ includeMembership: true })}
     WHERE pm.user_id=$1
     ORDER BY p.created_at DESC`,
    [user.id]
  );
  return rows.rows;
}

export async function getProjectForUser(projectId, user, { roles = ["owner", "editor"] } = {}) {
  if (!config.authEnabled || !user?.id) {
    const row = await query(`${projectSelectSql()} WHERE p.id=$1 LIMIT 1`, [projectId]);
    if (!row.rowCount) throw new NotFoundError("Project not found");
    return row.rows[0];
  }
  const row = await query(
    `${projectSelectSql({ includeMembership: true })}
     WHERE p.id=$1 AND pm.user_id=$2
     LIMIT 1`,
    [projectId, user.id]
  );
  if (!row.rowCount) throw new NotFoundError("Project not found");
  const project = row.rows[0];
  if (roles?.length && !roles.includes(project.membership_role)) {
    throw new ForbiddenError("You do not have permission for this project", "PROJECT_ROLE_REQUIRED");
  }
  return project;
}

export async function getProjectByPlanForUser(planId, user, options = {}) {
  const row = await query("SELECT project_id FROM project_plans WHERE id=$1 LIMIT 1", [planId]);
  if (!row.rowCount) throw new NotFoundError("Plan not found");
  return getProjectForUser(row.rows[0].project_id, user, options);
}

export async function getAllowedRootsForUser(user) {
  if (!config.authEnabled || !user?.id) return [resolveSafePath(config.fsBasePath)];
  const ensured = await ensureUserWorkspace(user);
  const roots = [ensured.workspace_root];
  const rows = await query(
    `SELECT p.root_path
     FROM projects p
     JOIN project_memberships pm ON pm.project_id=p.id
     WHERE pm.user_id=$1 AND p.root_path <> ''`,
    [user.id]
  );
  for (const row of rows.rows) roots.push(row.root_path);
  const cleaned = [];
  for (const root of roots) {
    if (!root) continue;
    try {
      cleaned.push(resolveSafePath(root));
    } catch {
      // Ignore stale roots outside FS_BASE_PATH instead of granting access.
    }
  }
  return [...new Set(cleaned.map((root) => path.resolve(root)))];
}

export async function assertUserPathAccess(user, targetPath, { write = false } = {}) {
  const safeTarget = write
    ? await resolveWritableSafePath(targetPath)
    : await resolveExistingSafePath(targetPath);
  if (!config.authEnabled || !user?.id) return safeTarget;
  const allowedRoots = await getAllowedRootsForUser(user);
  const allowed = allowedRoots.some((root) => safeTarget === root || safeTarget.startsWith(withSep(root)) || isInside(root, safeTarget));
  if (!allowed) {
    throw new ForbiddenError("Path is outside your personal workspace or shared projects", "FS_ACCESS_DENIED");
  }
  return safeTarget;
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function projectFolderSlug(value) {
  return sanitizeSlug(value, "project");
}

export async function nextAvailableUserProjectFolder(user, projectName, basePath = "") {
  const ensured = await ensureUserWorkspace(user);
  const parentCandidate = basePath?.trim()
    ? await assertUserPathAccess(ensured, basePath, { write: true })
    : await resolveWritableSafePath(path.join(ensured.workspace_root, "projects"));
  const parent = await assertUserPathAccess(ensured, parentCandidate, { write: true });
  await mkdir(parent, { recursive: true });
  const slug = projectFolderSlug(projectName);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = await assertUserPathAccess(ensured, path.join(parent, `${slug}${suffix}`), { write: true });
    if (!(await pathExists(candidate))) return { parent, rootPath: candidate };
  }
  throw new ValidationError("Could not find an available project folder name");
}

export async function createProjectRecordForUser(user, payload) {
  const { name, goals, techStack = "", timeline = "", budget = "", rootPath = "" } = payload;
  let safeRootPath = "";
  if (rootPath?.trim()) {
    safeRootPath = await assertUserPathAccess(user, rootPath, { write: true });
  } else if (config.authEnabled && user?.id) {
    const folder = await nextAvailableUserProjectFolder(user, name);
    await mkdir(folder.rootPath, { recursive: true });
    safeRootPath = folder.rootPath;
  }
  const result = await query(
    `INSERT INTO projects (name, goals, tech_stack, timeline, budget, root_path, owner_user_id, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING *`,
    [name, goals, techStack, timeline, budget, safeRootPath, user?.id || null]
  );
  if (config.authEnabled && user?.id) await ensureProjectMembership(result.rows[0].id, user.id, "owner");
  return result.rows[0];
}

export async function createWorkspaceProjectForUser(user, payload) {
  let folder = null;
  if (config.authEnabled && user?.id) {
    folder = await nextAvailableUserProjectFolder(user, payload.name, payload.basePath || "");
  } else {
    const parent = resolveSafePath(payload.basePath || config.fsBasePath);
    await mkdir(parent, { recursive: true });
    const slug = projectFolderSlug(payload.name);
    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const candidate = resolveSafePath(path.join(parent, `${slug}${suffix}`));
      if (!(await pathExists(candidate))) {
        folder = { parent, rootPath: candidate };
        break;
      }
    }
    if (!folder) throw new ValidationError("Could not find an available project folder name");
  }
  const rootPath = folder?.rootPath || payload.rootPath || "";
  if (rootPath) await mkdir(rootPath, { recursive: false });
  const projectGoals = String(payload.goals || "").trim() || `Workspace project created in ${rootPath}. Use KiraAI Analyzer or Code Worker to build from this folder.`;
  const project = await createProjectRecordForUser(user, {
    name: String(payload.name || "").trim(),
    goals: projectGoals,
    techStack: String(payload.techStack || "").trim() || "Pending project setup",
    timeline: String(payload.timeline || "").trim() || "New workspace project",
    budget: String(payload.budget || "").trim() || "N/A",
    rootPath
  });
  return { project, rootPath: project.root_path, parent: folder?.parent || path.dirname(project.root_path || ""), created: true };
}

export async function updateProjectForUser(projectId, user, payload) {
  await getProjectForUser(projectId, user, { roles: ["owner"] });
  const safeRootPath = payload.rootPath?.trim()
    ? await assertUserPathAccess(user, payload.rootPath, { write: true })
    : "";
  const result = await query(
    `UPDATE projects
     SET name=$1, goals=$2, tech_stack=$3, timeline=$4, budget=$5, root_path=$6, updated_at=NOW()
     WHERE id=$7
     RETURNING *`,
    [payload.name, payload.goals, payload.techStack, payload.timeline, payload.budget, safeRootPath, projectId]
  );
  if (!result.rowCount) throw new NotFoundError("Project not found");
  return result.rows[0];
}

export async function deleteProjectForUser(projectId, user) {
  await getProjectForUser(projectId, user, { roles: ["owner"] });
  await query("DELETE FROM projects WHERE id=$1", [projectId]);
  return { deleted: true, id: projectId };
}

export async function createProjectInvite(projectId, emailValue, invitedByUser) {
  await getProjectForUser(projectId, invitedByUser, { roles: ["owner"] });
  const email = normalizeEmail(emailValue);
  await query(
    "UPDATE project_invites SET status='revoked', updated_at=NOW() WHERE project_id=$1 AND email=$2 AND status='pending'",
    [projectId, email]
  );
  const token = createInviteToken();
  const expiresAt = addDaysMs(new Date(), config.inviteTtlMs);
  const row = await query(
    `INSERT INTO project_invites (project_id, email, token_hash, role, invited_by_user_id, expires_at)
     VALUES ($1,$2,$3,'editor',$4,$5)
     RETURNING id, project_id, email, role, invited_by_user_id, status, expires_at, created_at`,
    [projectId, email, tokenHash(token), invitedByUser?.id || null, expiresAt]
  );
  return { ...row.rows[0], token };
}

export async function getInviteByToken(rawToken) {
  const hash = tokenHash(rawToken);
  const row = await query(
    `SELECT i.id, i.project_id, i.email, i.role, i.status, i.expires_at, i.accepted_at, i.created_at,
            p.name AS project_name
     FROM project_invites i
     JOIN projects p ON p.id=i.project_id
     WHERE i.token_hash=$1
     LIMIT 1`,
    [hash]
  );
  if (!row.rowCount) throw new NotFoundError("Invite not found");
  const invite = row.rows[0];
  invite.expired = new Date(invite.expires_at).getTime() < Date.now();
  return invite;
}

export async function acceptInviteToken(rawToken, { currentUser = null, passwordHash = "", displayName = "" } = {}) {
  const invite = await getInviteByToken(rawToken);
  if (invite.status !== "pending") throw new ValidationError("Invite is no longer pending");
  if (invite.expired) throw new ValidationError("Invite has expired");
  const inviteEmail = normalizeEmail(invite.email);

  let user = currentUser;
  if (user) {
    if (normalizeEmail(user.email) !== inviteEmail) {
      throw new ForbiddenError("You must accept this invite with the invited email address", "INVITE_EMAIL_MISMATCH");
    }
  } else {
    user = await getUserByEmail(inviteEmail);
    if (user) throw new UnauthorizedError("Log in with the invited email address before accepting this invite", "LOGIN_REQUIRED");
    if (!passwordHash) throw new ValidationError("Password is required to create this account");
    user = await createUserWithHash({ email: inviteEmail, passwordHash, displayName, role: "user" });
  }

  await ensureProjectMembership(invite.project_id, user.id, invite.role || "editor");
  await query(
    `UPDATE project_invites
     SET status='accepted', accepted_by_user_id=$1, accepted_at=NOW(), updated_at=NOW()
     WHERE id=$2`,
    [user.id, invite.id]
  );
  return {
    user,
    project: await getProjectForUser(invite.project_id, user, { roles: ["owner", "editor"] }),
    membership: { projectId: invite.project_id, userId: user.id, role: invite.role || "editor" }
  };
}

export async function listProjectMembersAndInvites(projectId, user) {
  await getProjectForUser(projectId, user, { roles: ["owner"] });
  const members = await query(
    `SELECT u.id, u.email, u.display_name, u.role AS user_role, u.status, pm.role, pm.created_at
     FROM project_memberships pm
     JOIN users u ON u.id=pm.user_id
     WHERE pm.project_id=$1
     ORDER BY CASE WHEN pm.role='owner' THEN 0 ELSE 1 END, u.email ASC`,
    [projectId]
  );
  const invites = await query(
    `SELECT id, project_id, email, role, status, expires_at, accepted_at, created_at
     FROM project_invites
     WHERE project_id=$1 AND status='pending'
     ORDER BY created_at DESC`,
    [projectId]
  );
  return { members: members.rows, invites: invites.rows };
}

export async function removeProjectMember(projectId, targetUserId, user) {
  await getProjectForUser(projectId, user, { roles: ["owner"] });
  const target = await query("SELECT * FROM project_memberships WHERE project_id=$1 AND user_id=$2 LIMIT 1", [projectId, targetUserId]);
  if (!target.rowCount) throw new NotFoundError("Member not found");
  if (target.rows[0].role === "owner") {
    const owners = await query("SELECT COUNT(*)::int AS count FROM project_memberships WHERE project_id=$1 AND role='owner'", [projectId]);
    if (Number(owners.rows[0]?.count || 0) <= 1) {
      throw new ValidationError("A project must keep at least one owner");
    }
  }
  await query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [projectId, targetUserId]);
  return { removed: true, projectId, userId: targetUserId };
}

export async function revokeProjectInvite(projectId, inviteId, user) {
  await getProjectForUser(projectId, user, { roles: ["owner"] });
  const row = await query(
    `UPDATE project_invites
     SET status='revoked', updated_at=NOW()
     WHERE project_id=$1 AND id=$2 AND status='pending'
     RETURNING id, project_id, email, role, status, expires_at, created_at`,
    [projectId, inviteId]
  );
  if (!row.rowCount) throw new NotFoundError("Invite not found");
  return row.rows[0];
}

export async function assertCodeJobAccess(jobId, user, { roles = ["owner", "editor"] } = {}) {
  const row = await query("SELECT id, project_id, root_path FROM code_jobs WHERE id=$1 LIMIT 1", [jobId]);
  if (!row.rowCount) throw new NotFoundError("Code job not found");
  const job = row.rows[0];
  if (!config.authEnabled || !user?.id) return job;
  if (job.project_id) {
    await getProjectForUser(job.project_id, user, { roles });
    return job;
  }
  await assertUserPathAccess(user, job.root_path, { write: false });
  return job;
}
