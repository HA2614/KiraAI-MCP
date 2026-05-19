import express from "express";
import { z } from "zod";
import { query } from "./db.js";
import { redis } from "./cache.js";
import { generatePlan } from "./ai.js";
import { config } from "./config.js";
import {
  generateProjectStructure,
  fsBatch,
  fsCopy,
  fsCreateFile,
  fsDelete,
  fsList,
  fsMkdir,
  fsMove,
  fsReadFile,
  fsRename,
  fsStat,
  fsTree,
  fsWriteFile,
  listDirectories,
  readTextFile,
  writeTextFile
} from "./structure.js";
import { registerFsEventStream } from "./fsEvents.js";
import {
  applyCodeJob,
  getCodeJob,
  getCodeJobAsset,
  listCodeJobs,
  listProjectCodeJobs,
  registerCodeJobEvents,
  rejectCodeJob,
  startCodeJob,
  startStructureCodeJob
} from "./codeJobs.js";
import { summarizeCodebaseWithCodex } from "./codexCodebaseSummary.js";
import { getCodebaseSummaryJob, startCodebaseSummaryJob } from "./analysisJobs.js";
import {
  addSummaryAsProject,
  getCodebaseSummaryById,
  getLearningProfile,
  listCodebaseSummaries,
  listProjectCodebaseSummaries,
  listImprovementSuggestions,
  saveCodebaseSummary
} from "./analysisStore.js";
import { listReferenceRepos } from "./referenceRepos.js";
import {
  cancelLearningJob,
  createSource,
  createSourcesBatch,
  createWebsiteSource,
  createWebsitesBatch,
  debugMindQuery,
  deleteSkill,
  deleteSource,
  deleteSourcesBulk,
  getLearningJob,
  getMlStatus,
  getSkill,
  learnSnippet,
  listLearningJobs,
  listSkills,
  listSources,
  registerMlJobEvents,
  startLearningJob,
  updateSkill,
  updateSource
} from "./mlMind.js";
import { fail, ok } from "./response.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { hashPassword, createSessionForUser } from "./auth.js";
import {
  acceptInviteToken,
  assertCodeJobAccess,
  assertUserPathAccess,
  createProjectInvite,
  createProjectRecordForUser,
  createUserForAdmin,
  createWorkspaceProjectForUser,
  deleteProjectForUser,
  ensureProjectMembership,
  getInviteByToken,
  getProjectByPlanForUser,
  getProjectForUser,
  listProjectMembersAndInvites,
  listProjectsForUser,
  listUsersForAdmin,
  publicUser,
  removeProjectMember,
  revokeProjectInvite,
  updateProjectForUser
} from "./accessControl.js";

const projectSchema = z.object({
  name: z.string().min(2),
  goals: z.string().min(5),
  techStack: z.string().optional().default(""),
  timeline: z.string().optional().default(""),
  budget: z.string().optional().default(""),
  rootPath: z.string().optional().default("")
});

const feedbackSchema = z.object({
  action: z.enum(["accept", "reject", "modify", "needs_review"]),
  comments: z.string().optional().default(""),
  modifiedPlan: z.any().optional()
});

const providerSchema = z.enum(["codex_cli", "claude_cli", "openai", "anthropic"]).optional();
const structureSchema = z.object({
  targetPath: z.string().min(1),
  profile: z.enum(["web+api", "web", "api", "docs-only"]).optional().default("web+api"),
  dryRun: z.boolean().optional().default(false),
  overwriteStrategy: z.enum(["skip_existing", "overwrite_all", "prompt_conflicts"]).optional().default("skip_existing"),
  structurePrompt: z.string().optional().default("")
});
const pathSchema = z.object({
  targetPath: z.string().min(1)
});
const writeFileSchema = z.object({
  targetPath: z.string().min(1),
  content: z.string()
});
const fsListSchema = z.object({
  targetPath: z.string().min(1),
  includeHidden: z.boolean().optional().default(true)
});
const fsTreeSchema = z.object({
  targetPath: z.string().min(1),
  depth: z.number().int().min(1).max(5).optional().default(2)
});
const fsCreateFileSchema = z.object({
  targetPath: z.string().min(1),
  content: z.string().optional().default(""),
  conflictPolicy: z.enum(["fail", "overwrite", "skip"]).optional().default("fail")
});
const fsWriteSchema = z.object({
  targetPath: z.string().min(1),
  content: z.string(),
  conflictPolicy: z.enum(["fail", "overwrite", "skip"]).optional().default("overwrite")
});
const fsRenameSchema = z.object({
  sourcePath: z.string().min(1),
  newName: z.string().min(1),
  conflictPolicy: z.enum(["fail", "overwrite", "skip"]).optional().default("fail")
});
const fsMoveCopySchema = z.object({
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  conflictPolicy: z.enum(["fail", "overwrite", "skip"]).optional().default("fail")
});
const fsBatchSchema = z.object({
  operations: z.array(z.any()).default([])
});
const summarizeSchema = z.object({
  targetPath: z.string().min(1)
});
const importProjectSchema = z.object({
  targetPath: z.string().min(1)
});
const createProjectFolderSchema = z.object({
  name: z.string().min(2),
  basePath: z.string().optional().default(""),
  goals: z.string().optional().default(""),
  techStack: z.string().optional().default(""),
  timeline: z.string().optional().default(""),
  budget: z.string().optional().default("")
});
const rootQuerySchema = z.object({
  rootPath: z.string().optional().default("")
});
const codeJobSchema = z.object({
  projectId: z.number().int().positive().optional(),
  rootPath: z.string().optional().default(""),
  userPrompt: z.string().min(1),
  responseMode: z.enum(["auto", "code", "image"]).optional().default("auto")
}).refine((data) => data.projectId || data.rootPath.trim(), {
  message: "projectId or rootPath is required",
  path: ["projectId"]
});
const codeJobHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  offset: z.coerce.number().int().min(0).optional().default(0),
  status: z.enum(["", "queued", "planning", "running", "awaiting_review", "done", "applied", "rejected", "failed"]).optional().default(""),
  type: z.enum(["", "prompt", "structure"]).optional().default("")
});
const codeStructureJobSchema = z.object({
  preset: z.enum(["full_stack"]).optional().default("full_stack"),
  instructions: z.string().optional().default("")
});
const inviteSchema = z.object({
  email: z.string().email()
});
const inviteAcceptSchema = z.object({
  password: z.string().optional().default(""),
  displayName: z.string().optional().default("")
});
const adminCreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
  displayName: z.string().optional().default(""),
  role: z.enum(["user", "admin"]).optional().default("user")
});
const mlSourceSchema = z.object({
  url: z.string().min(1)
});
const mlSourcesBatchSchema = z.object({
  urls: z.union([z.array(z.string()), z.string()]).optional(),
  text: z.string().optional()
}).refine((data) => data.urls || data.text, {
  message: "urls or text is required"
});
const mlWebsiteSchema = z.object({
  url: z.string().min(1),
  maxPages: z.number().int().min(1).max(100).optional(),
  maxDepth: z.number().int().min(0).max(5).optional()
});
const mlWebsitesBatchSchema = z.object({
  urls: z.union([z.array(z.string()), z.string()]).optional(),
  text: z.string().optional(),
  maxPages: z.number().int().min(1).max(100).optional(),
  maxDepth: z.number().int().min(0).max(5).optional()
}).refine((data) => data.urls || data.text, {
  message: "urls or text is required"
});
const mlSnippetSchema = z.object({
  title: z.string().optional().default("Pasted Code Skill"),
  language: z.string().optional().default("JavaScript"),
  content: z.string().min(1)
});
const mlPatchSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional()
});
const mlSourcesDeleteSchema = z.object({
  scope: z.enum(["all", "active", "archived"]).optional().default("all")
});
const mlSkillPatchSchema = z.object({
  enabled: z.boolean().optional()
});
const mlQuerySchema = z.object({
  prompt: z.string().min(1),
  deep: z.boolean().optional().default(false)
});

function parseIntParam(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label} must be a positive integer`);
  return n;
}

function parsePerformanceRunType(value) {
  const type = String(value || "").trim();
  if (!type) return "";
  if (["code_prompt", "analyzer_summary"].includes(type)) return type;
  throw new ValidationError("type must be code_prompt or analyzer_summary");
}

function normalizeError(error) {
  if (error?.statusCode) {
    const exposed = error.expose ?? error.statusCode < 500;
    return {
      statusCode: error.statusCode,
      code: error.code || "INTERNAL_ERROR",
      message: exposed ? error.message : "Internal server error",
      details: exposed ? error.details || null : null
    };
  }
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Internal server error",
    details: null
  };
}

function importedProjectPayload(rootPath) {
  const parts = rootPath.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || "Imported Codebase";
  return {
    name,
    goals: `Imported existing codebase from ${rootPath}. Run KiraAI Analyzer to generate summary, project metadata, improvements, and learning data.`,
    techStack: "Pending analyzer run",
    timeline: "Existing codebase - ongoing",
    budget: "N/A",
    rootPath
  };
}

function appOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function inviteLink(req, token) {
  return `${appOrigin(req)}/invite/${encodeURIComponent(token)}`;
}

async function routeGuard(res, fn) {
  try {
    return await fn();
  } catch (error) {
    const e = normalizeError(error);
    return fail(res, e.message, e.statusCode, e.code, e.details);
  }
}

export const router = express.Router();

router.get("/health", (_req, res) => ok(res, { ok: true }));

router.get("/code-reference-repos", (_req, res) => ok(res, listReferenceRepos()));

router.get("/admin/users", async (req, res) =>
  routeGuard(res, async () => ok(res, await listUsersForAdmin(req.auth?.user)))
);

router.post("/admin/users", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = adminCreateUserSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid user payload", parsed.error.flatten());
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await createUserForAdmin(req.auth?.user, {
      email: parsed.data.email,
      passwordHash,
      displayName: parsed.data.displayName,
      role: parsed.data.role
    });
    return ok(res, user, null, 201);
  })
);

router.get("/ml/status", (_req, res) =>
  routeGuard(res, async () => ok(res, await getMlStatus()))
);

router.get("/ml/sources", (_req, res) =>
  routeGuard(res, async () => ok(res, await listSources({ includeArchived: _req.query.includeArchived === "true" })))
);

router.post("/ml/sources", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlSourceSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML source payload", parsed.error.flatten());
    return ok(res, await createSource(parsed.data.url, { autoLearn: true }), null, 201);
  })
);

router.post("/ml/sources/batch", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlSourcesBatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML sources batch payload", parsed.error.flatten());
    return ok(res, await createSourcesBatch(parsed.data.urls || parsed.data.text, { autoLearn: true }), null, 201);
  })
);

router.post("/ml/websites", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlWebsiteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML website payload", parsed.error.flatten());
    return ok(res, await createWebsiteSource(parsed.data.url, {
      autoLearn: true,
      maxPages: parsed.data.maxPages,
      maxDepth: parsed.data.maxDepth
    }), null, 201);
  })
);

router.post("/ml/websites/batch", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlWebsitesBatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML websites batch payload", parsed.error.flatten());
    return ok(res, await createWebsitesBatch(parsed.data.urls || parsed.data.text, {
      autoLearn: true,
      maxPages: parsed.data.maxPages,
      maxDepth: parsed.data.maxDepth
    }), null, 201);
  })
);

router.post("/ml/snippets/learn", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlSnippetSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML snippet payload", parsed.error.flatten());
    return ok(res, await learnSnippet(parsed.data), null, 201);
  })
);

router.patch("/ml/sources/:id", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = mlPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML source patch", parsed.error.flatten());
    return ok(res, await updateSource(id, parsed.data));
  })
);

router.delete("/ml/sources", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlSourcesDeleteSchema.safeParse(req.body || {});
    if (!parsed.success) throw new ValidationError("Invalid ML source delete payload", parsed.error.flatten());
    return ok(res, await deleteSourcesBulk(parsed.data));
  })
);

router.delete("/ml/sources/:id", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await deleteSource(id));
  })
);

router.post("/ml/sources/:id/learn", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await startLearningJob(id), null, 201);
  })
);

router.get("/ml/jobs", (req, res) =>
  routeGuard(res, async () => {
    const limit = Number(req.query.limit || 30);
    const offset = Number(req.query.offset || 0);
    const includeFinished = req.query.includeFinished === "true";
    return ok(res, await listLearningJobs(limit, offset, { includeFinished }), { limit, offset, includeFinished });
  })
);

router.get("/ml/jobs/:id", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await getLearningJob(id));
  })
);

router.get("/ml/jobs/:id/events", (req, res) => registerMlJobEvents(req, res));

router.post("/ml/jobs/:id/cancel", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await cancelLearningJob(id));
  })
);

router.get("/ml/skills", (req, res) =>
  routeGuard(res, async () => {
    const limit = Number(req.query.limit || 100);
    const offset = Number(req.query.offset || 0);
    const enabled = req.query.enabled ?? "";
    return ok(res, await listSkills({ limit, offset, enabled }), { limit, offset });
  })
);

router.get("/ml/skills/:id", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await getSkill(id));
  })
);

router.patch("/ml/skills/:id", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = mlSkillPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML skill patch", parsed.error.flatten());
    return ok(res, await updateSkill(id, parsed.data));
  })
);

router.delete("/ml/skills/:id", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await deleteSkill(id));
  })
);

router.post("/ml/query", (req, res) =>
  routeGuard(res, async () => {
    const parsed = mlQuerySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid ML query payload", parsed.error.flatten());
    return ok(res, await debugMindQuery(parsed.data.prompt, { deep: parsed.data.deep }));
  })
);

router.post("/projects", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = projectSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid project payload", parsed.error.flatten());

    const project = await createProjectRecordForUser(req.auth?.user, parsed.data);
    return ok(res, project, null, 201);
  })
);

router.get("/projects", async (req, res) =>
  routeGuard(res, async () => {
    return ok(res, await listProjectsForUser(req.auth?.user));
  })
);

router.post("/projects/import", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = importProjectSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid import payload", parsed.error.flatten());
    const safeRootPath = await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: false });
    const payload = importedProjectPayload(safeRootPath);
    const existing = await query("SELECT * FROM projects WHERE root_path=$1 LIMIT 1", [safeRootPath]);

    if (existing.rowCount) {
      await getProjectForUser(existing.rows[0].id, req.auth?.user, { roles: ["owner"] });
      const updated = await query(
        `UPDATE projects
         SET name=$1, goals=$2, tech_stack=$3, timeline=$4, budget=$5, root_path=$6,
             owner_user_id=COALESCE(owner_user_id, $8),
             created_by_user_id=COALESCE(created_by_user_id, $8),
             updated_at=NOW()
         WHERE id=$7
         RETURNING *`,
        [payload.name, payload.goals, payload.techStack, payload.timeline, payload.budget, safeRootPath, existing.rows[0].id, req.auth?.user?.id || null]
      );
      await redis.del(`project:${existing.rows[0].id}`).catch(() => null);
      return ok(res, { project: updated.rows[0], created: false, updated: true });
    }

    const created = await query(
      `INSERT INTO projects (name, goals, tech_stack, timeline, budget, root_path, owner_user_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       RETURNING *`,
      [payload.name, payload.goals, payload.techStack, payload.timeline, payload.budget, safeRootPath, req.auth?.user?.id || null]
    );
    await ensureProjectMembership(created.rows[0].id, req.auth?.user?.id, "owner");
    return ok(res, { project: created.rows[0], created: true, updated: false }, null, 201);
  })
);

router.post("/projects/create-folder", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = createProjectFolderSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid project folder payload", parsed.error.flatten());

    const result = await createWorkspaceProjectForUser(req.auth?.user, parsed.data);
    return ok(res, result, null, 201);
  })
);

router.get("/projects/:id", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const project = await getProjectForUser(id, req.auth?.user);

    const plans = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC",
      [id]
    );
    const payload = { ...project, plans: plans.rows };
    return ok(res, payload, { source: "db" });
  })
);

router.get("/projects/:id/performance-runs", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const type = parsePerformanceRunType(req.query.type);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const project = await getProjectForUser(id, req.auth?.user);
    const rootPath = project.root_path || "";

    const rows = await query(
      `SELECT *
       FROM (
         SELECT
           'code_prompt' AS run_type,
           c.id,
           c.project_id,
           c.root_path,
           c.status,
           c.model,
           c.user_prompt AS title,
           COALESCE(c.diff_summary, '') AS description,
           c.started_at,
           c.finished_at,
           c.duration_ms,
           c.stage_timings,
           c.created_at
         FROM code_jobs c
         WHERE c.project_id=$1 OR ($2 <> '' AND c.root_path=$2)
         UNION ALL
         SELECT
           'analyzer_summary' AS run_type,
           s.id,
           s.project_id,
           s.root_path,
           'done' AS status,
           s.model,
           s.title,
           s.description,
           s.started_at,
           s.finished_at,
           s.duration_ms,
           s.stage_timings,
           s.created_at
         FROM codebase_summaries s
         WHERE s.project_id=$1 OR ($2 <> '' AND s.root_path=$2)
       ) runs
       WHERE ($3 = '' OR run_type=$3)
       ORDER BY created_at DESC
       LIMIT $4`,
      [id, rootPath, type, limit]
    );
    return ok(res, rows.rows, { projectId: id, type, limit });
  })
);

router.get("/projects/:id/code-jobs", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = codeJobHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid code job history query", parsed.error.flatten());
    await getProjectForUser(id, req.auth?.user);
    const items = await listProjectCodeJobs(id, parsed.data);
    return ok(res, items, { projectId: id, ...parsed.data });
  })
);

router.post("/projects/:id/code-structure-jobs", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = codeStructureJobSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid code structure job payload", parsed.error.flatten());
    await getProjectForUser(id, req.auth?.user);
    return ok(res, await startStructureCodeJob({ projectId: id, ...parsed.data }), null, 201);
  })
);

router.put("/projects/:id", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = projectSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid project payload", parsed.error.flatten());

    const result = await updateProjectForUser(id, req.auth?.user, parsed.data);
    await redis.del(`project:${id}`).catch(() => null);
    return ok(res, result);
  })
);

router.delete("/projects/:id", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const deleted = await deleteProjectForUser(id, req.auth?.user);
    await redis.del(`project:${id}`).catch(() => null);
    return ok(res, deleted);
  })
);

router.post("/projects/:id/invites", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid invite payload", parsed.error.flatten());
    const invite = await createProjectInvite(id, parsed.data.email, req.auth?.user);
    return ok(res, {
      id: invite.id,
      projectId: invite.project_id,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expires_at,
      project: invite.project || null,
      inviteLink: inviteLink(req, invite.token)
    }, null, 201);
  })
);

router.get("/projects/:id/members", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    return ok(res, await listProjectMembersAndInvites(id, req.auth?.user));
  })
);

router.delete("/projects/:id/members/:userId", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const userId = parseIntParam(req.params.userId, "userId");
    return ok(res, await removeProjectMember(id, userId, req.auth?.user));
  })
);

router.post("/projects/:id/invites/:inviteId/revoke", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const inviteId = parseIntParam(req.params.inviteId, "inviteId");
    return ok(res, await revokeProjectInvite(id, inviteId, req.auth?.user));
  })
);

router.get("/invites/:token", async (req, res) =>
  routeGuard(res, async () => {
    const invite = await getInviteByToken(req.params.token);
    return ok(res, {
      id: invite.id,
      projectId: invite.project_id,
      projectName: invite.project_name,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expires_at,
      expired: Boolean(invite.expired)
    });
  })
);

router.post("/invites/:token/accept", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = inviteAcceptSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid invite accept payload", parsed.error.flatten());
    const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : "";
    const result = await acceptInviteToken(req.params.token, {
      currentUser: req.auth?.authenticated ? req.auth.user : null,
      passwordHash,
      displayName: parsed.data.displayName
    });
    await createSessionForUser(req, res, result.user);
    return ok(res, {
      user: publicUser(result.user),
      project: result.project,
      membership: result.membership
    });
  })
);

router.get("/projects/:id/analysis-summaries", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const limit = Number(req.query.limit || 40);
    const offset = Number(req.query.offset || 0);
    const project = await getProjectForUser(id, req.auth?.user);
    const items = await listProjectCodebaseSummaries(project, limit, offset);
    return ok(res, items, { limit, offset, projectId: id });
  })
);

router.post("/projects/:id/generate-plan", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const project = await getProjectForUser(id, req.auth?.user);

    const latest = await query(
      "SELECT COALESCE(MAX(version), 0) AS version FROM project_plans WHERE project_id=$1",
      [id]
    );
    const nextVersion = Number(latest.rows[0].version) + 1;

    const provider = providerSchema.safeParse(req.body?.provider);
    const selectedProvider = provider.success ? provider.data : undefined;
    const planJson = await generatePlan(project, selectedProvider);
    const insert = await query(
      `INSERT INTO project_plans (project_id, version, plan_json, status, provider)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [id, nextVersion, planJson, "pending", selectedProvider || null]
    );
    await redis.del(`project:${id}`).catch(() => null);
    return ok(res, insert.rows[0], null, 201);
  })
);

router.get("/projects/:id/plans", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    await getProjectForUser(id, req.auth?.user);
    const limit = Number(req.query.limit || 20);
    const offset = Number(req.query.offset || 0);
    const status = String(req.query.status || "").trim();
    const provider = String(req.query.provider || "").trim();
    const createdAfter = String(req.query.createdAfter || "").trim();

    const clauses = ["project_id=$1"];
    const params = [id];
    if (status) {
      params.push(status);
      clauses.push(`status=$${params.length}`);
    }
    if (provider) {
      params.push(provider);
      clauses.push(`provider=$${params.length}`);
    }
    if (createdAfter) {
      params.push(createdAfter);
      clauses.push(`created_at >= $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const sql = `SELECT * FROM project_plans WHERE ${clauses.join(" AND ")} ORDER BY version DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const rows = await query(sql, params);
    return ok(res, rows.rows, { limit, offset });
  })
);

router.get("/projects/:id/plans/compare", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    await getProjectForUser(id, req.auth?.user);
    const againstVersion = Number(req.query.againstVersion || 0);
    if (!againstVersion) throw new ValidationError("againstVersion query parameter is required");

    const latestResult = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC LIMIT 1",
      [id]
    );
    if (!latestResult.rowCount) throw new NotFoundError("No plans found");

    const oldResult = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 AND version=$2 LIMIT 1",
      [id, againstVersion]
    );
    if (!oldResult.rowCount) throw new NotFoundError("Compared version not found");

    const latest = latestResult.rows[0];
    const prior = oldResult.rows[0];

    const latestMilestones = latest.plan_json?.milestones || [];
    const priorMilestones = prior.plan_json?.milestones || [];
    const latestTasks = (latest.plan_json?.taskBreakdown || []).map((t) => t.task);
    const priorTasks = (prior.plan_json?.taskBreakdown || []).map((t) => t.task);

    const data = {
      latestVersion: latest.version,
      comparedVersion: prior.version,
      summaryChanged: latest.plan_json?.summary !== prior.plan_json?.summary,
      addedTasks: latestTasks.filter((t) => !priorTasks.includes(t)),
      removedTasks: priorTasks.filter((t) => !latestTasks.includes(t)),
      milestoneCountDelta: latestMilestones.length - priorMilestones.length,
      latestSummary: latest.plan_json?.summary || "",
      comparedSummary: prior.plan_json?.summary || ""
    };

    return ok(res, data);
  })
);

router.post("/plans/:planId/promote-baseline", async (req, res) =>
  routeGuard(res, async () => {
    const planId = parseIntParam(req.params.planId, "planId");
    await getProjectByPlanForUser(planId, req.auth?.user);
    const planResult = await query("SELECT * FROM project_plans WHERE id=$1", [planId]);
    if (!planResult.rowCount) throw new NotFoundError("Plan not found");
    const plan = planResult.rows[0];

    await query("UPDATE project_plans SET is_baseline=FALSE WHERE project_id=$1", [plan.project_id]);
    const updated = await query(
      "UPDATE project_plans SET is_baseline=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *",
      [planId]
    );
    await redis.del(`project:${plan.project_id}`).catch(() => null);
    return ok(res, updated.rows[0]);
  })
);

router.post("/plans/:planId/feedback", async (req, res) =>
  routeGuard(res, async () => {
    const planId = parseIntParam(req.params.planId, "planId");
    await getProjectByPlanForUser(planId, req.auth?.user);
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid feedback payload", parsed.error.flatten());

    const { action, comments, modifiedPlan } = parsed.data;
    const planResult = await query("SELECT * FROM project_plans WHERE id=$1", [planId]);
    if (!planResult.rowCount) throw new NotFoundError("Plan not found");
    const currentPlan = planResult.rows[0];

    let updatedPlan = currentPlan.plan_json;
    let status = currentPlan.status;

    if (action === "accept") {
      status = "accepted";
    } else if (action === "reject") {
      status = "rejected";
    } else if (action === "needs_review") {
      status = "needs_review";
    } else if (action === "modify") {
      updatedPlan = modifiedPlan || currentPlan.plan_json;
      status = "modified";
    }

    const updated = await query(
      `UPDATE project_plans
       SET status=$1, plan_json=$2, updated_at=NOW()
       WHERE id=$3
       RETURNING *`,
      [status, updatedPlan, planId]
    );

    await query(
      `INSERT INTO plan_feedback (plan_id, action, comments, modified_plan_json)
       VALUES ($1,$2,$3,$4)`,
      [planId, action, comments, action === "modify" ? updatedPlan : null]
    );

    await redis.del(`project:${currentPlan.project_id}`).catch(() => null);
    return ok(res, updated.rows[0]);
  })
);

router.post("/projects/:id/generate-structure", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const parsed = structureSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid structure options", parsed.error.flatten());

    const project = await getProjectForUser(id, req.auth?.user);
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: true });

    const planResult = await query(
      "SELECT * FROM project_plans WHERE project_id=$1 ORDER BY version DESC LIMIT 1",
      [id]
    );
    if (!planResult.rowCount) {
      throw new ValidationError("No generated plan found for this project");
    }

    const activePlan = planResult.rows[0];
    const result = await generateProjectStructure({
      targetPath: parsed.data.targetPath,
      project,
      plan: activePlan.plan_json,
      profile: parsed.data.profile,
      dryRun: parsed.data.dryRun,
      overwriteStrategy: parsed.data.overwriteStrategy,
      structurePrompt: parsed.data.structurePrompt,
      planVersion: activePlan.version
    });
    return ok(res, result);
  })
);

router.post("/fs/list-directories", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = pathSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid path payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    const data = await listDirectories(parsed.data.targetPath);
    return ok(res, data);
  })
);

router.get("/fs/events", (req, res) =>
  routeGuard(res, async () => {
    const root = String(req.query.root || "").trim() || config.fsBasePath;
    await assertUserPathAccess(req.auth?.user, root);
    return registerFsEventStream(req, res);
  })
);

router.post("/fs/list", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsListSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs list payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    return ok(res, await fsList(parsed.data));
  })
);

router.post("/fs/tree", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsTreeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs tree payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    return ok(res, await fsTree(parsed.data));
  })
);

router.post("/fs/stat", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = pathSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs stat payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    return ok(res, await fsStat(parsed.data));
  })
);

router.post("/fs/mkdir", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = pathSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs mkdir payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: true });
    return ok(res, await fsMkdir(parsed.data));
  })
);

router.post("/fs/create-file", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsCreateFileSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs create-file payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: true });
    return ok(res, await fsCreateFile(parsed.data));
  })
);

router.post("/fs/rename", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsRenameSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs rename payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.sourcePath, { write: true });
    return ok(res, await fsRename(parsed.data));
  })
);

router.post("/fs/move", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsMoveCopySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs move payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.sourcePath, { write: true });
    await assertUserPathAccess(req.auth?.user, parsed.data.destinationPath, { write: true });
    return ok(res, await fsMove(parsed.data));
  })
);

router.post("/fs/copy", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsMoveCopySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs copy payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.sourcePath);
    await assertUserPathAccess(req.auth?.user, parsed.data.destinationPath, { write: true });
    return ok(res, await fsCopy(parsed.data));
  })
);

router.post("/fs/delete", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = pathSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs delete payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: true });
    return ok(res, await fsDelete(parsed.data));
  })
);

router.post("/fs/batch", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsBatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs batch payload", parsed.error.flatten());
    for (const op of parsed.data.operations || []) {
      if (op.type === "delete") await assertUserPathAccess(req.auth?.user, op.targetPath, { write: true });
      if (op.type === "copy") {
        await assertUserPathAccess(req.auth?.user, op.sourcePath);
        await assertUserPathAccess(req.auth?.user, op.destinationPath, { write: true });
      }
      if (op.type === "move") {
        await assertUserPathAccess(req.auth?.user, op.sourcePath, { write: true });
        await assertUserPathAccess(req.auth?.user, op.destinationPath, { write: true });
      }
      if (op.type === "rename") await assertUserPathAccess(req.auth?.user, op.sourcePath, { write: true });
      if (op.type === "mkdir" || op.type === "create-file") await assertUserPathAccess(req.auth?.user, op.targetPath, { write: true });
    }
    return ok(res, await fsBatch(parsed.data));
  })
);

router.post("/fs/read-file", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = pathSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid path payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    const data = await readTextFile(parsed.data.targetPath);
    return ok(res, data);
  })
);

router.post("/fs/write-file", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = writeFileSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid write payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: true });
    const data = await writeTextFile(parsed.data.targetPath, parsed.data.content);
    return ok(res, data);
  })
);

router.post("/analysis/summarize-codebase", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = summarizeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid summarize payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    const data = await summarizeCodebaseWithCodex(parsed.data.targetPath);
    const saved = await saveCodebaseSummary(data);
    return ok(res, { ...data, summaryId: saved.id, analysisVersion: saved.analysisVersion, projectId: saved.projectId });
  })
);

router.post("/fs/read", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = pathSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs read payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    return ok(res, await fsReadFile(parsed.data));
  })
);

router.post("/fs/write", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = fsWriteSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid fs write payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath, { write: true });
    return ok(res, await fsWriteFile(parsed.data));
  })
);

router.post("/analysis/summarize-codebase/start", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = summarizeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid summarize payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    const job = startCodebaseSummaryJob(parsed.data.targetPath);
    return ok(res, {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message
    });
  })
);

router.get("/analysis/summarize-codebase/jobs/:jobId", async (req, res) =>
  routeGuard(res, async () => {
    const jobId = String(req.params.jobId || "").trim();
    if (!jobId) throw new ValidationError("jobId is required");
    const job = getCodebaseSummaryJob(jobId);
    if (!job) throw new NotFoundError("Analysis job not found");
    if (job.projectId) await getProjectForUser(job.projectId, req.auth?.user);
    else if (job.targetPath) await assertUserPathAccess(req.auth?.user, job.targetPath);
    return ok(res, job);
  })
);

router.post("/projects/:id/analyze-codebase/start", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const project = await getProjectForUser(id, req.auth?.user);
    if (!project.root_path?.trim()) throw new ValidationError("Project does not have a root path. Import a folder first.");
    await assertUserPathAccess(req.auth?.user, project.root_path);
    await redis.del(`project:${id}`).catch(() => null);
    const job = startCodebaseSummaryJob(project.root_path, { projectId: project.id });
    return ok(res, {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      projectId: project.id
    });
  })
);

router.get("/analysis/summaries", async (req, res) =>
  routeGuard(res, async () => {
    const limit = Number(req.query.limit || 20);
    const offset = Number(req.query.offset || 0);
    const items = await listCodebaseSummaries(limit, offset);
    const filtered = [];
    for (const item of items) {
      try {
        if (item.project_id) await getProjectForUser(item.project_id, req.auth?.user);
        else await assertUserPathAccess(req.auth?.user, item.root_path);
        filtered.push(item);
      } catch {
        // Hide summaries outside the current user's projects.
      }
    }
    return ok(res, filtered, { limit, offset });
  })
);

router.get("/analysis/summaries/:id", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const item = await getCodebaseSummaryById(id);
    if (!item) throw new NotFoundError("Summary not found");
    if (item.project_id) await getProjectForUser(item.project_id, req.auth?.user);
    else await assertUserPathAccess(req.auth?.user, item.root_path);
    return ok(res, item);
  })
);

router.post("/analysis/summaries/:id/add-as-project", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const summary = await getCodebaseSummaryById(id);
    if (!summary) throw new NotFoundError("Summary not found");
    if (summary.project_id) await getProjectForUser(summary.project_id, req.auth?.user);
    else await assertUserPathAccess(req.auth?.user, summary.root_path);
    const result = await addSummaryAsProject(id);
    if (!result) throw new NotFoundError("Summary not found");
    await ensureProjectMembership(result.project.id, req.auth?.user?.id, "owner");
    await redis.del(`project:${result.project.id}`).catch(() => null);
    return ok(res, result);
  })
);

router.post("/code-jobs", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = codeJobSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid code job payload", parsed.error.flatten());
    if (parsed.data.projectId) {
      await getProjectForUser(parsed.data.projectId, req.auth?.user);
    } else {
      await assertUserPathAccess(req.auth?.user, parsed.data.rootPath);
    }
    return ok(res, await startCodeJob({
      ...parsed.data,
      requestMetadata: {
        startedByUserId: req.auth?.user?.id || null
      }
    }), null, 201);
  })
);

router.get("/code-jobs", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = codeJobHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid code job history query", parsed.error.flatten());
    const { limit, offset, status, type } = parsed.data;
    return ok(res, await listCodeJobs(limit, offset, { status, type, userId: req.auth?.user?.id || null }), { limit, offset, status, type });
  })
);

router.get("/code-jobs/:id/assets/:assetId", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    const assetId = parseIntParam(req.params.assetId, "assetId");
    await assertCodeJobAccess(id, req.auth?.user);
    const asset = await getCodeJobAsset(id, assetId);
    const filename = String(asset.filename || "kiraai-asset").replace(/["\r\n]/g, "");
    res.setHeader("Content-Type", asset.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(asset.content);
  })
);

router.get("/code-jobs/:id", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    await assertCodeJobAccess(id, req.auth?.user);
    return ok(res, await getCodeJob(id));
  })
);

router.get("/code-jobs/:id/events", (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    await assertCodeJobAccess(id, req.auth?.user);
    return registerCodeJobEvents(req, res);
  })
);

router.post("/code-jobs/:id/apply", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    await assertCodeJobAccess(id, req.auth?.user);
    return ok(res, await applyCodeJob(id));
  })
);

router.post("/code-jobs/:id/reject", async (req, res) =>
  routeGuard(res, async () => {
    const id = parseIntParam(req.params.id, "id");
    await assertCodeJobAccess(id, req.auth?.user);
    return ok(res, await rejectCodeJob(id));
  })
);

router.get("/analysis/learning-profile", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = rootQuerySchema.safeParse(req.query);
    if (!parsed.success || !parsed.data.rootPath) throw new ValidationError("rootPath query parameter is required");
    await assertUserPathAccess(req.auth?.user, parsed.data.rootPath);
    return ok(res, await getLearningProfile(parsed.data.rootPath));
  })
);

router.get("/analysis/improvements", async (req, res) =>
  routeGuard(res, async () => {
    const rootPath = String(req.query.rootPath || "").trim();
    const limit = Number(req.query.limit || 100);
    const offset = Number(req.query.offset || 0);
    if (rootPath) await assertUserPathAccess(req.auth?.user, rootPath);
    return ok(res, await listImprovementSuggestions(rootPath, limit, offset), { limit, offset });
  })
);

router.post("/analysis/check-improvements", async (req, res) =>
  routeGuard(res, async () => {
    const parsed = summarizeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Invalid improvement check payload", parsed.error.flatten());
    await assertUserPathAccess(req.auth?.user, parsed.data.targetPath);
    const data = await summarizeCodebaseWithCodex(parsed.data.targetPath);
    const saved = await saveCodebaseSummary(data);
    return ok(res, { ...data, summaryId: saved.id, analysisVersion: saved.analysisVersion, projectId: saved.projectId, improvementChecks: saved.improvementChecks || [] });
  })
);
