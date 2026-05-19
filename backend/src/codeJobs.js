import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "./db.js";
import { config } from "./config.js";
import { AppError, ExternalServiceError, NotFoundError, RateLimitError, ValidationError } from "./errors.js";
import { getLearningProfile } from "./analysisStore.js";
import { buildMindContextForPrompt } from "./mlMind.js";
import { resolveCodexBinary } from "./codexBinary.js";
import { resolveClaudeBinary } from "./claudeBinary.js";
import { fsDelete, fsWriteFile, resolveExistingSafePath, resolveSafePath } from "./structure.js";
import { createRunTimer, finishTimingSnapshot } from "./performanceTiming.js";
import { generateImageAsset, normalizeSvgAssetContent, resolveImageProvider, shouldGenerateImage } from "./imageGeneration.js";

const eventClients = new Map();
const RUNNER_ID = `code-${process.pid}-${randomUUID()}`;
const MAX_CHANGED_FILES = 80;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_LCS_CELLS = 1_000_000;
const MAX_DIFF_RENDER_LINES = 4000;
const DIFF_CONTEXT_LINES = 3;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

function nowLog(message, data = {}) {
  return { ts: new Date().toISOString(), message, data };
}

function emit(jobId, event) {
  const clients = eventClients.get(String(jobId)) || new Set();
  for (const res of clients) {
    res.write(`event: code-job\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

async function appendLog(jobId, message, data = {}) {
  const entry = nowLog(message, data);
  const row = await query(
    `UPDATE code_jobs
     SET logs = logs || $2::jsonb,
         last_heartbeat_at=CASE WHEN status IN ('queued','planning','running') THEN NOW() ELSE last_heartbeat_at END,
         updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [jobId, JSON.stringify([entry])]
  );
  emit(jobId, { type: "log", job: row.rows[0], entry });
  return row.rows[0];
}

function publicAsset(row = {}) {
  return {
    id: row.id,
    code_job_id: row.code_job_id,
    asset_type: row.asset_type,
    mime_type: row.mime_type,
    filename: row.filename,
    metadata_json: row.metadata_json || {},
    created_at: row.created_at
  };
}

async function listCodeJobAssets(jobId) {
  const rows = await query(
    `SELECT id, code_job_id, asset_type, mime_type, filename, metadata_json, created_at
     FROM code_job_assets
     WHERE code_job_id=$1
     ORDER BY created_at ASC, id ASC`,
    [jobId]
  );
  return rows.rows.map(publicAsset);
}

async function saveCodeJobAsset(jobId, asset) {
  const row = await query(
    `INSERT INTO code_job_assets (code_job_id, asset_type, mime_type, filename, content, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id, code_job_id, asset_type, mime_type, filename, metadata_json, created_at`,
    [
      jobId,
      asset.assetType || "image",
      asset.mimeType,
      asset.filename,
      asset.content,
      JSON.stringify(asset.metadata || {})
    ]
  );
  return publicAsset(row.rows[0]);
}

async function setStatus(jobId, status, patch = {}) {
  const row = await query(
    `UPDATE code_jobs
     SET status=$2,
         improved_prompt=COALESCE($3, improved_prompt),
         changed_files=COALESCE($4, changed_files),
         diff_summary=COALESCE($5, diff_summary),
         risk_notes=COALESCE($6, risk_notes),
         test_commands=COALESCE($7, test_commands),
         final_status=COALESCE($8, final_status),
         runner_id=CASE WHEN $2 IN ('queued','planning','running') THEN COALESCE(runner_id, $9) ELSE NULL END,
         last_heartbeat_at=CASE WHEN $2 IN ('queued','planning','running') THEN NOW() ELSE last_heartbeat_at END,
         started_at=COALESCE($10, started_at),
         finished_at=COALESCE($11, finished_at),
         duration_ms=COALESCE($12, duration_ms),
         stage_timings=COALESCE($13::jsonb, stage_timings),
         response_markdown=COALESCE($14, response_markdown),
         response_kind=COALESCE($15, response_kind),
         response_metadata=COALESCE($16::jsonb, response_metadata),
         updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [
      jobId,
      status,
      patch.improvedPrompt ?? null,
      patch.changedFiles ? JSON.stringify(patch.changedFiles) : null,
      patch.diffSummary ?? null,
      patch.riskNotes ? JSON.stringify(patch.riskNotes) : null,
      patch.testCommands ? JSON.stringify(patch.testCommands) : null,
      patch.finalStatus ?? null,
      RUNNER_ID,
      patch.startedAt ?? null,
      patch.finishedAt ?? null,
      patch.durationMs ?? null,
      patch.stageTimings ? JSON.stringify(patch.stageTimings) : null,
      patch.responseMarkdown ?? null,
      patch.responseKind ?? null,
      patch.responseMetadata ? JSON.stringify(patch.responseMetadata) : null
    ]
  );
  emit(jobId, { type: "status", job: row.rows[0] });
  return row.rows[0];
}

function maxCodeResumeAttempts() {
  return Math.max(0, Number(config.codeJobMaxResumeAttempts || 0));
}

async function claimCodeJobForRun(jobId, { resumed = false, reason = "" } = {}) {
  const row = await query(
    `UPDATE code_jobs
     SET runner_id=$2,
         started_at=COALESCE(started_at, NOW()),
         last_heartbeat_at=NOW(),
         interrupted_at=CASE WHEN $3 THEN COALESCE(interrupted_at, NOW()) ELSE interrupted_at END,
         resume_count=CASE WHEN $3 THEN resume_count + 1 ELSE resume_count END,
         resume_reason=CASE WHEN $3 THEN $4 ELSE resume_reason END,
         final_status=CASE WHEN status='failed' THEN NULL ELSE final_status END,
         updated_at=NOW()
     WHERE id=$1
       AND status IN ('queued','planning','running')
       AND (runner_id IS NULL OR runner_id=$2 OR last_heartbeat_at IS NULL OR last_heartbeat_at < NOW() - ($5::text)::interval)
       AND (NOT $3 OR resume_count < $6)
     RETURNING *`,
    [
      jobId,
      RUNNER_ID,
      Boolean(resumed),
      reason || "server_restart",
      `${Math.max(1000, Number(config.jobResumeStaleMs || 30000))} milliseconds`,
      maxCodeResumeAttempts()
    ]
  );
  return row.rows[0] || null;
}

async function heartbeatCodeJob(jobId) {
  await query(
    `UPDATE code_jobs
     SET last_heartbeat_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND runner_id=$2 AND status IN ('queued','planning','running')`,
    [jobId, RUNNER_ID]
  ).catch(() => null);
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function timerFromCodeJob(job = {}) {
  const startedAt = isoDate(job.started_at) || new Date().toISOString();
  const startedMs = new Date(startedAt).getTime();
  const raw = job.stage_timings && typeof job.stage_timings === "object" ? job.stage_timings : {};
  return createRunTimer({
    startedAt,
    startMs: Number.isFinite(startedMs) ? startedMs : Date.now(),
    stages: raw.stages || {},
    currentStage: raw.currentStage || null
  });
}

async function saveCodeJobTiming(jobId, timer) {
  const row = await query(
    `UPDATE code_jobs
     SET stage_timings=$2::jsonb, updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [jobId, JSON.stringify(timer.snapshot())]
  );
  emit(jobId, { type: "status", job: row.rows[0] });
  return row.rows[0];
}

async function markCodeJobStage(jobId, timer, stage, metadata = {}) {
  timer.mark(stage, metadata);
  return saveCodeJobTiming(jobId, timer);
}

async function measureTimerStage(timer, stage, fn, metadata = {}) {
  const startedAt = new Date();
  try {
    return await fn();
  } finally {
    const finishedAt = new Date();
    timer.record(stage, {
      ...metadata,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime())
    });
  }
}

async function finishCodeJobTiming(jobId, status, metadata = {}) {
  const current = await query(
    `SELECT id, started_at, created_at, stage_timings
     FROM code_jobs
     WHERE id=$1
     LIMIT 1`,
    [jobId]
  );
  const job = current.rows[0];
  if (!job) return null;
  const finished = finishTimingSnapshot(
    job.stage_timings || {},
    isoDate(job.started_at) || isoDate(job.created_at) || new Date().toISOString(),
    status,
    metadata
  );
  const row = await query(
    `UPDATE code_jobs
     SET started_at=COALESCE(started_at, $2),
         finished_at=$3,
         duration_ms=$4,
         stage_timings=$5::jsonb,
         updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [jobId, finished.startedAt, finished.finishedAt, finished.durationMs, JSON.stringify(finished.stageTimings)]
  );
  emit(jobId, { type: "status", job: row.rows[0] });
  return row.rows[0];
}

function compactLearningProfile(profile = {}) {
  const style = profile.styleProfile || {};
  const prompt = profile.promptProfile || {};
  const improvements = Array.isArray(profile.improvements) ? profile.improvements : [];
  const events = Array.isArray(profile.learningEvents) ? profile.learningEvents : [];

  return {
    rootPath: "selected project root",
    styleObservations: (style.observations || prompt.preferredPatterns || []).slice(0, 8),
    architectureOverview: (style.architectureOverview || []).slice(0, 6),
    openImprovements: improvements
      .filter((item) => !item.status || item.status === "open")
      .slice(0, 10)
      .map((item) => ({
        file: item.file_path || item.file || "",
        function: item.function_name || item.function || "",
        priority: item.priority || "medium",
        issue: item.issue || "",
        suggestion: item.suggestion || ""
      })),
    recentLearningEvents: events.slice(0, 5).map((event) => ({
      type: event.event_type || event.type,
      createdAt: event.created_at || event.createdAt
    }))
  };
}

function buildImprovedPrompt({ userPrompt, learningProfile, mindContext = "" }) {
  const profile = compactLearningProfile(learningProfile);
  const styleHints = profile.styleObservations.length
    ? profile.styleObservations.map((item) => `- ${item}`).join("\n")
    : "- Follow the existing code style after inspecting the target files.";

  const sections = [
    "## Task",
    "",
    userPrompt.trim(),
    "",
    "## Rules",
    "- Preserve the original task and make the smallest complete change that satisfies it.",
    "- Inspect relevant files before editing.",
    "- Keep all unrelated files untouched.",
    "- Make complete, working changes and avoid stubs or TODOs.",
    "",
    "## Code style",
    styleHints
  ];

  if (mindContext) {
    sections.push("", mindContext);
  }

  return sections.join("\n");
}

function buildCodePrompt({ improvedPrompt, rootPath }) {
  return [
    "You are KiraAI, an AI code worker running in an isolated copy of a project.",
    "Execute EXACTLY the task described below - no extra refactoring or unrelated changes.",
    "Edit files directly in the workspace. Do not output JSON; the app diffs the workspace automatically.",
    "Do not ask for approval. Do not edit node_modules, dist, build, coverage, .git, .next, .cache, or reports.",
    "If you add or use a third-party package, update the correct package.json dependency entry. Prefer existing dependencies or built-in APIs when practical.",
    "If verification is blocked only by missing local dependencies, report that limitation and still finish the reviewable code proposal.",
    "When done, write a short plain-text summary of what changed and any commands to verify.",
    "",
    `Workspace: ${rootPath}`,
    "",
    improvedPrompt
  ].join("\n");
}

function ensureInsideProjectRoot(projectRoot, targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new ValidationError("Code job file path escapes the selected project root");
  }
}

async function resolveCodeJobRoot({ projectId, rootPath }) {
  if (projectId) {
    const row = await query("SELECT id, name, root_path FROM projects WHERE id=$1 LIMIT 1", [projectId]);
    if (!row.rowCount) throw new NotFoundError("Project not found");
    const project = row.rows[0];
    if (!project.root_path?.trim()) {
      throw new ValidationError("Selected project does not have a workspace root path");
    }
    return { projectId: project.id, projectName: project.name || "Selected project", safeRoot: await resolveExistingSafePath(project.root_path) };
  }

  if (!rootPath?.trim()) throw new ValidationError("rootPath is required when projectId is not provided");
  const safeRoot = await resolveExistingSafePath(rootPath);
  return { projectId: null, projectName: path.basename(safeRoot) || "Selected project", safeRoot };
}

function buildFullStackStructurePrompt({ projectName = "Selected project", instructions = "" } = {}) {
  const extra = String(instructions || "").trim();
  return [
    `Create a reviewable full-stack project structure for "${projectName}".`,
    "",
    "First inspect the existing workspace. If files or folders already exist, preserve them and only add missing structure.",
    "",
    "Create or update a coherent baseline with:",
    "- frontend/ using React and Vite with src/main.jsx, src/App.jsx, and a small CSS entry.",
    "- backend/ using Node.js and Express.",
    "- backend/src/routes/ with at least a health route and one example REST resource route.",
    "- backend/src/config.js for environment-driven configuration.",
    "- backend/src/db.js for database access setup.",
    "- backend/sql/schema.sql with practical SQL tables for the example resource.",
    "- .env.example with non-secret placeholders.",
    "- docker-compose.yml that can run the app and database locally.",
    "- README.md with concise install, run, and structure notes.",
    "",
    "Rules:",
    "- Keep this as a proposal in the isolated workspace; the app will show diffs for review.",
    "- Do not create secrets or real credentials.",
    "- Do not edit unrelated existing files unless needed to connect the structure.",
    "- Make API, routes, and database names consistent.",
    "- Prefer simple, readable JavaScript and SQL over heavy frameworks.",
    extra ? `\nAdditional user instructions:\n${extra}` : ""
  ].filter(Boolean).join("\n");
}

export function shouldUseStructureWorkflow(prompt = "") {
  const text = String(prompt || "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  const hasAction = /\b(create|make|build|generate|setup|set up|maak|bouw|genereer|zet|opzetten)\b/.test(text);
  const hasScaffoldIntent = /\b(full stack|fullstack|scaffold|scaffolding|setup full stack|setup project|starter project|boilerplate)\b/.test(text);
  const hasStructurePhrase = /\b(project structure|folder structure|project folder structure|app structure)\b/.test(text);
  const hasStackBreadth = /\bfrontend\b/.test(text) &&
    /\bbackend\b/.test(text) &&
    /\b(api|route|routes|database|db|sql|schema|docker|compose|env|readme)\b/.test(text);
  const hasReviewableBaseline = /\b(create|make|maak|build|generate|setup|zet|scaffold)\b/.test(text) &&
    /\b(frontend|react|vite)\b/.test(text) &&
    /\b(backend|express|api)\b/.test(text) &&
    /\b(database|db|sql|schema|docker|compose)\b/.test(text);
  return hasScaffoldIntent || (hasAction && hasStructurePhrase) || hasStackBreadth || hasReviewableBaseline;
}

export function detectCodeJobWorkflow({ prompt = "", responseMode = "auto", jobType = "prompt" } = {}) {
  const normalizedResponseMode = normalizeResponseMode(responseMode);
  if (normalizedResponseMode === "image") return "image";
  if (jobType === "structure" || shouldUseStructureWorkflow(prompt)) return "structure";
  if (shouldGenerateImage({ prompt, responseMode: normalizedResponseMode })) return "image";
  return "code";
}

function isNoisyCodexLogLine(lower) {
  return [
    "postgresql://",
    "database_url",
    "postgres",
    "psql",
    "pg_",
    "redis",
    "node_modules",
    "docker compose",
    "schema applied",
    "migration"
  ].some((needle) => lower.includes(needle));
}

function shouldKeepCodexLogLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (isNoisyCodexLogLine(lower)) return false;
  if (looksLikeCodeSnippet(text)) return false;
  if (text === "--------" || text === "user") return false;
  if (text === "{" || text === "}" || text === "}," || text === "]," || text === "],") return false;
  if (text.startsWith('"') || text.startsWith("- ")) return false;
  if (text.startsWith("{\"improvedPrompt\"")) return false;
  if (lower.includes("reading additional input from stdin")) return false;
  if (lower.includes("json schema")) return false;
  if (lower.includes("compact learning profile")) return false;
  if (lower.includes("you are an ai code worker")) return false;
  if (lower.includes("you are kiraai")) return false;
  if (lower.includes("return only valid json")) return false;
  if (lower.includes("root path:")) return false;
  if (lower.includes("user prompt:")) return false;
  if (lower === "rules:") return false;
  if (lower.includes("tokens used")) return false;
  if (text.length > 2200) return false;
  if (/^(npm|pnpm|yarn|npx|node|python|pytest|vitest|go|cargo)\b.*\b(test|build|lint|typecheck|check)\b/.test(lower)) return true;
  if (/^git (status|diff|show)\b/.test(lower)) return true;
  return (
    lower.startsWith("openai codex") ||
    lower.startsWith("workdir:") ||
    lower.startsWith("model:") ||
    lower.startsWith("provider:") ||
    lower.startsWith("sandbox:") ||
    lower.startsWith("approval:") ||
    lower.startsWith("exec") ||
    lower.startsWith("codex") ||
    isRealErrorLogLine(text) ||
    lower.includes("verification failed") ||
    lower.includes("succeeded")
  );
}

export function resolveCodeAgentProvider(value = config.codeAgentProvider) {
  const provider = String(value || "codex_cli").trim().toLowerCase();
  if (provider === "claude" || provider === "claude_code" || provider === "claude_cli") return "claude_cli";
  if (provider === "codex" || provider === "openai_codex" || provider === "codex_cli") return "codex_cli";
  return "codex_cli";
}

function codeAgentLabel(provider = resolveCodeAgentProvider()) {
  return provider === "claude_cli" ? "Claude Code" : "Codex";
}

function codeJobCliExitError(provider, code, stderr = "", stdout = "") {
  const compactStderr = stderr.trim();
  const compactStdout = stdout.trim();
  const lower = `${compactStderr}\n${compactStdout}`.toLowerCase();
  const label = codeAgentLabel(provider);
  if (
    lower.includes("cannot access session files") ||
    (lower.includes(".codex") && lower.includes("permission denied"))
  ) {
    return new ExternalServiceError(
      "KiraAI cannot access the Codex session directory. Restart the Docker app so startup permission repair can run, or fix CODEX_HOME_HOST ownership.",
      { stderr: compactStderr, stdout: compactStdout },
      "CODEX_HOME_PERMISSION_DENIED"
    );
  }
  if (provider === "claude_cli" && (lower.includes(".claude") || lower.includes("claude_config_dir")) && lower.includes("permission denied")) {
    return new ExternalServiceError(
      "KiraAI cannot access the Claude Code config directory. Restart the Docker app so startup permission repair can run, or fix CLAUDE_HOME_HOST ownership.",
      { stderr: compactStderr, stdout: compactStdout },
      "CLAUDE_HOME_PERMISSION_DENIED"
    );
  }
  if (provider === "claude_cli" && (lower.includes("login") || lower.includes("auth") || lower.includes("credentials"))) {
    return new ExternalServiceError(
      "Claude Code is not logged in inside the KiraAI container. Run the Claude login step again, then retry the job.",
      { stderr: compactStderr, stdout: compactStdout },
      "CLAUDE_LOGIN_REQUIRED"
    );
  }
  return new ExternalServiceError(
    `${label} code job failed (code ${code})`,
    { stderr: compactStderr, stdout: compactStdout },
    provider === "claude_cli" ? "CODE_JOB_CLAUDE_NON_ZERO" : "CODE_JOB_CODEX_NON_ZERO"
  );
}

function looksLikeCodeSnippet(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (/^[+-]\s*(const|let|var|if|return|throw|reader\.|set[A-Z]|[A-Za-z0-9_$]+\()/u.test(trimmed)) return true;
  if (/^[+-]\s*\{?error\s*&&/u.test(trimmed)) return true;
  if (/^(const|let|var)\s+\[?error\b/u.test(trimmed)) return true;
  if (/^(if|return|throw)\s*\(/u.test(trimmed)) return true;
  if (/^set[A-Z][A-Za-z0-9_$]*\(/u.test(trimmed)) return true;
  if (/^\{?error\s*&&/u.test(trimmed)) return true;
  if (/^\.error\s*\{/u.test(trimmed)) return true;
  if (/^["'`].*["'`][,;]?$/.test(trimmed) && trimmed.length < 180) return true;
  return false;
}

function isRealErrorLogLine(text) {
  const trimmed = String(text || "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return false;
  if (/^(error|fatal|failed|failure):\s/i.test(trimmed)) return true;
  if (/^#?\s*error\s+\[[A-Z0-9_]+\]/.test(trimmed)) return true;
  if (/\b(err_module_not_found|err_[a-z0-9_]+)\b/i.test(trimmed)) return true;
  if (/\b(cannot find module|cannot find package|module not found|package not found)\b/i.test(trimmed)) return true;
  if (/\b(test failed|build failed|verification failed|command failed|timed out|permission denied)\b/i.test(trimmed)) return true;
  if (lower.startsWith("npm err!") || lower.startsWith("pnpm err") || lower.startsWith("yarn error")) return true;
  return false;
}

function shouldCopyToIsolatedWorkspace(sourcePath) {
  const excludedNames = new Set([
    ".git",
    ".next",
    ".nuxt",
    ".turbo",
    ".vite",
    ".cache",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "reports",
    ".venv",
    "__pycache__"
  ]);
  return !sourcePath.split(path.sep).some((part) => excludedNames.has(part));
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

async function readPackageJson(packagePath) {
  try {
    return JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    return {};
  }
}

function packageJsonHasWorkspaces(packageJson = {}) {
  return Boolean(packageJson.workspaces) ||
    (Array.isArray(packageJson.packages) && packageJson.packages.length > 0);
}

async function findPackageInstallDirs(root, current = root, depth = 0, found = []) {
  if (found.length >= 8 || depth > 3) return found;
  let entries = [];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return found;
  }

  const hasPackageJson = entries.some((entry) => entry.isFile() && entry.name === "package.json");
  if (hasPackageJson) {
    found.push(current);
    const packageJson = await readPackageJson(path.join(current, "package.json"));
    if (current === root && packageJsonHasWorkspaces(packageJson)) return found;
  }

  const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache"]);
  for (const entry of entries) {
    if (found.length >= 8) break;
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    await findPackageInstallDirs(root, path.join(current, entry.name), depth + 1, found);
  }
  return found;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function runDependencyInstall(directory) {
  const hasLock = await pathExists(path.join(directory, "package-lock.json"));
  const commonArgs = ["--ignore-scripts", "--no-audit", "--no-fund"];
  if (!hasLock) return runPackageCommand(directory, ["install", ...commonArgs]);
  try {
    return await runPackageCommand(directory, ["ci", ...commonArgs]);
  } catch {
    return runPackageCommand(directory, ["install", ...commonArgs]);
  }
}

async function runPackageCommand(directory, args) {
  const command = npmCommand();
  const timeoutMs = Math.max(10000, Number(config.codeJobPrepareDepsTimeoutMs || 180000));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ExternalServiceError(`dependency install timed out after ${timeoutMs}ms`, null, "CODE_JOB_DEPENDENCY_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4000) stdout = stdout.slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ExternalServiceError(`dependency install failed with code ${code}`, { stdout, stderr }, "CODE_JOB_DEPENDENCY_FAILED"));
    });
  });
}

async function prepareIsolatedDependencies(jobId, workDir) {
  if (!config.codeJobPrepareDeps) return;
  const dirs = [...new Set(await findPackageInstallDirs(workDir))];
  if (!dirs.length) return;

  await appendLog(jobId, "Preparing workspace dependencies", { packageRoots: dirs.length });
  for (const directory of dirs) {
    const relativeDir = relativeWorkspacePath(workDir, directory) || ".";
    try {
      await runDependencyInstall(directory);
      await appendLog(jobId, "Workspace dependencies ready", { path: relativeDir });
    } catch (error) {
      await appendLog(jobId, "Dependency prep failed; verification may be limited", {
        path: relativeDir,
        error: error.message,
        code: error.code || "CODE_JOB_DEPENDENCY_PREP_FAILED"
      });
    }
  }
}

function relativeWorkspacePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isLikelyTextFile(relativePath, buffer) {
  const ext = path.extname(relativePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
  return !sample.includes("\uFFFD");
}

async function walkWorkspaceFiles(root, current = root) {
  let entries = [];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  const subdirPromises = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (!shouldCopyToIsolatedWorkspace(fullPath)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      subdirPromises.push(walkWorkspaceFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  const subdirResults = await Promise.all(subdirPromises);
  for (const subFiles of subdirResults) files.push(...subFiles);
  return files;
}

async function snapshotWorkspace(root, options = {}) {
  const includeContent = Boolean(options.includeContent);
  const files = await walkWorkspaceFiles(root);
  const snapshot = new Map();
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(
      files.slice(i, i + BATCH).map(async (filePath) => {
        const relativePath = relativeWorkspacePath(root, filePath);
        const buffer = await readFile(filePath);
        snapshot.set(relativePath, {
          path: relativePath,
          hash: hashBuffer(buffer),
          size: buffer.length,
          text: isLikelyTextFile(relativePath, buffer)
        });
        const item = snapshot.get(relativePath);
        if (includeContent && item.text && buffer.length <= MAX_PREVIEW_BYTES) {
          item.content = buffer.toString("utf8");
        }
      })
    );
  }
  return snapshot;
}

async function contentForChangedFile(filePath, relativePath) {
  const st = await stat(filePath);
  if (st.size > MAX_PREVIEW_BYTES) {
    return {
      content: "",
      skipped: true,
      reason: `File is larger than ${Math.round(MAX_PREVIEW_BYTES / 1024)}KB`
    };
  }

  const buffer = await readFile(filePath);
  if (!isLikelyTextFile(relativePath, buffer)) {
    return {
      content: "",
      skipped: true,
      reason: "Binary file changes are not supported by the review apply flow yet"
    };
  }

  return {
    content: buffer.toString("utf8"),
    skipped: false,
    reason: ""
  };
}

function summarizeChangedFile(relativePath, before, after) {
  if (!before && after) return `Created ${relativePath}`;
  if (before && !after) return `Deleted ${relativePath}`;
  return `Updated ${relativePath}`;
}

function splitDiffLines(content = "") {
  const normalized = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildLcsOps(oldLines, newLines) {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  if (oldCount * newCount > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((text) => ({ type: "remove", text })),
      ...newLines.map((text) => ({ type: "add", text }))
    ];
  }

  const table = Array.from({ length: oldCount + 1 }, () => new Uint32Array(newCount + 1));
  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[oldIndex][newIndex] = table[oldIndex + 1][newIndex + 1] + 1;
      } else {
        table[oldIndex][newIndex] = Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
      }
    }
  }

  const ops = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldCount && newIndex < newCount) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: "context", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      ops.push({ type: "remove", text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: "add", text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldCount) {
    ops.push({ type: "remove", text: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newCount) {
    ops.push({ type: "add", text: newLines[newIndex] });
    newIndex += 1;
  }
  return ops;
}

function buildLineOps(oldContent = "", newContent = "") {
  const oldLines = splitDiffLines(oldContent);
  const newLines = splitDiffLines(newContent);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const prefixOps = oldLines.slice(0, prefix).map((text) => ({ type: "context", text }));
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const suffixOps = suffix > 0 ? oldLines.slice(oldLines.length - suffix).map((text) => ({ type: "context", text })) : [];
  return [...prefixOps, ...buildLcsOps(oldMiddle, newMiddle), ...suffixOps];
}

function annotateDiffOps(ops) {
  let oldLine = 1;
  let newLine = 1;
  return ops.map((op) => {
    if (op.type === "add") {
      const line = { type: "add", oldLine: null, newLine, text: op.text };
      newLine += 1;
      return line;
    }
    if (op.type === "remove") {
      const line = { type: "remove", oldLine, newLine: null, text: op.text };
      oldLine += 1;
      return line;
    }
    const line = { type: "context", oldLine, newLine, text: op.text };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function buildDiffHunks(annotatedLines) {
  const changeIndexes = annotatedLines
    .map((line, index) => (line.type === "context" ? null : index))
    .filter((index) => index !== null);
  if (!changeIndexes.length) return { hunks: [], truncated: false };

  const ranges = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(annotatedLines.length, index + DIFF_CONTEXT_LINES + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  let renderedLines = 0;
  let truncated = false;
  const hunks = [];
  for (const range of ranges) {
    if (renderedLines >= MAX_DIFF_RENDER_LINES) {
      truncated = true;
      break;
    }
    let lines = annotatedLines.slice(range.start, range.end);
    if (renderedLines + lines.length > MAX_DIFF_RENDER_LINES) {
      lines = lines.slice(0, MAX_DIFF_RENDER_LINES - renderedLines);
      truncated = true;
    }
    renderedLines += lines.length;
    const oldLines = lines.filter((line) => line.type !== "add");
    const newLines = lines.filter((line) => line.type !== "remove");
    hunks.push({
      oldStart: oldLines[0]?.oldLine || lines.find((line) => line.oldLine)?.oldLine || 1,
      oldLines: oldLines.length,
      newStart: newLines[0]?.newLine || lines.find((line) => line.newLine)?.newLine || 1,
      newLines: newLines.length,
      lines
    });
  }
  return { hunks, truncated };
}

function buildFileDiff(oldContent = "", newContent = "") {
  const ops = buildLineOps(oldContent, newContent);
  const additions = ops.filter((op) => op.type === "add").length;
  const deletions = ops.filter((op) => op.type === "remove").length;
  const annotated = annotateDiffOps(ops);
  const { hunks, truncated } = buildDiffHunks(annotated);
  return { additions, deletions, diffHunks: hunks, diffTruncated: truncated };
}

function extractSuggestedCommands(summary = "") {
  const commands = [];
  const allowedPrefixes = ["npm ", "pnpm ", "yarn ", "node ", "python ", "pytest", "vitest", "npx ", "go test", "cargo test"];
  for (const line of String(summary || "").split(/\r?\n/)) {
    const cleaned = line.replace(/^[-*]\s*/, "").replace(/^`|`$/g, "").trim();
    if (!cleaned) continue;
    if (allowedPrefixes.some((prefix) => cleaned.toLowerCase().startsWith(prefix))) {
      commands.push(cleaned);
    }
    if (commands.length >= 6) break;
  }
  return commands.length ? commands : ["Review the proposed changed files before accepting."];
}

function compactList(items = [], limit = 8) {
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .slice(0, limit);
}

export function buildCodeResponseMarkdown({ diffSummary = "", changedFiles = [], riskNotes = [], testCommands = [], codexSummary = "" } = {}) {
  const files = compactList(changedFiles, 8).map((file) => `- ${file.path} (+${Number(file.additions || 0)} -${Number(file.deletions || 0)})`);
  const risks = compactList(riskNotes, 6).map((item) => `- ${item}`);
  const tests = compactList(testCommands, 6).map((item) => `- \`${item}\``);
  const summaryLine = String(diffSummary || "").trim() || "KiraAI heeft de opdracht verwerkt.";
  const modelNotes = String(codexSummary || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"))
    .slice(0, 3)
    .join(" ");

  return [
    "## Gedaan",
    summaryLine,
    modelNotes ? `\n${modelNotes}` : "",
    "",
    "## Hoe starten/testen",
    tests.length ? tests.join("\n") : "- Review de voorgestelde diff en run de normale project checks.",
    "",
    "## Bestanden geraakt",
    files.length ? files.join("\n") : "- Geen projectbestanden gewijzigd.",
    "",
    "## Risico's / aandachtspunten",
    risks.length ? risks.join("\n") : "- Geen specifieke aandachtspunten gemeld."
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function imageEstimatedDurationLabel(provider = resolveImageProvider(config.imageProvider)) {
  if (provider === "fake") return "enkele seconden";
  return "ongeveer 1 tot 2 minuten";
}

function buildImageStartResponseMarkdown({ prompt = "", provider = resolveImageProvider(config.imageProvider) } = {}) {
  const preview = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 220);
  const providerLabel = provider === "fake" ? "KiraAI preview engine" : "KiraAI";
  return [
    "## Ik ga dit maken",
    preview
      ? `Oké, ik ga nu een afbeelding maken van: ${preview}`
      : "Oké, ik ga nu een afbeelding maken op basis van je prompt.",
    `Dit duurt meestal ${imageEstimatedDurationLabel(provider)}.`,
    "",
    "## Status",
    `${providerLabel} is bezig met genereren. Zodra de afbeelding klaar is, verschijnt de preview hieronder in de response box.`,
    "De afbeelding wordt als KiraAI job asset bewaard, niet als bestand in je projectfolder."
  ].join("\n");
}

function buildImageResponseMarkdown({ prompt = "", asset } = {}) {
  return [
    "## Gedaan",
    "Klaar, ik heb een visueel voorbeeld gegenereerd op basis van je prompt.",
    "",
    "## Hoe gebruiken",
    "- Open de afbeelding hieronder als referentie voor wireframes, layout of designrichting.",
    "- De preview staat in de response box. Er wordt geen PNG/SVG in je projectfolder geschreven.",
    "- Er zijn geen projectbestanden aangepast en er is niets om te accepteren of te rejecten.",
    "",
    "## Bestanden geraakt",
    "- Geen projectbestanden gewijzigd.",
    "",
    "## Aandachtspunten",
    "- Merknamen worden als algemene stijlreferentie gebruikt, niet als officieel logo of exacte merk-assets.",
    asset?.metadata_json?.model ? `- Image model: ${asset.metadata_json.model}` : "",
    prompt ? `- Prompt: ${String(prompt).trim().slice(0, 220)}` : ""
  ].filter((line) => line !== "").join("\n");
}

function buildFailureResponseMarkdown(error) {
  const nextStep = error?.code === "KIRAAI_SKILLS_REQUIRED"
    ? "- Voeg eerst bronnen toe in Settings -> KiraAI Learning en start learning, daarna kun je de job opnieuw proberen."
    : "- Gebruik Retry om dezelfde prompt opnieuw te proberen nadat de oorzaak is opgelost.";
  return [
    "## Gedaan",
    "KiraAI kon deze job niet afronden.",
    "",
    "## Aandachtspunten",
    `- ${error?.message || "Onbekende fout."}`,
    error?.code ? `- Code: ${error.code}` : "",
    "",
    "## Hoe verder",
    nextStep
  ].filter((line) => line !== "").join("\n");
}

async function collectWorkspaceChanges(beforeSnapshot, workDir) {
  const afterSnapshot = await snapshotWorkspace(workDir);
  const allPaths = [...new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()])].sort();

  const changedPaths = allPaths.filter((relativePath) => {
    const before = beforeSnapshot.get(relativePath);
    const after = afterSnapshot.get(relativePath);
    return before?.hash !== after?.hash;
  });

  const truncated = changedPaths.length > MAX_CHANGED_FILES;
  const toProcess = changedPaths.slice(0, MAX_CHANGED_FILES);

  const changedFiles = await Promise.all(
    toProcess.map(async (relativePath) => {
      const before = beforeSnapshot.get(relativePath);
      const after = afterSnapshot.get(relativePath);
      if (!after) {
        const diff = before?.content !== undefined ? buildFileDiff(before.content, "") : { additions: 0, deletions: 0, diffHunks: [], diffTruncated: false };
        return {
          path: relativePath,
          action: "delete",
          content: "",
          additions: diff.additions,
          deletions: diff.deletions,
          diffHunks: diff.diffHunks,
          diffTruncated: diff.diffTruncated,
          diffSummary: summarizeChangedFile(relativePath, before, after)
        };
      }
      const filePath = path.join(workDir, relativePath);
      const content = await contentForChangedFile(filePath, relativePath);
      if (content.skipped) {
        return {
          path: relativePath,
          action: "skipped",
          content: "",
          additions: 0,
          deletions: 0,
          diffHunks: [],
          diffTruncated: false,
          diffSummary: `${summarizeChangedFile(relativePath, before, after)} (${content.reason})`
        };
      }
      const diff = buildFileDiff(before?.content || "", content.content);
      return {
        path: relativePath,
        action: "upsert",
        content: content.content,
        additions: diff.additions,
        deletions: diff.deletions,
        diffHunks: diff.diffHunks,
        diffTruncated: diff.diffTruncated,
        diffSummary: summarizeChangedFile(relativePath, before, after)
      };
    })
  );

  return { changedFiles, truncated };
}

async function callCodeModelWithCodex(jobId, rootPath, prompt, timer = null) {
  const provider = resolveCodeAgentProvider();
  const agentLabel = codeAgentLabel(provider);
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-code-job-"));
  const workDir = path.join(tempDir, "workspace");
  const outputFile = path.join(tempDir, "codex-summary.txt");
  const copyStartedAt = Date.now();
  if (timer) await markCodeJobStage(jobId, timer, "workspace_copy");
  await appendLog(jobId, "Preparing isolated workspace copy");
  await cp(rootPath, workDir, {
    recursive: true,
    filter: (sourcePath) => shouldCopyToIsolatedWorkspace(sourcePath)
  });
  if (timer) await markCodeJobStage(jobId, timer, "workspace_dependencies");
  await prepareIsolatedDependencies(jobId, workDir);
  const beforeSnapshot = await snapshotWorkspace(workDir, { includeContent: true });
  await appendLog(jobId, "Isolated workspace ready", { durationMs: Date.now() - copyStartedAt });
  if (timer) {
    await markCodeJobStage(jobId, timer, provider, {
      model: provider === "claude_cli" ? config.claudeModel : config.codeAiModel,
      reasoningEffort: provider === "claude_cli" ? undefined : config.codeJobReasoningEffort
    });
  }
  let agentBin = "";
  let args = [];
  if (provider === "claude_cli") {
    agentBin = await resolveClaudeBinary();
    args = [
      "-p",
      "--output-format",
      "text",
      "--input-format",
      "text",
      "--permission-mode",
      config.claudePermissionMode,
      "--max-turns",
      String(config.claudeMaxTurns),
      "--no-session-persistence"
    ];
    if (config.claudeModel) args.push("--model", config.claudeModel);
  } else {
    agentBin = await resolveCodexBinary();
    args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      config.codeJobSandbox,
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "-c",
      `model_reasoning_effort="${config.codeJobReasoningEffort}"`,
      "--skip-git-repo-check",
      "--output-last-message",
      outputFile
    ];
    if (config.codeAiModel) args.push("--model", config.codeAiModel);
    args.push("-");
  }

  await appendLog(jobId, `${agentLabel} engine started`, {
    provider,
    model: provider === "claude_cli" ? config.claudeModel : config.codeAiModel,
    reasoningEffort: provider === "claude_cli" ? undefined : config.codeJobReasoningEffort,
    sandbox: provider === "claude_cli" ? config.claudePermissionMode : config.codeJobSandbox,
    timeoutMs: config.codeJobTimeoutMs
  });

  try {
    const agentStartedAt = Date.now();
    let agentSummary = "";
    await new Promise((resolve, reject) => {
      const child = spawn(agentBin, args, {
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(provider === "claude_cli"
            ? {
                CLAUDE_CONFIG_DIR: config.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || "/home/node/.claude",
                CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
                DISABLE_AUTOUPDATER: "1",
                ANTHROPIC_API_KEY: undefined
              }
            : {})
        }
      });
      child.stdin.end(prompt);

      let stderr = "";
      let stdout = "";
      let timedOut = false;
      let settled = false;
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void appendLog(jobId, "KiraAI engine timed out; stopping process", { timeoutMs: config.codeJobTimeoutMs });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
          finish(
            new ExternalServiceError(
              `KiraAI code job timed out after ${config.codeJobTimeoutMs}ms`,
              { stderr: stderr.trim(), stdout: stdout.trim() },
              "CODE_JOB_CODEX_TIMEOUT"
            )
          );
        }, 5000).unref();
      }, config.codeJobTimeoutMs);
      const heartbeat = setInterval(() => {
        const idleMs = Date.now() - lastOutputAt;
        void appendLog(jobId, "KiraAI engine still running", {
          elapsedMs: Date.now() - startedAt,
          idleMs
        });
      }, 15000);

      const flushLines = (source, chunk) => {
        const text = chunk.toString();
        lastOutputAt = Date.now();
        const parts = text.split(/\r?\n/).filter((part) => part.trim());
        for (const part of parts) {
          if (!shouldKeepCodexLogLine(part)) continue;
          const compact = part.length > 320 ? `${part.slice(0, 317)}...` : part;
          void appendLog(jobId, `kiraai ${source}`, { line: compact });
        }
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (provider === "claude_cli") agentSummary += chunk.toString();
        flushLines("stdout", chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        flushLines("stderr", chunk);
      });
      child.on("error", (error) => {
        finish(new ExternalServiceError(error.message, null, "CODE_JOB_CODEX_PROCESS_ERROR"));
      });
      child.on("close", (code) => {
        if (timedOut) {
          finish(
            new ExternalServiceError(
              `KiraAI code job timed out after ${config.codeJobTimeoutMs}ms`,
              { stderr: stderr.trim(), stdout: stdout.trim() },
              "CODE_JOB_CODEX_TIMEOUT"
            )
          );
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        finish(codeJobCliExitError(provider, code, stderr, stdout));
      });
    });
    await appendLog(jobId, `${agentLabel} engine finished`, { durationMs: Date.now() - agentStartedAt });

    let codexSummary = "";
    if (provider === "claude_cli") {
      codexSummary = agentSummary.trim();
    } else {
      try {
        codexSummary = await readFile(outputFile, "utf8");
      } catch {
        codexSummary = "";
      }
    }
    const collectStartedAt = Date.now();
    if (timer) await markCodeJobStage(jobId, timer, "collect_changes");
    await appendLog(jobId, "Collecting changed files from isolated workspace");
    const proposal = await collectWorkspaceChanges(beforeSnapshot, workDir);
    await appendLog(jobId, "Changed files collected", {
      durationMs: Date.now() - collectStartedAt,
      changedFiles: proposal.changedFiles.length
    });
    return {
      codexSummary,
      changedFiles: proposal.changedFiles,
      truncated: proposal.truncated
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeResponseMode(value) {
  const mode = String(value || "auto").toLowerCase();
  if (!["auto", "code", "image"].includes(mode)) throw new ValidationError("responseMode must be auto, code, or image");
  return mode;
}

async function assertCodeJobCapacity() {
  const limit = Number(config.codeJobMaxActive || 0);
  if (!limit) return;
  const active = await query(
    "SELECT COUNT(*)::int AS count FROM code_jobs WHERE status IN ('queued','planning','running')"
  );
  const count = Number(active.rows[0]?.count || 0);
  if (count >= limit) {
    throw new RateLimitError(`Too many active code jobs. Wait for one to finish before starting another.`, {
      active: count,
      limit
    });
  }
}

export function hasSelectedLearnedSkills(mind = {}) {
  return Array.isArray(mind.skills) && mind.skills.length > 0;
}

export function assertLearnedSkillsForCodeJob(mind = {}) {
  if (!config.codeJobRequireLearnedSkills) return;
  if (hasSelectedLearnedSkills(mind)) return;
  throw new AppError(
    "KiraAI has no learned skills for this prompt yet, so the job stopped before any generation engine could run.",
    {
      statusCode: 409,
      code: "KIRAAI_SKILLS_REQUIRED",
      details: {
        reason: mind.warning || mind.selectorReason || "No learned KiraAI skills were selected.",
        required: true
      },
      name: "KiraAiSkillsRequiredError"
    }
  );
}

export async function startCodeJob({ projectId, rootPath, userPrompt, jobType = "prompt", title = "", requestMetadata = {}, responseMode = "auto" }) {
  const resolved = await resolveCodeJobRoot({ projectId, rootPath });
  if (!userPrompt?.trim()) throw new ValidationError("Prompt is required");
  await assertCodeJobCapacity();
  const normalizedResponseMode = normalizeResponseMode(responseMode || requestMetadata?.responseMode || "auto");
  const originalPrompt = userPrompt.trim();
  const workflowKind = detectCodeJobWorkflow({
    prompt: originalPrompt,
    responseMode: normalizedResponseMode,
    jobType
  });
  const effectiveJobType = workflowKind === "structure" ? "structure" : jobType || "prompt";
  const workflowPrompt = workflowKind === "structure"
    ? buildFullStackStructurePrompt({
        projectName: resolved.projectName,
        instructions: originalPrompt
      })
    : originalPrompt;
  const imageProvider = resolveImageProvider(config.imageProvider);
  const willGenerateImage = workflowKind === "image";
  const metadata = {
    ...(requestMetadata || {}),
    responseMode: normalizedResponseMode,
    workflowKind,
    workflowPrompt: workflowKind === "structure" ? workflowPrompt : undefined
  };
  const responseMetadata = willGenerateImage
    ? {
        responseMode: normalizedResponseMode,
        workflowKind,
        imageProvider,
        estimatedDuration: imageEstimatedDurationLabel(imageProvider)
      }
    : workflowKind === "structure"
      ? {
          responseMode: normalizedResponseMode,
          workflowKind
        }
    : {};
  const created = await query(
    `INSERT INTO code_jobs (project_id, root_path, user_prompt, model, status, job_type, title, request_metadata, response_kind, response_markdown, response_metadata)
     VALUES ($1,$2,$3,$4,'queued',$5,$6,$7::jsonb,$8,$9,$10::jsonb)
     RETURNING *`,
    [
      resolved.projectId,
      resolved.safeRoot,
      originalPrompt,
      config.codeAiModel,
      effectiveJobType,
      title || (workflowKind === "structure" ? "Full-stack structure proposal" : null),
      JSON.stringify(metadata),
      willGenerateImage ? "image" : "code",
      willGenerateImage ? buildImageStartResponseMarkdown({ prompt: originalPrompt, provider: imageProvider }) : null,
      JSON.stringify(responseMetadata)
    ]
  );
  const job = created.rows[0];
  void runCodeJob(job.id).catch((error) => failCodeJob(job.id, error));
  return job;
}

export async function startStructureCodeJob({ projectId, preset = "full_stack", instructions = "" }) {
  if (preset !== "full_stack") throw new ValidationError("Unsupported structure preset");
  const project = await query("SELECT id, name, root_path FROM projects WHERE id=$1 LIMIT 1", [projectId]);
  if (!project.rowCount) throw new NotFoundError("Project not found");
  const row = project.rows[0];
  return startCodeJob({
    projectId: row.id,
    userPrompt: String(instructions || "").trim() || "Create a full-stack project structure.",
    jobType: "structure",
    title: "Full-stack structure proposal",
    responseMode: "code",
    requestMetadata: {
      preset,
      instructions: String(instructions || "").trim(),
      responseMode: "code"
    }
  });
}

async function failCodeJob(jobId, error) {
  const current = await query("SELECT response_kind, response_metadata FROM code_jobs WHERE id=$1 LIMIT 1", [jobId]).catch(() => ({ rows: [] }));
  const currentRow = current.rows?.[0] || {};
  await appendLog(jobId, "Job failed", {
    error: error.message,
    code: error.code || "CODE_JOB_FAILED",
    details: error.details || null
  }).catch(() => null);
  await setStatus(jobId, "failed", {
    finalStatus: "failed",
    responseMarkdown: buildFailureResponseMarkdown(error),
    responseKind: currentRow.response_kind || "code",
    responseMetadata: {
      ...(currentRow.response_metadata || {}),
      errorCode: error.code || "CODE_JOB_FAILED"
    }
  }).catch(() => null);
  await finishCodeJobTiming(jobId, "failed", {
    errorCode: error.code || "CODE_JOB_FAILED"
  }).catch(() => null);
}

export async function recoverInterruptedCodeJobsOnStartup() {
  if (!config.jobResumeEnabled) return [];
  const maxAttempts = maxCodeResumeAttempts();
  if (maxAttempts <= 0) return [];

  await query(
    `UPDATE code_jobs
     SET runner_id=NULL,
         interrupted_at=COALESCE(interrupted_at, NOW()),
         resume_reason=COALESCE(resume_reason, 'server_restart'),
         updated_at=NOW()
     WHERE status IN ('queued','planning','running')
       AND resume_count < $1`,
    [maxAttempts]
  );

  const row = await query(
    `SELECT id, status, resume_count, improved_prompt
     FROM code_jobs
     WHERE status IN ('queued','planning','running')
       AND resume_count < $1
     ORDER BY updated_at ASC
     LIMIT 20`,
    [maxAttempts]
  );

  for (const job of row.rows) {
    void runCodeJob(job.id, { resumed: true, reason: "server_restart" }).catch((error) => failCodeJob(job.id, error));
  }
  return row.rows;
}

export async function markInterruptedCodeJobs() {
  return recoverInterruptedCodeJobsOnStartup();
}

export async function runCodeJob(jobId, { resumed = false, reason = "" } = {}) {
  let job = await claimCodeJobForRun(jobId, { resumed, reason });
  if (!job) return getCodeJob(jobId);
  const timer = timerFromCodeJob(job);
  let learnedSkillNote = "";
  let planningContext = null;
  await markCodeJobStage(jobId, timer, resumed ? "resume" : "start", {
    resumeCount: Number(job.resume_count || 0),
    reason: resumed ? reason || job.resume_reason || "server_restart" : "new_job"
  });

  if (resumed || Number(job.resume_count || 0) > 0) {
    await appendLog(jobId, "Resuming KiraAI code job", {
      resumeCount: job.resume_count,
      reason: reason || job.resume_reason || "server_restart",
      checkpoint: job.improved_prompt ? "saved_prompt" : "planning"
    });
  }

  const requestMetadata = job.request_metadata && typeof job.request_metadata === "object" ? job.request_metadata : {};
  const responseMode = normalizeResponseMode(requestMetadata.responseMode || "auto");
  const jobPrompt = String(requestMetadata.workflowPrompt || job.user_prompt || "");

  async function loadPlanningContext() {
    if (planningContext) return planningContext;

    await markCodeJobStage(jobId, timer, "planning_context");
    await setStatus(jobId, "planning");
    await appendLog(jobId, "Loading learning profile and querying KiraAI skills");
    const planningStartedAt = Date.now();
    const [learningProfile, mind] = await Promise.all([
      measureTimerStage(timer, "learning_profile", () => getLearningProfile(job.root_path).catch(() => ({}))),
      measureTimerStage(timer, "ml_mind", () => buildMindContextForPrompt({ prompt: jobPrompt, codeJobId: job.id }).catch((error) => ({
        context: "",
        skills: [],
        chunks: [],
        warning: error.message
      })))
    ]);
    const skillCount = mind.skills?.length || 0;
    const skillWarning = mind.warning || "";
    learnedSkillNote = skillCount
      ? `KiraAI used ${skillCount} learned shared server skill(s) while planning.`
      : "KiraAI stopped because no learned server skills were selected.";
    await saveCodeJobTiming(jobId, timer);
    await heartbeatCodeJob(jobId);
    await appendLog(jobId, "Planning context ready", {
      skills: skillCount,
      chunks: mind.chunks?.length || 0,
      warning: skillWarning || null,
      durationMs: Date.now() - planningStartedAt,
      selectorStrategy: mind.selectorStrategy || null,
      cacheHit: mind.cacheHit ?? null,
      candidateCount: mind.candidateCount ?? null
    });
    if (!skillCount) {
      await appendLog(jobId, "No learned KiraAI skills selected", {
        reason: skillWarning || "No matching learned skills were selected.",
        scope: "shared_global_skill_library",
        strictMode: Boolean(config.codeJobRequireLearnedSkills)
      });
    }
    assertLearnedSkillsForCodeJob(mind);
    planningContext = { learningProfile, mind };
    return planningContext;
  }

  if (shouldGenerateImage({ prompt: jobPrompt, responseMode })) {
    const { mind } = await loadPlanningContext();
    const imageProvider = resolveImageProvider(config.imageProvider);
    const estimatedDuration = imageEstimatedDurationLabel(imageProvider);
    await markCodeJobStage(jobId, timer, "image_generation");
    await setStatus(jobId, "running", {
      responseKind: "image",
      responseMarkdown: buildImageStartResponseMarkdown({ prompt: job.user_prompt, provider: imageProvider }),
      responseMetadata: {
        responseMode,
        imageProvider,
        estimatedDuration
      }
    });
    await appendLog(jobId, "Generating image response", {
      provider: imageProvider,
      configuredProvider: config.imageProvider,
      model: imageProvider === "codex_cli" ? config.imageCodexModel : imageProvider
    });
    const imagePrompt = mind.context
      ? `${mind.context}\n\n## User image prompt\n${job.user_prompt}`
      : job.user_prompt;
    const generated = await measureTimerStage(timer, "image_provider", () => generateImageAsset({ prompt: imagePrompt }));
    const asset = await saveCodeJobAsset(jobId, generated);
    await saveCodeJobTiming(jobId, timer);
    const responseMarkdown = buildImageResponseMarkdown({ prompt: job.user_prompt, asset });
    job = await setStatus(jobId, "done", {
      changedFiles: [],
      diffSummary: "Generated 1 image asset. No project files were changed.",
      riskNotes: ["Image-only job. Project files are untouched.", ...(learnedSkillNote ? [learnedSkillNote] : [])],
      testCommands: ["Open the generated image preview."],
      finalStatus: "done",
      responseMarkdown,
      responseKind: "image",
      responseMetadata: {
        responseMode,
        imageProvider,
        estimatedDuration,
        assetIds: [asset.id],
        assetCount: 1
      }
    });
    job = await finishCodeJobTiming(jobId, "done", { assets: 1 }) || job;
    await appendLog(jobId, "Image response ready", {
      assetId: asset.id,
      durationMs: job.duration_ms || null
    });
    const fullJob = await getCodeJob(jobId);
    emit(jobId, { type: "status", job: fullJob });
    return fullJob;
  }

  let improvedPrompt = job.improved_prompt;
  if (improvedPrompt?.trim()) {
    await markCodeJobStage(jobId, timer, "recovered_prompt", {
      resumeCount: Number(job.resume_count || 0)
    });
    await loadPlanningContext();
    await setStatus(jobId, "running", { improvedPrompt });
    await appendLog(jobId, "Recovered saved prompt", { resumeCount: job.resume_count });
  } else {
    const { learningProfile, mind } = await loadPlanningContext();
    improvedPrompt = buildImprovedPrompt({
      userPrompt: jobPrompt,
      learningProfile,
      mindContext: mind.context || ""
    });
    await setStatus(jobId, "running", { improvedPrompt });
  }
  const executionPrompt = buildCodePrompt({
    improvedPrompt,
    rootPath: "temporary copy of the selected project root"
  });
  await appendLog(jobId, "Calling KiraAI code model", {
    model: config.codeAiModel,
    mode: "temp-workspace-diff"
  });

  const payload = await callCodeModelWithCodex(jobId, job.root_path, executionPrompt, timer);
  await heartbeatCodeJob(jobId);
  await markCodeJobStage(jobId, timer, "save_proposal");
  const changedFiles = (payload.changedFiles || []).filter((file) => file.action !== "skipped");
  const skippedFiles = (payload.changedFiles || []).filter((file) => file.action === "skipped");
  const additions = changedFiles.reduce((sum, file) => sum + Number(file.additions || 0), 0);
  const deletions = changedFiles.reduce((sum, file) => sum + Number(file.deletions || 0), 0);
  const diffSummary = changedFiles.length
    ? `${changedFiles.length} file change(s) (+${additions} -${deletions}): ${changedFiles.map((file) => file.path).slice(0, 8).join(", ")}${changedFiles.length > 8 ? ", ..." : ""}`
    : "KiraAI finished but did not modify files.";
  const riskNotes = [
    "Changes were made in an isolated temporary copy. Real project files are untouched until Accept Changes.",
    ...(learnedSkillNote ? [learnedSkillNote] : []),
    ...(payload.truncated ? [`Only the first ${MAX_CHANGED_FILES} changed files are shown.`] : []),
    ...skippedFiles.map((file) => `${file.path}: ${file.diffSummary}`)
  ];
  const testCommands = extractSuggestedCommands(payload.codexSummary);
  const responseMarkdown = buildCodeResponseMarkdown({
    diffSummary,
    changedFiles,
    riskNotes,
    testCommands,
    codexSummary: payload.codexSummary
  });
  job = await setStatus(jobId, "awaiting_review", {
    improvedPrompt,
    changedFiles,
    diffSummary,
    riskNotes,
    testCommands,
    finalStatus: "awaiting_review",
    responseMarkdown,
    responseKind: "code",
    responseMetadata: {
      changedFileCount: changedFiles.length,
      additions,
      deletions
    }
  });
  job = await finishCodeJobTiming(jobId, "awaiting_review", { changedFiles: changedFiles.length }) || job;
  await appendLog(jobId, "Code proposal ready", {
    changedFiles: changedFiles.length,
    durationMs: job.duration_ms || null
  });
  return job;
}

export async function getCodeJob(jobId) {
  const row = await query(
    `SELECT c.*, p.name AS project_name, p.root_path AS project_root_path
     FROM code_jobs c
     LEFT JOIN projects p ON p.id = c.project_id
     WHERE c.id=$1
     LIMIT 1`,
    [jobId]
  );
  if (!row.rowCount) throw new NotFoundError("Code job not found");
  const job = row.rows[0];
  job.assets = await listCodeJobAssets(jobId);
  job.asset_count = job.assets.length;
  return job;
}

export async function getCodeJobAsset(jobId, assetId) {
  const row = await query(
    `SELECT id, code_job_id, asset_type, mime_type, filename, content, metadata_json, created_at
     FROM code_job_assets
     WHERE code_job_id=$1 AND id=$2
     LIMIT 1`,
    [jobId, assetId]
  );
  if (!row.rowCount) throw new NotFoundError("Code job asset not found");
  const asset = row.rows[0];
  if (String(asset.mime_type || "").toLowerCase().includes("image/svg+xml")) {
    asset.content = normalizeSvgAssetContent(asset.content);
  }
  return asset;
}

export async function listCodeJobs(limit = 20, offset = 0, filters = {}) {
  const clauses = [];
  const params = [];
  const joins = [];
  if (filters.userId) {
    joins.push("JOIN project_memberships pm ON pm.project_id = c.project_id");
    params.push(filters.userId);
    clauses.push(`pm.user_id=$${params.length}`);
  }
  if (filters.projectId) {
    params.push(filters.projectId);
    clauses.push(`c.project_id=$${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`c.status=$${params.length}`);
  }
  if (filters.type) {
    params.push(filters.type);
    clauses.push(`c.job_type=$${params.length}`);
  }
  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await query(
    `SELECT c.*, p.name AS project_name, p.root_path AS project_root_path, COALESCE(a.asset_count, 0)::int AS asset_count
     FROM code_jobs c
     ${joins.join("\n     ")}
     LEFT JOIN projects p ON p.id = c.project_id
     LEFT JOIN (
       SELECT code_job_id, COUNT(*) AS asset_count
       FROM code_job_assets
       GROUP BY code_job_id
     ) a ON a.code_job_id = c.id
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params
  );
  return rows.rows;
}

export async function listProjectCodeJobs(projectId, options = {}) {
  return listCodeJobs(options.limit || 30, options.offset || 0, {
    projectId,
    status: options.status || "",
    type: options.type || ""
  });
}

export async function applyCodeJob(jobId) {
  const job = await getCodeJob(jobId);
  if (job.status !== "awaiting_review") throw new ValidationError("Code job is not awaiting review");
  const changedFiles = Array.isArray(job.changed_files) ? job.changed_files : [];
  const safeRoot = await resolveExistingSafePath(job.root_path);
  for (const file of changedFiles) {
    const target = path.resolve(safeRoot, file.path || "");
    const safeTarget = resolveSafePath(target);
    ensureInsideProjectRoot(safeRoot, safeTarget);
    try {
      if (file.action === "delete") {
        await fsDelete({ targetPath: safeTarget });
        continue;
      }
      if (file.action && file.action !== "upsert") continue;
      await fsWriteFile({ targetPath: safeTarget, content: file.content || "", conflictPolicy: "overwrite" });
    } catch (error) {
      if (String(error?.message || "").toLowerCase().includes("access denied")) {
        throw new ValidationError(
          `Accept Changes cannot write "${file.path || safeTarget}". The selected project root is not writable by KiraAI. For local Docker Desktop projects mounted from C:/, set APP_USER=root in .env and recreate the app container. For production, keep projects inside a Linux workspace owned by APP_USER.`,
          {
            rootPath: safeRoot,
            filePath: file.path || "",
            cause: error.message
          }
        );
      }
      throw error;
    }
  }
  await appendLog(jobId, "Applied code proposal", { changedFiles: changedFiles.length });
  return setStatus(jobId, "applied", { finalStatus: "applied" });
}

export async function rejectCodeJob(jobId) {
  await appendLog(jobId, "Rejected code proposal");
  return setStatus(jobId, "rejected", { finalStatus: "rejected" });
}

export function registerCodeJobEvents(req, res) {
  const jobId = String(req.params.id || "");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  if (!eventClients.has(jobId)) eventClients.set(jobId, new Set());
  eventClients.get(jobId).add(res);
  res.write(`event: code-job\n`);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    eventClients.get(jobId)?.delete(res);
  });
}
