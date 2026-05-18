import OpenAI from "openai";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "./db.js";
import { config } from "./config.js";
import { ExternalServiceError, NotFoundError, ValidationError } from "./errors.js";
import { resolveCodexBinary } from "./codexBinary.js";

const openai = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null;
const eventClients = new Map();
const activeJobs = new Map();
const RUNNER_ID = `ml-${process.pid}-${randomUUID()}`;
const MIND_SELECTOR_VERSION = "fast-v18";

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
  ".vue"
]);

const IGNORE_SEGMENTS = new Set([
  ".git",
  ".github",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor"
]);

const IGNORE_FILENAMES = new Set([
  ".env",
  ".env.local",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
]);

const WEBSITE_BINARY_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".eot",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip"
]);

const WEBSITE_ASSET_EXTENSIONS = new Set([".css", ".js", ".mjs", ".ts"]);

function nowIso() {
  return new Date().toISOString();
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function slugify(value) {
  return String(value || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "skill";
}

function cleanOneLine(value, max = 400) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeSnippetLanguage(value) {
  const text = cleanOneLine(value || "JavaScript", 40);
  return text || "JavaScript";
}

function extensionForLanguage(language) {
  const normalized = String(language || "").toLowerCase();
  if (normalized.includes("html")) return ".html";
  if (normalized.includes("css") || normalized.includes("scss")) return normalized.includes("scss") ? ".scss" : ".css";
  if (normalized.includes("typescript") || normalized === "ts") return ".ts";
  if (normalized.includes("jsx")) return ".jsx";
  if (normalized.includes("tsx")) return ".tsx";
  if (normalized.includes("markdown")) return ".md";
  return ".js";
}

function vectorLiteral(embedding) {
  return `[${embedding.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function getOpenAiOrThrow() {
  if (!openai) {
    throw new ExternalServiceError(
      "OPENAI_API_KEY is required for KiraAI learning and embeddings.",
      null,
      "ML_OPENAI_NOT_CONFIGURED"
    );
  }
  return openai;
}

function assertMlProvidersReady() {
  if (!["openai", "local_hash"].includes(config.mlEmbeddingProvider)) {
    throw new ValidationError(`Unsupported ML_EMBEDDING_PROVIDER: ${config.mlEmbeddingProvider}`);
  }
  if (config.mlEmbeddingProvider === "openai") getOpenAiOrThrow();
}

function parseGitHubRepoUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new ValidationError("GitHub repo URL is invalid");
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new ValidationError("Only public https://github.com/owner/repo URLs are supported");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new ValidationError("GitHub repo URL must include owner and repo");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ValidationError("GitHub repo owner or name contains unsupported characters");
  }

  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git`,
    htmlUrl: `https://github.com/${owner}/${repo}`,
    name: `${owner}/${repo}`
  };
}

function parseGitHubRepoInputs(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);
  return rawItems.map((item) => String(item || "").trim()).filter(Boolean);
}

function parseWebsiteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new ValidationError("Website URL is invalid");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ValidationError("Only http:// and https:// website URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError("Website URLs with credentials are not supported");
  }

  parsed.hash = "";
  if (parsed.pathname === "") parsed.pathname = "/";
  const normalized = parsed.toString();
  return {
    url: normalized,
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    name: cleanOneLine(`${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`, 160),
    repoOwner: parsed.hostname.toLowerCase(),
    repoName: slugify(parsed.pathname === "/" ? "root" : parsed.pathname).slice(0, 80) || "website"
  };
}

function parseWebsiteInputs(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);
  return rawItems.map((item) => String(item || "").trim()).filter(Boolean);
}

function emitJob(jobId, event) {
  const clients = eventClients.get(String(jobId)) || new Set();
  for (const res of clients) {
    res.write("event: ml-job\n");
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

async function getLearningJobRow(jobId) {
  const row = await query(
    `SELECT j.*, s.name AS source_name, s.url AS source_url
     FROM ml_learning_jobs j
     JOIN ml_sources s ON s.id = j.source_id
     WHERE j.id=$1
     LIMIT 1`,
    [jobId]
  );
  return row.rows[0] || null;
}

async function updateLearningJob(jobId, patch = {}) {
  const columns = {
    status: "status",
    progress: "progress",
    stage: "stage",
    message: "message",
    stats: "stats",
    error: "error",
    startedAt: "started_at",
    finishedAt: "finished_at",
    lastHeartbeatAt: "last_heartbeat_at",
    interruptedAt: "interrupted_at",
    runnerId: "runner_id",
    resumeReason: "resume_reason",
    resumeState: "resume_state"
  };
  const jsonColumns = new Set(["stats", "error", "resumeState"]);
  const sets = [];
  const params = [jobId];
  let statusParamRef = "";

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = columns[key];
    if (!column) continue;
    params.push(jsonColumns.has(key) ? JSON.stringify(value || {}) : value);
    if (key === "status") statusParamRef = `$${params.length}`;
    sets.push(`${column}=$${params.length}${jsonColumns.has(key) ? "::jsonb" : ""}`);
  }

  if (!sets.length) return getLearningJobRow(jobId);
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    params.push(RUNNER_ID);
    sets.push(`runner_id=CASE WHEN ${statusParamRef} IN ('queued','running') THEN COALESCE(runner_id, $${params.length}) ELSE NULL END`);
    sets.push(`last_heartbeat_at=CASE WHEN ${statusParamRef} IN ('queued','running') THEN NOW() ELSE last_heartbeat_at END`);
  }
  sets.push("updated_at=NOW()");
  const row = await query(
    `UPDATE ml_learning_jobs SET ${sets.join(", ")} WHERE id=$1 RETURNING *`,
    params
  );
  const job = row.rows[0];
  emitJob(jobId, { type: "status", job });
  return job;
}

async function appendLearningLog(jobId, message, data = {}) {
  const entry = { ts: nowIso(), message, data };
  const row = await query(
    `UPDATE ml_learning_jobs
     SET logs = logs || $2::jsonb,
         last_heartbeat_at=CASE WHEN status IN ('queued','running') THEN NOW() ELSE last_heartbeat_at END,
         updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [jobId, JSON.stringify([entry])]
  );
  emitJob(jobId, { type: "log", job: row.rows[0], entry });
  return row.rows[0];
}

function maxMlResumeAttempts() {
  return Math.max(0, Number(config.mlJobMaxResumeAttempts || 0));
}

async function claimLearningJobForRun(jobId, { resumed = false, reason = "" } = {}) {
  const row = await query(
    `UPDATE ml_learning_jobs
     SET status='running',
         runner_id=$2,
         last_heartbeat_at=NOW(),
         interrupted_at=CASE WHEN $3 THEN COALESCE(interrupted_at, NOW()) ELSE interrupted_at END,
         resume_count=CASE WHEN $3 THEN resume_count + 1 ELSE resume_count END,
         resume_reason=CASE WHEN $3 THEN $4 ELSE resume_reason END,
         error=NULL,
         finished_at=NULL,
         updated_at=NOW()
     WHERE id=$1
       AND status IN ('queued','running')
       AND (runner_id IS NULL OR runner_id=$2 OR last_heartbeat_at IS NULL OR last_heartbeat_at < NOW() - ($5::text)::interval)
       AND (NOT $3 OR resume_count < $6)
     RETURNING *`,
    [
      jobId,
      RUNNER_ID,
      Boolean(resumed),
      reason || "server_restart",
      `${Math.max(1000, Number(config.jobResumeStaleMs || 30000))} milliseconds`,
      maxMlResumeAttempts()
    ]
  );
  return row.rows[0] || null;
}

async function heartbeatLearningJob(jobId) {
  await query(
    `UPDATE ml_learning_jobs
     SET last_heartbeat_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND runner_id=$2 AND status IN ('queued','running')`,
    [jobId, RUNNER_ID]
  ).catch(() => null);
}

async function mergeLearningResumeState(jobId, patch = {}) {
  await query(
    `UPDATE ml_learning_jobs
     SET resume_state = COALESCE(resume_state, '{}'::jsonb) || $2::jsonb,
         updated_at=NOW()
     WHERE id=$1`,
    [jobId, JSON.stringify(patch || {})]
  ).catch(() => null);
}

function assertNotCanceled(jobId) {
  if (activeJobs.get(Number(jobId))?.canceled) {
    const error = new Error("ML learning job was canceled");
    error.code = "ML_JOB_CANCELED";
    throw error;
  }
}

async function runCommand(jobId, command, args, options = {}) {
  assertNotCanceled(jobId);
  await appendLearningLog(jobId, `Running ${command}`, { args: args.slice(0, 4) });
  await new Promise((resolve, reject) => {
    const commandName = path.basename(String(command || "")).toLowerCase();
    const isGit = commandName === "git" || commandName === "git.exe";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(isGit ? { GIT_TERMINAL_PROMPT: "0" } : {}),
        ...(options.env || {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const active = activeJobs.get(Number(jobId));
    if (active) active.child = child;

    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ExternalServiceError(`${command} timed out`, null, "ML_COMMAND_TIMEOUT"));
    }, options.timeoutMs || 120000);

    const capture = (source, chunk) => {
      const text = chunk.toString();
      if (source === "stderr") stderr += text;
      else stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-4)) {
        const compact = line.length > 260 ? `${line.slice(0, 257)}...` : line;
        void appendLearningLog(jobId, `${command} ${source}`, { line: compact });
      }
    };

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new ExternalServiceError(error.message, null, "ML_COMMAND_ERROR"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const activeNow = activeJobs.get(Number(jobId));
      if (activeNow) activeNow.child = null;
      if (activeNow?.canceled) {
        const error = new Error("ML learning job was canceled");
        error.code = "ML_JOB_CANCELED";
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (isGit && code === 128) {
        reject(
          new ValidationError(
            "Repo is private, missing, or unavailable; public repos only.",
            { stderr: stderr.trim() }
          )
        );
        return;
      }
      reject(new ExternalServiceError(`${command} failed with code ${code}`, { stderr: stderr.trim() }, "ML_COMMAND_FAILED"));
    });
  });
}

async function validatePublicGitHubRepo(jobId, source) {
  await updateLearningJob(jobId, {
    progress: 8,
    stage: "validate",
    message: "Checking public GitHub repository access"
  });
  await runCommand(jobId, "git", ["ls-remote", "--exit-code", source.url, "HEAD"], {
    timeoutMs: 60000
  });
}

function shouldSkipPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => IGNORE_SEGMENTS.has(part))) return true;
  const filename = parts[parts.length - 1];
  if (IGNORE_FILENAMES.has(filename)) return true;
  if (filename.startsWith(".env")) return true;
  return false;
}

function languageForPath(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  const map = {
    ".css": "CSS",
    ".html": "HTML",
    ".js": "JavaScript",
    ".jsx": "React JSX",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".scss": "SCSS",
    ".ts": "TypeScript",
    ".tsx": "React TSX",
    ".vue": "Vue"
  };
  return map[ext] || ext.replace(".", "").toUpperCase();
}

function summarizeFile(relativePath, content) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"))
    .slice(0, 3)
    .join(" ");
  return cleanOneLine(`${languageForPath(relativePath)} patterns in ${relativePath}. ${lines}`, 500);
}

function isLikelyText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
  return !sample.includes("\uFFFD");
}

async function walkRepoFiles(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
    if (shouldSkipPath(relativePath)) continue;
    if (entry.isDirectory()) {
      await walkRepoFiles(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    files.push(fullPath);
  }
  return files;
}

async function scanRepo(jobId, sourceId, repoDir) {
  const maxRepoBytes = Math.max(1, config.mlMaxRepoMb) * 1024 * 1024;
  const files = await walkRepoFiles(repoDir);
  const docs = [];
  let totalBytes = 0;

  for (const filePath of files) {
    assertNotCanceled(jobId);
    const relativePath = path.relative(repoDir, filePath).replace(/\\/g, "/");
    const st = await stat(filePath).catch(() => null);
    if (!st || st.size <= 0 || st.size > config.mlMaxFileBytes) continue;
    totalBytes += st.size;
    if (totalBytes > maxRepoBytes) {
      throw new ValidationError(`Repo text payload exceeds ML_MAX_REPO_MB (${config.mlMaxRepoMb}MB)`);
    }
    const buffer = await readFile(filePath);
    if (!isLikelyText(buffer)) continue;
    const content = buffer.toString("utf8");
    docs.push({
      sourceId,
      path: relativePath,
      language: languageForPath(relativePath),
      title: path.basename(relativePath),
      content,
      contentHash: hashText(content),
      summary: summarizeFile(relativePath, content),
      size: buffer.length
    });
  }

  return { docs, totalBytes };
}

function documentFromSnippet(source, sourceId) {
  const metadata = source.metadata_json || {};
  const content = String(metadata.content || "");
  if (!content.trim()) throw new ValidationError("Snippet content is empty");
  if (content.length > config.mlMaxFileBytes) {
    throw new ValidationError(`Snippet is larger than ML_MAX_FILE_BYTES (${config.mlMaxFileBytes})`);
  }
  const language = normalizeSnippetLanguage(metadata.language);
  const title = cleanOneLine(metadata.title || source.name || "Pasted Code Skill", 140);
  const fileBase = slugify(title).slice(0, 60) || "pasted-code";
  const relativePath = `snippets/${fileBase}${extensionForLanguage(language)}`;

  return {
    docs: [
      {
        sourceId,
        path: relativePath,
        language,
        title,
        content,
        contentHash: hashText(content),
        summary: summarizeFile(relativePath, content),
        size: Buffer.byteLength(content, "utf8")
      }
    ],
    totalBytes: Buffer.byteLength(content, "utf8")
  };
}

async function fetchWebsiteBuffer(url, { accept = "text/html,*/*;q=0.8", timeoutMs = config.mlScraperTimeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept,
        "user-agent": "mcp-ml-mind-scraper/1.0"
      }
    });
    if (!response.ok) {
      throw new ValidationError(`Website fetch failed with HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > config.mlMaxFileBytes) {
      throw new ValidationError(`Website file exceeds ML_MAX_FILE_BYTES (${config.mlMaxFileBytes})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.mlMaxFileBytes) {
      throw new ValidationError(`Website file exceeds ML_MAX_FILE_BYTES (${config.mlMaxFileBytes})`);
    }
    if (!isLikelyText(buffer)) {
      throw new ValidationError("Website response is not learnable text");
    }
    return { buffer, contentType, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function validateWebsiteUrl(url) {
  const fetched = await fetchWebsiteBuffer(url, { accept: "text/html,*/*;q=0.8" });
  if (!/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) {
    throw new ValidationError("Website URL must return HTML");
  }
}

function parseRobotsTxt(text) {
  const disallow = [];
  let active = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [keyRaw, ...valueParts] = line.split(":");
    const key = String(keyRaw || "").trim().toLowerCase();
    const value = valueParts.join(":").trim();
    if (key === "user-agent") {
      active = value === "*";
      continue;
    }
    if (active && key === "disallow" && value) {
      disallow.push(value);
    }
  }
  return disallow;
}

async function loadRobotsRules(jobId, origin) {
  try {
    const robotsUrl = new URL("/robots.txt", origin).toString();
    const fetched = await fetchWebsiteBuffer(robotsUrl, {
      accept: "text/plain,*/*;q=0.5",
      timeoutMs: Math.min(config.mlScraperTimeoutMs, 5000)
    });
    const rules = parseRobotsTxt(fetched.buffer.toString("utf8"));
    await appendLearningLog(jobId, "Loaded robots.txt", { rules: rules.length });
    return rules;
  } catch {
    return [];
  }
}

function isRobotsDisallowed(url, rules) {
  const pathname = new URL(url).pathname || "/";
  return rules.some((rule) => rule !== "/" && pathname.startsWith(rule)) || rules.includes("/");
}

function isLoginLikePath(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  return /\/(login|signin|sign-in|auth|account|checkout|cart|admin)(\/|$)/.test(pathname);
}

function shouldSkipWebsiteUrl(url) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname).toLowerCase();
  if (WEBSITE_BINARY_EXTENSIONS.has(ext)) return true;
  if (isLoginLikePath(url)) return true;
  return false;
}

function normalizeWebsiteUrl(baseUrl, rawHref, { page = false } = {}) {
  if (!rawHref || /^(mailto|tel|javascript):/i.test(rawHref)) return "";
  let parsed;
  try {
    parsed = new URL(rawHref, baseUrl);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "";
  parsed.hash = "";
  if (page) parsed.search = "";
  return parsed.toString();
}

function isSameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function websitePathForUrl(url, fallbackExt) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname).toLowerCase() || fallbackExt;
  const pathname = parsed.pathname === "/" ? "index" : parsed.pathname.replace(/^\/+|\/+$/g, "");
  const withoutExt = pathname.replace(/\.[a-z0-9]+$/i, "");
  const queryHash = parsed.search ? `-${hashText(parsed.search).slice(0, 8)}` : "";
  return `website/${slugify(parsed.hostname)}/${slugify(withoutExt) || "index"}${queryHash}${ext}`;
}

function extractWebsiteLinks(html, pageUrl) {
  const links = [];
  const styles = [];
  const scripts = [];
  const tagPattern = /<\s*(a|link|script)\b[^>]*>/gi;
  const attrPattern = /\b([a-zA-Z_:.-]+)\s*=\s*["']([^"']+)["']/g;
  let tagMatch;

  while ((tagMatch = tagPattern.exec(html))) {
    const tagName = tagMatch[1].toLowerCase();
    const tag = tagMatch[0];
    const attrs = {};
    let attrMatch;
    while ((attrMatch = attrPattern.exec(tag))) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
    }
    if (tagName === "a" && attrs.href) links.push(attrs.href);
    if (tagName === "link" && attrs.href && /\bstylesheet\b/i.test(attrs.rel || "")) styles.push(attrs.href);
    if (tagName === "script" && attrs.src) scripts.push(attrs.src);
  }

  return {
    links: links.map((href) => normalizeWebsiteUrl(pageUrl, href, { page: true })).filter(Boolean),
    assets: [...styles, ...scripts].map((href) => normalizeWebsiteUrl(pageUrl, href)).filter(Boolean)
  };
}

function documentFromWebsiteUrl(sourceId, url, content, contentType, kind) {
  const fallbackExt = kind === "page"
    ? ".html"
    : /css/i.test(contentType)
      ? ".css"
      : ".js";
  const relativePath = websitePathForUrl(url, fallbackExt);
  return {
    sourceId,
    path: relativePath,
    language: languageForPath(relativePath),
    title: cleanOneLine(new URL(url).pathname || url, 140),
    content: `/* Source: ${url} */\n${content}`,
    contentHash: hashText(content),
    summary: summarizeFile(relativePath, content),
    size: Buffer.byteLength(content, "utf8")
  };
}

async function scanWebsite(jobId, source) {
  const metadata = source.metadata_json || {};
  const startUrl = String(metadata.startUrl || source.url);
  const parsedStart = parseWebsiteUrl(startUrl);
  const maxPages = Math.max(1, Math.min(100, Number(metadata.maxPages || config.mlScraperMaxPages)));
  const maxDepth = Math.max(0, Math.min(5, Number(metadata.maxDepth || config.mlScraperMaxDepth)));
  const maxTotalBytes = Math.max(1, config.mlScraperMaxTotalMb) * 1024 * 1024;
  const robotsRules = await loadRobotsRules(jobId, parsedStart.origin);
  const queue = [{ url: parsedStart.url, depth: 0 }];
  const visitedPages = new Set();
  const visitedAssets = new Set();
  const docs = [];
  let totalBytes = 0;

  while (queue.length && visitedPages.size < maxPages) {
    assertNotCanceled(jobId);
    const item = queue.shift();
    if (!item?.url || visitedPages.has(item.url)) continue;
    if (!isSameOrigin(item.url, parsedStart.origin) || shouldSkipWebsiteUrl(item.url) || isRobotsDisallowed(item.url, robotsRules)) continue;
    visitedPages.add(item.url);
    await updateLearningJob(jobId, {
      progress: Math.min(28, 8 + Math.round((visitedPages.size / maxPages) * 20)),
      stage: "crawl",
      message: `Crawling website page ${visitedPages.size}/${maxPages}`
    });
    await appendLearningLog(jobId, "Crawl page", { url: item.url, depth: item.depth });

    let page;
    try {
      page = await fetchWebsiteBuffer(item.url, { accept: "text/html,*/*;q=0.8" });
    } catch (error) {
      await appendLearningLog(jobId, "Skipped page", { url: item.url, error: error.message });
      continue;
    }
    if (!/text\/html|application\/xhtml\+xml/i.test(page.contentType)) continue;
    const html = page.buffer.toString("utf8");
    totalBytes += page.buffer.length;
    if (totalBytes > maxTotalBytes) throw new ValidationError(`Website scrape exceeds ML_SCRAPER_MAX_TOTAL_MB (${config.mlScraperMaxTotalMb}MB)`);
    docs.push(documentFromWebsiteUrl(source.id, item.url, html, page.contentType, "page"));

    const extracted = extractWebsiteLinks(html, item.url);
    for (const assetUrl of extracted.assets) {
      assertNotCanceled(jobId);
      if (visitedAssets.has(assetUrl) || !isSameOrigin(assetUrl, parsedStart.origin) || shouldSkipWebsiteUrl(assetUrl) || isRobotsDisallowed(assetUrl, robotsRules)) continue;
      const ext = path.extname(new URL(assetUrl).pathname).toLowerCase();
      if (ext && !WEBSITE_ASSET_EXTENSIONS.has(ext)) continue;
      visitedAssets.add(assetUrl);
      await appendLearningLog(jobId, "Fetch stylesheet/script", { url: assetUrl });
      try {
        const asset = await fetchWebsiteBuffer(assetUrl, { accept: "text/css,application/javascript,text/javascript,*/*;q=0.5" });
        if (!/css|javascript|ecmascript|text\/plain/i.test(asset.contentType) && ext && !WEBSITE_ASSET_EXTENSIONS.has(ext)) continue;
        const content = asset.buffer.toString("utf8");
        totalBytes += asset.buffer.length;
        if (totalBytes > maxTotalBytes) throw new ValidationError(`Website scrape exceeds ML_SCRAPER_MAX_TOTAL_MB (${config.mlScraperMaxTotalMb}MB)`);
        docs.push(documentFromWebsiteUrl(source.id, assetUrl, content, asset.contentType, "asset"));
      } catch (error) {
        await appendLearningLog(jobId, "Skipped asset", { url: assetUrl, error: error.message });
      }
    }

    if (item.depth < maxDepth) {
      for (const nextUrl of extracted.links) {
        if (queue.length + visitedPages.size >= maxPages * 3) break;
        if (!visitedPages.has(nextUrl) && isSameOrigin(nextUrl, parsedStart.origin) && !shouldSkipWebsiteUrl(nextUrl)) {
          queue.push({ url: nextUrl, depth: item.depth + 1 });
        }
      }
    }
  }

  return { docs, totalBytes };
}

function chunkDocument(doc) {
  const size = Math.max(500, config.mlChunkSize);
  const overlap = Math.max(0, Math.min(config.mlChunkOverlap, Math.floor(size / 2)));
  const step = Math.max(250, size - overlap);
  const text = doc.content.replace(/\r\n/g, "\n");
  const chunks = [];

  for (let start = 0; start < text.length; start += step) {
    const content = text.slice(start, start + size).trim();
    if (content.length < 80) continue;
    chunks.push({
      content,
      summary: cleanOneLine(`${doc.path} chunk ${chunks.length + 1}: ${content.slice(0, 220)}`, 320),
      tokenEstimate: Math.ceil(content.length / 4)
    });
  }

  return chunks;
}

async function createEmbeddings(texts) {
  if (config.mlEmbeddingProvider !== "openai") {
    return texts.map((text) => createLocalHashEmbedding(text));
  }

  const client = getOpenAiOrThrow();
  const embeddings = [];
  for (let index = 0; index < texts.length; index += 64) {
    const batch = texts.slice(index, index + 64);
    const response = await client.embeddings.create({
      model: config.mlEmbeddingModel,
      input: batch
    });
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    embeddings.push(...ordered.map((item) => item.embedding));
  }
  return embeddings;
}

function createLocalHashEmbedding(text) {
  const dimensions = 1536;
  const vector = new Array(dimensions).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const features = [];

  for (let index = 0; index < tokens.length; index += 1) {
    features.push(tokens[index]);
    if (index + 1 < tokens.length) features.push(`${tokens[index]} ${tokens[index + 1]}`);
  }

  for (const feature of features) {
    const hash = createHash("sha256").update(feature).digest();
    const slot = hash.readUInt32BE(0) % dimensions;
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[slot] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new ExternalServiceError("ML skill extraction returned invalid JSON", null, "ML_SKILL_JSON_INVALID");
}

async function extractSkillsForSource(jobId, source) {
  const chunks = await query(
    `SELECT c.id, c.content, c.summary, d.path
     FROM ml_chunks c
     JOIN ml_documents d ON d.id = c.document_id
     WHERE c.source_id=$1
       AND c.enabled=TRUE
       AND LOWER(d.path) NOT LIKE '%readme%'
       AND LOWER(d.path) NOT LIKE '%.md'
     ORDER BY
       CASE
         WHEN d.path ~* '\\.(html|css|scss|js|jsx|ts|tsx|vue|astro|mjs|cjs)$' THEN 0
         ELSE 1
       END,
       c.token_estimate DESC
     LIMIT 24`,
    [source.id]
  );

  if (!chunks.rowCount) return { commentary: "No useful chunks were available for skill extraction.", skills: [] };

  const examples = chunks.rows.map((chunk, index) => ({
    index,
    chunkId: chunk.id,
    path: chunk.path,
    excerpt: chunk.content.slice(0, 1200)
  }));

  const sourceKind = source.source_type === "website"
    ? "website scrape"
    : source.source_type === "snippet"
      ? "pasted code snippet"
      : "GitHub repository";
  const prompt = [
    `You are extracting reusable front-end coding skills from a ${sourceKind}.`,
    "Learn from actual implementation files first: HTML, CSS, JavaScript, TypeScript, JSX, TSX, Vue, Astro, SCSS.",
    "Do not turn README text, marketing copy, dependency metadata, or folder descriptions into skills.",
    "Return only JSON with this exact shape:",
    '{"commentary":"string","skills":[{"name":"string","category":"string","summary":"string","guidance":"string","confidence":0.7,"sourceChunkIds":[1,2]}]}',
    "",
    "Rules:",
    "- Create 3 to 8 practical skills.",
    "- Focus on reusable implementation skills from code structure, CSS layout, DOM behavior, state handling, accessibility, and component patterns.",
    "- guidance must tell KiraAI how to apply the pattern.",
    "- Every skill must be grounded in one or more code examples from the provided chunks.",
    "- sourceChunkIds must use actual chunkId values from the examples.",
    "",
    `Source: ${source.name}`,
    JSON.stringify(examples)
  ].join("\n");

  const payload = await extractSkillPayloadWithCodex(jobId, prompt);
  const allowedIds = new Set(chunks.rows.map((chunk) => Number(chunk.id)));
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  return {
    commentary: cleanOneLine(payload.commentary || "Skill extraction complete.", 600),
    skills: skills
      .map((skill) => ({
        name: cleanOneLine(skill.name, 120),
        category: cleanOneLine(skill.category || "front-end", 80),
        summary: cleanOneLine(skill.summary, 700),
        guidance: cleanOneLine(skill.guidance, 900),
        confidence: Math.max(0.1, Math.min(1, Number(skill.confidence || 0.7))),
        sourceChunkIds: (Array.isArray(skill.sourceChunkIds) ? skill.sourceChunkIds : [])
          .map(Number)
          .filter((id) => allowedIds.has(id))
          .slice(0, 8)
      }))
      .filter((skill) => skill.name && skill.summary && skill.guidance)
      .slice(0, 10)
  };
}

async function extractSkillPayloadWithOpenAi(prompt) {
  const client = getOpenAiOrThrow();
  const response = await client.chat.completions.create({
    model: config.openAiModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You extract concise, reusable programming skills as valid JSON." },
      { role: "user", content: prompt }
    ]
  });
  return parseJsonObject(response.choices[0]?.message?.content || "{}");
}

async function extractSkillPayloadWithCodex(jobId, prompt) {
  await appendLearningLog(jobId, "Running KiraAI skill extraction", { model: config.mlSkillModel });
  return runCodexJsonPrompt(prompt, "KiraAI skill extraction");
}

async function saveSkills(jobId, source, extracted) {
  if (extracted.commentary) {
    await appendLearningLog(jobId, "KiraAI commentary", { commentary: extracted.commentary });
  }
  if (!extracted.skills.length) return [];

  const embeddings = await createEmbeddings(
    extracted.skills.map((skill) => `${skill.name}\n${skill.category}\n${skill.summary}\n${skill.guidance}`)
  );
  const saved = [];
  for (let index = 0; index < extracted.skills.length; index += 1) {
    const skill = extracted.skills[index];
    const row = await query(
      `INSERT INTO ml_skills
       (source_id, name, slug, category, summary, guidance, confidence, embedding, source_chunk_ids, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9::jsonb,$10::jsonb)
       ON CONFLICT (source_id, slug)
       DO UPDATE SET
         name=$2,
         category=$4,
         summary=$5,
         guidance=$6,
         confidence=$7,
         embedding=$8::vector,
         source_chunk_ids=$9::jsonb,
         metadata_json=$10::jsonb,
         enabled=TRUE,
         updated_at=NOW()
       RETURNING *`,
      [
        source.id,
        skill.name,
        slugify(skill.name),
        skill.category,
        skill.summary,
        skill.guidance,
        skill.confidence,
        vectorLiteral(embeddings[index]),
        JSON.stringify(skill.sourceChunkIds),
        JSON.stringify({ extractedAt: nowIso(), sourceUrl: source.url })
      ]
    );
    saved.push(row.rows[0]);
  }
  return saved;
}

async function saveDocumentsAndChunks(jobId, sourceId, docs) {
  await query("DELETE FROM ml_documents WHERE source_id=$1", [sourceId]);
  await query("DELETE FROM ml_skills WHERE source_id=$1", [sourceId]);

  const preparedChunks = [];
  const documents = [];
  for (const doc of docs) {
    const row = await query(
      `INSERT INTO ml_documents
       (source_id, path, language, title, content_hash, summary, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (source_id, path)
       DO UPDATE SET
         language=$3,
         title=$4,
         content_hash=$5,
         summary=$6,
         metadata_json=$7::jsonb,
         enabled=TRUE,
         updated_at=NOW()
       RETURNING *`,
      [
        sourceId,
        doc.path,
        doc.language,
        doc.title,
        doc.contentHash,
        doc.summary,
        JSON.stringify({ size: doc.size })
      ]
    );
    documents.push(row.rows[0]);
    const chunks = chunkDocument(doc);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      preparedChunks.push({
        documentId: row.rows[0].id,
        sourceId,
        chunkIndex,
        ...chunks[chunkIndex],
        path: doc.path
      });
    }
  }

  if (!preparedChunks.length) return { documents, chunks: [] };
  await appendLearningLog(jobId, "Embedding source chunks", { chunks: preparedChunks.length });
  const embeddings = await createEmbeddings(
    preparedChunks.map((chunk) => `${chunk.path}\n${chunk.summary}\n${chunk.content}`)
  );

  const savedChunks = [];
  for (let index = 0; index < preparedChunks.length; index += 1) {
    assertNotCanceled(jobId);
    const chunk = preparedChunks[index];
    const row = await query(
      `INSERT INTO ml_chunks
       (document_id, source_id, chunk_index, content, summary, token_estimate, embedding, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8::jsonb)
       ON CONFLICT (document_id, chunk_index)
       DO UPDATE SET
         content=$4,
         summary=$5,
         token_estimate=$6,
         embedding=$7::vector,
         metadata_json=$8::jsonb,
         enabled=TRUE
       RETURNING *`,
      [
        chunk.documentId,
        chunk.sourceId,
        chunk.chunkIndex,
        chunk.content,
        chunk.summary,
        chunk.tokenEstimate,
        vectorLiteral(embeddings[index]),
        JSON.stringify({ path: chunk.path })
      ]
    );
    savedChunks.push(row.rows[0]);
  }

  return { documents, chunks: savedChunks };
}

async function loadResumeArtifacts(job, sourceId) {
  const since = job?.started_at || job?.created_at;
  if (!since) return null;
  const documents = await query(
    `SELECT *
     FROM ml_documents
     WHERE source_id=$1
       AND enabled=TRUE
       AND updated_at >= $2
     ORDER BY path`,
    [sourceId, since]
  );
  if (!documents.rowCount) return null;
  const documentIds = documents.rows.map((doc) => Number(doc.id));
  const chunks = await query(
    `SELECT *
     FROM ml_chunks
     WHERE source_id=$1
       AND enabled=TRUE
       AND document_id=ANY($2::int[])
       AND embedding IS NOT NULL
     ORDER BY document_id, chunk_index`,
    [sourceId, documentIds]
  );
  if (!chunks.rowCount) return null;
  const totalBytes = documents.rows.reduce((sum, doc) => sum + Number(doc.metadata_json?.size || 0), 0);
  return {
    documents: documents.rows,
    chunks: chunks.rows,
    totalBytes
  };
}

async function runLearningJob(jobId, { resumed = false, reason = "" } = {}) {
  const active = { canceled: false, child: null };
  activeJobs.set(Number(jobId), active);
  let tempDir = "";

  try {
    let job = await claimLearningJobForRun(jobId, { resumed, reason });
    if (!job) return;
    if (!job) throw new NotFoundError("ML learning job not found");
    if (job.status === "canceled") return;
    const source = await getSource(job.source_id);
    assertMlProvidersReady();

    if (resumed || Number(job.resume_count || 0) > 0) {
      await appendLearningLog(jobId, "Resuming KiraAI learning job", {
        resumeCount: job.resume_count,
        reason: reason || job.resume_reason || "server_restart",
        checkpoint: job.stage || "queued"
      });
    }

    const isSnippet = source.source_type === "snippet";
    const isWebsite = source.source_type === "website";
    await updateLearningJob(jobId, {
      status: "running",
      progress: 2,
      stage: isSnippet ? "snippet" : isWebsite ? "validate" : "clone",
      message: isSnippet ? "Preparing pasted code snippet" : isWebsite ? "Validating website" : "Cloning GitHub repository",
      startedAt: job.started_at ? undefined : nowIso()
    });
    await query(
      `UPDATE ml_sources
       SET status='learning',
           archived=FALSE,
           archived_at=NULL,
           archive_reason=NULL,
           last_error=NULL,
           updated_at=NOW()
       WHERE id=$1`,
      [source.id]
    );

    job = await getLearningJobRow(jobId);
    let scanned = null;
    let saved = null;
    const resumeArtifacts = resumed ? await loadResumeArtifacts(job, source.id) : null;
    if (resumeArtifacts) {
      saved = { documents: resumeArtifacts.documents, chunks: resumeArtifacts.chunks };
      scanned = {
        docs: resumeArtifacts.documents,
        totalBytes: resumeArtifacts.totalBytes
      };
      await appendLearningLog(jobId, "Recovered saved vector chunks", {
        files: saved.documents.length,
        chunks: saved.chunks.length,
        bytes: scanned.totalBytes
      });
    } else {
      if (isSnippet) {
        scanned = documentFromSnippet(source, source.id);
        await appendLearningLog(jobId, "Prepared pasted code", { bytes: scanned.totalBytes });
      } else if (isWebsite) {
        await updateLearningJob(jobId, { progress: 6, stage: "validate", message: "Checking website HTML access" });
        await validateWebsiteUrl(source.url);
        await updateLearningJob(jobId, { progress: 10, stage: "crawl", message: "Crawling same-domain website pages" });
        scanned = await scanWebsite(jobId, source);
        if (!scanned.docs.length) throw new ValidationError("No learnable HTML/CSS/JS files found on this website");
        await appendLearningLog(jobId, "Scanned website", { files: scanned.docs.length, bytes: scanned.totalBytes });
      } else {
        await validatePublicGitHubRepo(jobId, source);
        tempDir = await mkdtemp(path.join(tmpdir(), "mcp-ml-mind-"));
        const repoDir = path.join(tempDir, "repo");
        await updateLearningJob(jobId, { progress: 14, stage: "clone", message: "Cloning public GitHub repository" });
        await runCommand(jobId, "git", ["clone", "--depth", "1", "--single-branch", source.url, repoDir], {
          timeoutMs: 180000
        });

        await updateLearningJob(jobId, { progress: 18, stage: "scan", message: "Scanning text and code files" });
        scanned = await scanRepo(jobId, source.id, repoDir);
        if (!scanned.docs.length) throw new ValidationError("No learnable text/code files found in this repository");
        await appendLearningLog(jobId, "Scanned repository", { files: scanned.docs.length, bytes: scanned.totalBytes });
      }

      await updateLearningJob(jobId, {
        progress: 35,
        stage: "embed",
        message: "Building vector memory chunks",
        stats: { files: scanned.docs.length, bytes: scanned.totalBytes }
      });
      saved = await saveDocumentsAndChunks(jobId, source.id, scanned.docs);
      if (!saved.chunks.length) throw new ValidationError("Source did not produce learnable chunks");
      await mergeLearningResumeState(jobId, {
        checkpoint: "chunks_saved",
        savedAt: nowIso(),
        files: saved.documents.length,
        chunks: saved.chunks.length,
        bytes: scanned.totalBytes
      });
    }

    await updateLearningJob(jobId, {
      progress: 74,
      stage: "skills",
      message: "Extracting reusable skills",
      stats: { files: saved.documents.length, chunks: saved.chunks.length, bytes: scanned.totalBytes }
    });
    job = await getLearningJobRow(jobId);
    const resumeState = job?.resume_state || {};
    const extracted = resumeState.extractedSkills
      ? resumeState.extractedSkills
      : await extractSkillsForSource(jobId, source);
    if (!resumeState.extractedSkills) {
      await mergeLearningResumeState(jobId, {
        checkpoint: "skills_extracted",
        extractedAt: nowIso(),
        extractedSkills: extracted
      });
    } else {
      await appendLearningLog(jobId, "Recovered extracted skills", {
        skills: Array.isArray(extracted.skills) ? extracted.skills.length : 0
      });
    }
    const skills = await saveSkills(jobId, source, extracted);
    await mergeLearningResumeState(jobId, {
      checkpoint: "skills_saved",
      savedAt: nowIso(),
      savedSkills: skills.length
    });

    await updateLearningJob(jobId, {
      status: "done",
      progress: 100,
      stage: "done",
      message: "Learning complete",
      stats: {
        files: saved.documents.length,
        chunks: saved.chunks.length,
        skills: skills.length,
        bytes: scanned.totalBytes
      },
      finishedAt: nowIso()
    });
    await query(
      `UPDATE ml_sources
       SET status='learned',
           last_learned_at=NOW(),
           last_error=NULL,
           archived=TRUE,
           archived_at=NOW(),
           archive_reason='Learning complete; skills are available.',
           updated_at=NOW()
       WHERE id=$1`,
      [source.id]
    );
    await appendLearningLog(jobId, "Archived learned source", { sourceId: source.id });
    await appendLearningLog(jobId, "Learning complete", { chunks: saved.chunks.length, skills: skills.length });
  } catch (error) {
    const canceled = error.code === "ML_JOB_CANCELED";
    const job = await getLearningJobRow(jobId).catch(() => null);
    await updateLearningJob(jobId, {
      status: canceled ? "canceled" : "failed",
      progress: canceled ? job?.progress || 0 : 100,
      stage: canceled ? "canceled" : "failed",
      message: canceled ? "Learning canceled" : error.message || "Learning failed",
      error: canceled ? null : { message: error.message, code: error.code || "ML_LEARNING_FAILED", details: error.details || null },
      finishedAt: nowIso()
    }).catch(() => null);
    if (job?.source_id) {
      await query(
        "UPDATE ml_sources SET status=$2, last_error=$3, updated_at=NOW() WHERE id=$1",
        [job.source_id, canceled ? "idle" : "failed", canceled ? null : error.message || "Learning failed"]
      ).catch(() => null);
    }
    await appendLearningLog(jobId, canceled ? "Learning canceled" : "Learning failed", {
      error: error.message,
      code: error.code || "ML_LEARNING_FAILED"
    }).catch(() => null);
  } finally {
    activeJobs.delete(Number(jobId));
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
}

export async function getMlStatus() {
  const totals = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM ml_sources) AS sources,
       (SELECT COUNT(*)::int FROM ml_documents) AS documents,
       (SELECT COUNT(*)::int FROM ml_chunks WHERE enabled=TRUE) AS chunks,
       (SELECT COUNT(*)::int FROM ml_skills WHERE enabled=TRUE) AS enabled_skills,
       (SELECT COUNT(*)::int FROM ml_skills) AS skills,
       (SELECT COUNT(*)::int FROM ml_learning_jobs WHERE status IN ('queued','running')) AS active_jobs`
  );
  return {
    enabled: config.mlMindEnabled,
    aiProvider: config.mlAiProvider,
    embeddingProvider: config.mlEmbeddingProvider,
    openAiConfigured: Boolean(config.openAiApiKey),
    embeddingModel: config.mlEmbeddingModel,
    skillModel: config.mlSkillModel,
    runtimeSelector: config.mlRuntimeSelector,
    selectorTimeoutMs: config.mlSelectorTimeoutMs,
    cacheTtlMs: config.mlMindCacheTtlMs,
    maxRuntimeSkills: runtimeSkillLimit(),
    retrievalLimit: config.mlRetrievalLimit,
    chunkSize: config.mlChunkSize,
    scraper: {
      maxPages: config.mlScraperMaxPages,
      maxDepth: config.mlScraperMaxDepth,
      maxTotalMb: config.mlScraperMaxTotalMb,
      timeoutMs: config.mlScraperTimeoutMs
    },
    totals: totals.rows[0]
  };
}

export async function createSource(rawUrl, options = {}) {
  const parsed = parseGitHubRepoUrl(rawUrl);
  const existing = await query("SELECT * FROM ml_sources WHERE url=$1 LIMIT 1", [parsed.url]);
  if (existing.rowCount) {
    return { ...existing.rows[0], duplicate: true };
  }

  const row = await query(
    `INSERT INTO ml_sources (url, source_type, repo_owner, repo_name, name, input_hash, metadata_json)
     VALUES ($1,'github',$2,$3,$4,$5,$6::jsonb)
     RETURNING *`,
    [parsed.url, parsed.owner, parsed.repo, parsed.name, hashText(parsed.url), JSON.stringify({ htmlUrl: parsed.htmlUrl })]
  );
  const source = { ...row.rows[0], duplicate: false };
  if (options.autoLearn) {
    source.job = await startLearningJob(source.id);
  }
  return source;
}

export async function createSourcesBatch(input, options = {}) {
  const items = parseGitHubRepoInputs(input);
  if (!items.length) throw new ValidationError("At least one GitHub repo URL is required");
  const seen = new Set();
  const created = [];
  const duplicates = [];
  const invalid = [];

  for (const item of items) {
    if (seen.has(item)) {
      duplicates.push({ url: item, reason: "Duplicate in request" });
      continue;
    }
    seen.add(item);
    try {
      const source = await createSource(item, { autoLearn: Boolean(options.autoLearn) });
      if (source.duplicate) duplicates.push(source);
      else created.push(source);
    } catch (error) {
      invalid.push({ url: item, error: error.message });
    }
  }

  return {
    created,
    duplicates,
    invalid,
    totals: {
      requested: items.length,
      created: created.length,
      duplicates: duplicates.length,
      invalid: invalid.length
    }
  };
}

export async function createWebsiteSource(rawUrl, options = {}) {
  const parsed = parseWebsiteUrl(rawUrl);
  const existing = await query("SELECT * FROM ml_sources WHERE url=$1 LIMIT 1", [parsed.url]);
  if (existing.rowCount) {
    return { ...existing.rows[0], duplicate: true };
  }

  await validateWebsiteUrl(parsed.url);
  const metadata = {
    startUrl: parsed.url,
    origin: parsed.origin,
    maxPages: Math.max(1, Math.min(100, Number(options.maxPages || config.mlScraperMaxPages))),
    maxDepth: Math.max(0, Math.min(5, Number(options.maxDepth || config.mlScraperMaxDepth)))
  };
  const row = await query(
    `INSERT INTO ml_sources (url, source_type, repo_owner, repo_name, name, input_hash, metadata_json)
     VALUES ($1,'website',$2,$3,$4,$5,$6::jsonb)
     RETURNING *`,
    [parsed.url, parsed.repoOwner, parsed.repoName, parsed.name, hashText(parsed.url), JSON.stringify(metadata)]
  );
  const source = { ...row.rows[0], duplicate: false };
  if (options.autoLearn) {
    source.job = await startLearningJob(source.id);
  }
  return source;
}

export async function createWebsitesBatch(input, options = {}) {
  const items = parseWebsiteInputs(input);
  if (!items.length) throw new ValidationError("At least one website URL is required");
  const seen = new Set();
  const created = [];
  const duplicates = [];
  const invalid = [];

  for (const item of items) {
    let normalized = item;
    try {
      normalized = parseWebsiteUrl(item).url;
    } catch {}
    if (seen.has(normalized)) {
      duplicates.push({ url: item, reason: "Duplicate in request" });
      continue;
    }
    seen.add(normalized);
    try {
      const source = await createWebsiteSource(item, {
        autoLearn: Boolean(options.autoLearn),
        maxPages: options.maxPages,
        maxDepth: options.maxDepth
      });
      if (source.duplicate) duplicates.push(source);
      else created.push(source);
    } catch (error) {
      invalid.push({ url: item, error: error.message });
    }
  }

  return {
    created,
    duplicates,
    invalid,
    totals: {
      requested: items.length,
      created: created.length,
      duplicates: duplicates.length,
      invalid: invalid.length
    }
  };
}

export async function learnSnippet({ title, language, content }) {
  const code = String(content || "").trim();
  if (!code) throw new ValidationError("Snippet content is required");
  if (code.length > config.mlMaxFileBytes) {
    throw new ValidationError(`Snippet is larger than ML_MAX_FILE_BYTES (${config.mlMaxFileBytes})`);
  }

  const inputHash = hashText(code);
  const sourceUrl = `snippet://${inputHash}`;
  const existing = await query("SELECT * FROM ml_sources WHERE url=$1 LIMIT 1", [sourceUrl]);
  let source;
  let duplicate = false;
  const safeTitle = cleanOneLine(title || "Pasted Code Skill", 140);
  const safeLanguage = normalizeSnippetLanguage(language);
  const metadata = {
    title: safeTitle,
    language: safeLanguage,
    content: code
  };

  if (existing.rowCount) {
    duplicate = true;
    const row = await query(
      `UPDATE ml_sources
       SET name=$2,
           enabled=TRUE,
           metadata_json=$3::jsonb,
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [existing.rows[0].id, safeTitle, JSON.stringify(metadata)]
    );
    source = row.rows[0];
  } else {
    const row = await query(
      `INSERT INTO ml_sources
       (url, source_type, repo_owner, repo_name, name, input_hash, metadata_json)
       VALUES ($1,'snippet','local',$2,$3,$4,$5::jsonb)
       RETURNING *`,
      [sourceUrl, slugify(safeTitle).slice(0, 80) || inputHash.slice(0, 12), safeTitle, inputHash, JSON.stringify(metadata)]
    );
    source = row.rows[0];
  }

  const active = await query(
    "SELECT id FROM ml_learning_jobs WHERE source_id=$1 AND status IN ('queued','running') LIMIT 1",
    [source.id]
  );
  const job = active.rowCount ? await getLearningJob(active.rows[0].id) : await startLearningJob(source.id);
  return { source: { ...source, duplicate }, job, duplicate };
}

export async function getSource(sourceId) {
  const row = await query("SELECT * FROM ml_sources WHERE id=$1 LIMIT 1", [sourceId]);
  if (!row.rowCount) throw new NotFoundError("ML source not found");
  return row.rows[0];
}

export async function listSources({ includeArchived = false } = {}) {
  const rows = await query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM ml_documents d WHERE d.source_id=s.id) AS document_count,
            (SELECT COUNT(*)::int FROM ml_chunks c WHERE c.source_id=s.id) AS chunk_count,
            (SELECT COUNT(*)::int FROM ml_skills k WHERE k.source_id=s.id) AS skill_count
     FROM ml_sources s
     ${includeArchived ? "" : "WHERE s.archived=FALSE"}
     ORDER BY s.created_at DESC`
  );
  return rows.rows;
}

export async function updateSource(sourceId, patch = {}) {
  await getSource(sourceId);
  const name = patch.name === undefined ? null : cleanOneLine(patch.name, 160);
  const enabled = patch.enabled === undefined ? null : Boolean(patch.enabled);
  const row = await query(
    `UPDATE ml_sources
     SET name=COALESCE($2, name),
         enabled=COALESCE($3, enabled),
         updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [sourceId, name || null, enabled]
  );
  return row.rows[0];
}

export async function deleteSource(sourceId) {
  const running = await query(
    "SELECT id FROM ml_learning_jobs WHERE source_id=$1 AND status IN ('queued','running') LIMIT 1",
    [sourceId]
  );
  if (running.rowCount) throw new ValidationError("Cancel the running learning job before deleting this source");
  await query("DELETE FROM ml_sources WHERE id=$1", [sourceId]);
  return { deleted: true, id: Number(sourceId) };
}

export async function startLearningJob(sourceId) {
  const source = await getSource(sourceId);
  if (!source.enabled) throw new ValidationError("Enable this ML source before starting learning");
  const existing = await query(
    "SELECT id FROM ml_learning_jobs WHERE source_id=$1 AND status IN ('queued','running') LIMIT 1",
    [sourceId]
  );
  if (existing.rowCount) return getLearningJob(existing.rows[0].id);

  const row = await query(
    `INSERT INTO ml_learning_jobs (source_id, status, progress, stage, message)
     VALUES ($1,'queued',0,'queued','Queued')
     RETURNING *`,
    [sourceId]
  );
  const job = row.rows[0];
  void runLearningJob(job.id);
  return job;
}

export async function listLearningJobs(limit = 30, offset = 0, { includeFinished = false } = {}) {
  const rows = await query(
    `SELECT j.*, s.name AS source_name, s.url AS source_url
     FROM ml_learning_jobs j
     JOIN ml_sources s ON s.id = j.source_id
     ${includeFinished ? "" : "WHERE j.status IN ('queued','running')"}
     ORDER BY j.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.rows;
}

export async function getLearningJob(jobId) {
  const job = await getLearningJobRow(jobId);
  if (!job) throw new NotFoundError("ML learning job not found");
  return job;
}

export async function cancelLearningJob(jobId) {
  const job = await getLearningJob(jobId);
  if (!["queued", "running"].includes(job.status)) return job;
  const active = activeJobs.get(Number(jobId));
  if (active) {
    active.canceled = true;
    active.child?.kill("SIGTERM");
  }
  return updateLearningJob(jobId, {
    status: "canceled",
    stage: "canceled",
    message: "Learning canceled",
    finishedAt: nowIso()
  });
}

export function registerMlJobEvents(req, res) {
  const jobId = String(req.params.id || "");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  if (!eventClients.has(jobId)) eventClients.set(jobId, new Set());
  eventClients.get(jobId).add(res);
  res.write("event: ml-job\n");
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    eventClients.get(jobId)?.delete(res);
  });
}

export async function listSkills({ limit = 100, offset = 0, enabled = "" } = {}) {
  const params = [];
  const where = [];
  if (enabled !== "") {
    params.push(enabled === true || enabled === "true");
    where.push(`k.enabled=$${params.length}`);
  }
  params.push(limit, offset);
  const rows = await query(
    `SELECT k.*, s.name AS source_name, s.url AS source_url
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY k.enabled DESC, k.usage_count DESC, k.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

export async function getSkill(skillId) {
  const row = await query(
    `SELECT k.*, s.name AS source_name, s.url AS source_url
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     WHERE k.id=$1
     LIMIT 1`,
    [skillId]
  );
  if (!row.rowCount) throw new NotFoundError("ML skill not found");
  const skill = row.rows[0];
  const ids = Array.isArray(skill.source_chunk_ids) ? skill.source_chunk_ids.map(Number).filter(Boolean) : [];
  let chunks = [];
  if (ids.length) {
    const chunkRows = await query(
      `SELECT c.id, c.summary, c.content, d.path
       FROM ml_chunks c
       JOIN ml_documents d ON d.id = c.document_id
       WHERE c.id = ANY($1::int[])
       ORDER BY c.id`,
      [ids]
    );
    chunks = chunkRows.rows;
  }
  return { ...skill, sourceChunks: chunks };
}

export async function updateSkill(skillId, patch = {}) {
  await getSkill(skillId);
  const enabled = patch.enabled === undefined ? null : Boolean(patch.enabled);
  const row = await query(
    `UPDATE ml_skills
     SET enabled=COALESCE($2, enabled), updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [skillId, enabled]
  );
  return row.rows[0];
}

export async function deleteSkill(skillId) {
  await query("DELETE FROM ml_skills WHERE id=$1", [skillId]);
  return { deleted: true, id: Number(skillId) };
}

function buildMindContext({ skills }) {
  if (!skills.length) return "";
  const lines = [
    "## Selected KiraAI Skills",
    "- Use these learned implementation skills when they fit the requested change."
  ];

  for (const skill of skills.slice(0, runtimeSkillLimit())) {
    lines.push(`- ${cleanOneLine(skill.name, 100)}: ${cleanOneLine(skill.summary, 220)}`);
    lines.push(`  Apply: ${cleanOneLine(skill.guidance, 320)}`);
  }

  return lines.join("\n");
}

function serializeRetrievedSkill(skill) {
  const { embedding: _embedding, ...rest } = skill;
  return rest;
}

function runtimeSkillLimit() {
  return Math.max(1, Math.min(5, Number(config.mlMindMaxRuntimeSkills || 3)));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ExternalServiceError(message, null, "ML_MIND_TIMEOUT")), Math.max(250, timeoutMs));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function promptIntent(promptText) {
  const text = String(promptText || "").toLowerCase();
  const wantsLogin = /\b(login|log in|signin|sign in|auth|authentication|password|account access|inloggen|aanmelden|wachtwoord)\b/.test(text);
  const wantsSaasProduct = /\b(saas|dashboard|admin|backoffice|webapp|web app|product ui|app ui|filebrowser|file browser|file manager|files app|file app|file list|folders?|storage|drive|workspace|document manager)\b/.test(text);
  const wantsBackend = /\b(backend|back-end|server-side|server side|server\.js|express|node server|api server|middleware|controller|controllers|service layer|services|request handler|response handler)\b/.test(text);
  const wantsApiRoutes = /\b(rest|endpoint|endpoints|api route|api routes|route|routes|router|controller|controllers|crud|http method|get route|post route|put route|delete route)\b/.test(text) ||
    (/\bapi\b/.test(text) && /\b(backend|server|route|routes|endpoint|endpoints|rest|crud|express|database|sql|controller)\b/.test(text));
  const wantsDatabase = /\b(sql|database|databases|db|postgres|postgresql|mysql|sqlite|schema\.sql|schema|migration|migrations|table|tables|column|columns|primary key|foreign key|seed|seeding|query builder)\b/.test(text);
  const wantsFullStackScaffold = /\b(full stack|full-stack|scaffold|scaffolding|project structure|folder structure|backend structure|frontend structure|frontend\/backend|frontend and backend|backend and frontend|vite.*express|express.*vite|docker compose|docker-compose)\b/.test(text);
  const wantsBackendWorkflow = wantsBackend || wantsApiRoutes || wantsDatabase || wantsFullStackScaffold;
  const wantsProfileCard = (
    /\b(profile|user)\b/.test(text) &&
    /\b(card|component|ui)\b/.test(text)
  );
  const hasProductCartWords = /\b(product|products|product card|cart|add to cart|shopping cart|winkelwagen|producten)\b/.test(text);
  const wantsProductCart = hasProductCartWords || (!wantsLogin && /\b(ecommerce|e-commerce|webshop)\b/.test(text));
  const wantsPortfolioFilter = /\b(portfolio|project|projects|category filter|filters|filter|categorie|projecten)\b/.test(text);
  const wantsMobileNav = /\b(mobile nav|mobile navigation|hamburger|navbar|navigation menu|nav menu|sidebar|drawer|off canvas|off-canvas|navigatie|menu)\b/.test(text);
  const wantsGalleryOverlay = /\b(gallery|image gallery|galerij|afbeelding|image|photo|foto|overlay|hover overlay)\b/.test(text) && /\b(card|cards|gallery|galerij|overlay|hover)\b/.test(text);
  const wantsNewsletter = /\b(newsletter|nieuwsbrief|signup|sign up|subscribe|inschrijven|email signup)\b/.test(text);
  return {
    wantsLogin,
    wantsModal: /\b(modal|dialog|popup|pop-up)\b/.test(text),
    wantsSaasProduct,
    wantsProfileCard,
    wantsCardUi: /\b(card|profile card|user card|component|ui|layout)\b/.test(text),
    wantsSingleCard: /\bcard\b/.test(text) && !/\b(cards|grid|list|collection|pricing|plans|products)\b/.test(text),
    wantsSocialAuth: /\b(social login|google login|facebook login|oauth|sso|social auth)\b/.test(text),
    wantsSocialLinks: /\b(social link|social links|social icon|social icons|socials|linkedin|twitter|x link|instagram|facebook|github profile)\b/.test(text),
    wantsExplicitHover: /\b(hover|zoom|grayscale|overlay|media effect|image effect|image reveal|portfolio effect)\b/.test(text),
    wantsContact: /\b(contact|phone|location|message|textarea|bericht|telefoon|locatie)\b/.test(text),
    wantsPricing: /\b(pricing|price card|price cards|price|plans|subscription|prijzen|prijs|abonnement)\b/.test(text),
    wantsProductCart,
    wantsProject: wantsPortfolioFilter || /\b(project|portfolio|gallery|work cards)\b/.test(text),
    wantsPortfolioFilter,
    wantsMobileNav,
    wantsGalleryOverlay,
    wantsNewsletter,
    wantsBackend,
    wantsApiRoutes,
    wantsDatabase,
    wantsFullStackScaffold,
    wantsBackendWorkflow,
    wantsDataModel: /\b(type|types|typescript|interface|class|schema|model|data model|state model|store|database)\b/.test(text),
    wantsTheme: /\b(theme|theming|dark mode|light mode|color system|css variable|custom propert|design token|palette|thema|donker|licht)\b/.test(text),
    wantsState: /\b(state|filter|toggle|tabs|search|sort|fetch|api|dynamic|interactive|interaction)\b/.test(text),
    wantsForm: wantsLogin || /\b(form|formulier|input|label|submit|required|email field|validatie|validation)\b/.test(text)
  };
}

function skillText(skill) {
  return [
    skill.name,
    skill.category,
    skill.summary,
    skill.guidance
  ].join(" ").toLowerCase();
}

function skillTitleText(skill) {
  return [skill.name, skill.category].join(" ").toLowerCase();
}

function isFormImplementationSkill(skill) {
  const title = skillTitleText(skill);
  const text = skillText(skill);
  if (/\b(playwright|e2e|workflow assertions|integration testing)\b/.test(text)) return false;
  if (/\b(contact|newsletter|booking|search)\b/.test(title)) return false;
  if (/\b(modal|dialog|popup)\b/.test(title)) return false;
  if (/\b(modal|dialog|popup)\b/.test(text) && !/\b(input|label|required|email|password|submit|focus)\b/.test(text)) return false;
  return (
    /\b(form|forms|form controls|form ux|forms\/accessibility|checkbox)\b/.test(title) ||
    (/\b(form|input|label|required|submit|password|email)\b/.test(text) && /\b(label|input|required|submit|button|focus)\b/.test(text))
  );
}

function isProfileImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(type|typescript|data model|pricing|contact|project grid)\b/.test(text)) return false;
  return /\b(profile|avatar|portrait|social|profile image|circular image)\b/.test(text);
}

function isProductAppNoiseSkill(skill) {
  const text = skillText(skill);
  return /\b(portfolio|personal portfolio|project grid|project summary|project card|projects|gallery|work card|hover effects|media hover|image zoom|zoom effect|grayscale|color inversion|social link|social links|social navigation|social icon|scroll reveal|scrollable content|content strip|localstorage|notes rendering|seo|canonical|twitter|social preview|page metadata|meta partial|related posts|post previews|blog|article|content-driven|personal site|about section|hero section|animation|animated|game|audio|web audio|canvas|asset optimization|astro asset|education|course card|course|school)\b/.test(text);
}

function isButtonActionSkill(skill) {
  const title = skillTitleText(skill);
  const text = skillText(skill);
  if (/\b(social|icon-only|navigation|navbar|scroll|project|portfolio)\b/.test(text)) return false;
  return /\b(button variant|submit button|cta button|form button|btn|primary action|call-to-action|submit)\b/.test(title + " " + text);
}

function isLoginImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(contact form|newsletter|booking|pricing|portfolio|project grid|gallery|game|calculator|social link|social links|profile image|avatar)\b/.test(text)) return false;
  const hasAuth = /\b(login|log in|auth|authentication|password|email|credential|credentials)\b/.test(text);
  const hasForm = /\b(form|input|field|label|submit|button|checkbox|required|focus|accessibility|select)\b/.test(text);
  const hasShell = /\b(card|panel|shell|layout|responsive|centered|setup screen|setup screens)\b/.test(text);
  return (hasAuth && (hasForm || hasShell)) ||
    (/\b(password|email)\b/.test(text) && /\b(form|input|field|label|submit|required)\b/.test(text));
}

function isLabeledFormControlSkill(skill) {
  const text = skillText(skill);
  if (/\b(fetch|server component|server components|data loading|async server|profile-style data)\b/.test(text)) return false;
  if (/\b(contact form|newsletter|booking|pricing|portfolio|project grid|gallery|game|calculator)\b/.test(text)) return false;
  return /\b(label|labels|labeled|aria-label)\b/.test(text) &&
    /\b(form|forms|form controls|input|inputs|field|fields|select|control|required)\b/.test(text);
}

function isGenericLoginNoiseSkill(skill) {
  const text = skillText(skill);
  if (/\b(fetch|server component|server components|useeffect|data loading|async server|profile-style data)\b/.test(text)) return true;
  if (/\b(action grid|resource list|card-container|card rows)\b/.test(text) && !isLoginImplementationSkill(skill)) return true;
  if (isLoginImplementationSkill(skill) || isFormImplementationSkill(skill) || isButtonActionSkill(skill)) return false;
  return false;
}

function isPricingImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(contact|login|auth|profile|portfolio|project|game|calculator|newsletter)\b/.test(text)) return false;
  return /\b(pricing|price|prices|plan|plans|subscription|equal-height|cta|card-internal|pricing-card)\b/.test(text);
}

function isContactImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(newsletter|login|auth|pricing|project|portfolio|game|calculator|booking)\b/.test(text)) return false;
  return /\b(contact|contact form|message|textarea|email|name|form|label|required|validation)\b/.test(text);
}

function isProductCartImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(profile|contact|pricing|portfolio|game|calculator|newsletter)\b/.test(text)) return false;
  return /\b(product|products|cart|add to cart|shopping|ecommerce|modal|catalog|inventory|render product|product card)\b/.test(text);
}

function isPortfolioImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(login|auth|pricing|contact form|newsletter|game|calculator|product cart)\b/.test(text)) return false;
  return /\b(portfolio|project|projects|category|filter|gallery|work card|card grid|hover-reveal)\b/.test(text);
}

function isThemeImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(pricing|contact|game|calculator|portfolio grid)\b/.test(text)) return false;
  return /\b(theme|theming|dark|light|css custom propert|css variable|design token|color-scheme|aria switch|toggle)\b/.test(text);
}

function isMobileNavImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(pricing|profile card|contact form|game|calculator|product card)\b/.test(text)) return false;
  return /\b(mobile|hamburger|navigation|navbar|nav drawer|sidebar|off-canvas|slide-in|expanded-state|menu item)\b/.test(text);
}

function isGalleryOverlayImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(login|pricing|contact form|game|calculator|newsletter)\b/.test(text)) return false;
  return /\b(gallery|image|photo|card|overlay|hover|focus-within|zoom|dimming|media)\b/.test(text);
}

function isNewsletterImplementationSkill(skill) {
  const text = skillText(skill);
  if (/\b(contact|login|pricing|profile|portfolio|game|calculator|booking)\b/.test(text)) return false;
  return /\b(newsletter|subscribe|signup|email input|email form|submit button|inline newsletter|form)\b/.test(text);
}

function isBackendNoiseSkill(skill) {
  const text = skillText(skill);
  return /\b(profile card|pricing card|product card|contact form|newsletter|portfolio|project grid|gallery|image hover|media hover|grayscale|avatar|social link|mobile nav|hamburger|theme toggle|hero section|animation|game|canvas|calculator|blog|article|playwright|e2e|frontend e2e|front-end routes|frontend routes|front end|front-end|frontend data|client-side|client side|api[- ]client|api loader|api loaders|react query|data hook|front end assets|deployed client|protocol message|message frame|frame dispatch|navigation|tab state|feature card|modal form|react hook form|toast|cache invalidation|onboarding form|metadata form|sortable table|table header|browser blob|xhr transport|prototype methods|syntax token|highlight token|fixed-card grids|field type)\b/.test(text);
}

function isApiRouteImplementationSkill(skill) {
  const text = skillText(skill);
  if (isBackendNoiseSkill(skill)) return false;
  const hasRouteShape = /\b(api|rest|endpoint|endpoints|route|routes|router|resource route|url shape|crud)\b/.test(text);
  const hasBackendAnchor = /\b(express|backend|server|middleware|controller|controllers|request|response|request object|handler|handlers|status code|status codes|http method|route-specific|api route|resource route|req|res)\b/.test(text);
  return hasRouteShape && hasBackendAnchor;
}

function isBackendImplementationSkill(skill) {
  const text = skillText(skill);
  if (isBackendNoiseSkill(skill)) return false;
  return /\b(backend|back-end|server|server-side|express|node server|middleware|controller|service layer|request handler|response handler|api server|environment config|config\.js|cors|error handler|authorization middleware|route middleware)\b/.test(text);
}

function isDatabaseImplementationSkill(skill) {
  const text = skillText(skill);
  if (isBackendNoiseSkill(skill)) return false;
  return /\b(sql|database|db connection|postgres|postgresql|mysql|sqlite|schema\.sql|migration|migrations|primary key|foreign key|query builder|transaction|connection pool|pool)\b/.test(text);
}

function isFullStackStructureSkill(skill) {
  const text = skillText(skill);
  if (isBackendNoiseSkill(skill)) return false;
  return /\b(full stack|full-stack|scaffold|scaffolding|project structure|folder structure)\b/.test(text) ||
    (/\b(frontend|front-end|react|vite)\b/.test(text) && /\b(backend|back-end|express|server|api|database|sql)\b/.test(text)) ||
    (/\b(docker-compose|docker compose|\.env\.example|readme)\b/.test(text) && /\b(backend|api|database|frontend)\b/.test(text));
}

function isSkillCompatibleWithPrompt(promptText, skill) {
  const intent = promptIntent(promptText);
  const text = skillText(skill);

  if (intent.wantsFullStackScaffold) {
    return isFullStackStructureSkill(skill) ||
      isBackendImplementationSkill(skill) ||
      isApiRouteImplementationSkill(skill) ||
      isDatabaseImplementationSkill(skill);
  }

  if (intent.wantsDatabase && !intent.wantsCardUi && !intent.wantsProfileCard && !intent.wantsLogin) {
    return isDatabaseImplementationSkill(skill);
  }

  if (intent.wantsApiRoutes && !intent.wantsCardUi && !intent.wantsProfileCard && !intent.wantsLogin) {
    return isApiRouteImplementationSkill(skill) || isBackendImplementationSkill(skill);
  }

  if (intent.wantsBackend && !intent.wantsCardUi && !intent.wantsProfileCard && !intent.wantsLogin) {
    return isBackendImplementationSkill(skill) || isApiRouteImplementationSkill(skill) || isDatabaseImplementationSkill(skill);
  }

  if (!intent.wantsBackendWorkflow && !intent.wantsState) {
    if (isBackendImplementationSkill(skill) || isApiRouteImplementationSkill(skill) || isDatabaseImplementationSkill(skill)) return false;
  }

  const isDataModelSkill = /\b(type|typescript|interface|class|schema|modeling|data model|profile data)\b/.test(text);
  if (isDataModelSkill && !intent.wantsDataModel) return false;

  const isPricingSkill = /\b(pricing|price|prices|plan|plans|subscription)\b/.test(text);
  if (isPricingSkill && !intent.wantsPricing) return false;

  const isContactSkill = /\b(contact|contact__|phone|location|textarea|message field|contact card|contact form)\b/.test(text);
  if (isContactSkill && !intent.wantsContact) return false;

  if (intent.wantsLogin) {
    if (!intent.wantsModal && /\b(modal|dialog|popup)\b/.test(text)) return false;
    if (!intent.wantsSocialAuth && /\b(social link|social links|social navigation|social icon|profile image|avatar|profile card)\b/.test(text)) return false;
    if (isGenericLoginNoiseSkill(skill)) return false;
    const clearlyUnrelated = /\b(game|canvas|calculator|board|timer|matching|memory card|project|portfolio|gallery|navigation|search|newsletter|booking|social link|profile image|avatar)\b/.test(text);
    if (clearlyUnrelated && !isLoginImplementationSkill(skill) && !isFormImplementationSkill(skill) && !isButtonActionSkill(skill) && !/\b(button|focus|input)\b/.test(text)) return false;
    const hasAuthOrCredential = /\b(login|auth|authentication|password|email|credential|credentials)\b/.test(text);
    const hasControlPattern = /\b(form|input|field|label|submit|button|checkbox|select)\b/.test(text) ||
      (/\b(focus|required|accessibility)\b/.test(text) && /\b(form|input|field|label|submit|button)\b/.test(text));
    const hasLoginSpecificPattern = hasAuthOrCredential && hasControlPattern;
    const hasLoginShellPattern = /\b(card|panel|shell|layout|responsive)\b/.test(text) &&
      /\b(login|auth|password|email|form|input|label|submit)\b/.test(text);
    return isLoginImplementationSkill(skill) || hasLoginSpecificPattern || hasLoginShellPattern || isFormImplementationSkill(skill) || isButtonActionSkill(skill);
  }

  if (intent.wantsProfileCard) {
    const isSocialLinkSkill = /\b(social link|social links|social navigation|social icon|button-like social)\b/.test(text);
    const isPortfolioMediaSkill = /\b(portfolio|personal portfolio|project grid|gallery|work card|hover effects|media hover|image zoom|zoom effect|grayscale|color inversion)\b/.test(text);
    if (/\b(blog|article|content-driven|seo|canonical|twitter|related posts|post previews|project summary|build tooling)\b/.test(text)) return false;
    if (!intent.wantsExplicitHover && /\b(scroll reveal|scrollable content|content strip|animation|animated)\b/.test(text)) return false;

    if (intent.wantsSaasProduct) {
      if (isProductAppNoiseSkill(skill)) return false;
      if (isPortfolioMediaSkill) return false;
      if (isSocialLinkSkill && !intent.wantsSocialLinks) return false;
      if (/\b(hover|overlay|zoom|grayscale|color inversion)\b/.test(text) && !intent.wantsExplicitHover) return false;
      const hasProfileOrAccountPattern = /\b(profile|avatar|profile image|circular image|account|metadata|settings|status|badge|quota|storage)\b/.test(text) ||
        (/\buser\b/.test(text) && /\b(card|profile|account|avatar)\b/.test(text));
      const hasProductCardLayoutPattern = /\b(card|component|layout|grid|flex|responsive|css custom propert|css variable|design token|theme)\b/.test(text) &&
        /\b(profile|avatar|account|metadata|settings|status|badge|quota|storage)\b/.test(text);
      return hasProfileOrAccountPattern || hasProductCardLayoutPattern;
    }

    if (!intent.wantsExplicitHover && isPortfolioMediaSkill) return false;
    return /\b(profile|avatar|social|image|media|card|component|layout|flex|responsive|button|action link|hover)\b/.test(text);
  }

  if (intent.wantsPricing) return isPricingImplementationSkill(skill);
  if (intent.wantsProductCart) return isProductCartImplementationSkill(skill);
  if (intent.wantsPortfolioFilter) return isPortfolioImplementationSkill(skill);
  if (intent.wantsNewsletter) return isNewsletterImplementationSkill(skill);
  if (intent.wantsContact) return isContactImplementationSkill(skill);
  if (intent.wantsMobileNav) return isMobileNavImplementationSkill(skill);
  if (intent.wantsGalleryOverlay) return isGalleryOverlayImplementationSkill(skill);

  const isThemeOnlySkill = /\b(theme|theming|css custom propert|css variable|design token|color system|palette)\b/.test(text);
  const hasConcreteUiPattern = /\b(card|component|layout|grid|flex|responsive|avatar|image|media|profile|overlay|hover)\b/.test(text);
  if (isThemeOnlySkill && !intent.wantsTheme && !hasConcreteUiPattern) return false;

  if (intent.wantsTheme) return isThemeImplementationSkill(skill);

  if (intent.wantsCardUi) {
    return /\b(card|component|layout|grid|flex|responsive|avatar|image|media|profile|overlay|hover)\b/.test(text);
  }

  if (!intent.wantsState && /\b(fetch|api|state machine|reducer|store)\b/.test(text) && !hasConcreteUiPattern) {
    return false;
  }

  return true;
}

function scoreSkillForPrompt(promptText, skill) {
  const intent = promptIntent(promptText);
  const text = skillText(skill);
  const promptWords = new Set(
    String(promptText || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  );

  let score = Number(skill.similarity || 0);
  for (const word of promptWords) {
    if (text.includes(word)) score += 0.04;
  }

  if (intent.wantsBackendWorkflow && isBackendNoiseSkill(skill)) score -= 0.65;
  if (intent.wantsFullStackScaffold && isFullStackStructureSkill(skill)) score += 0.75;
  if (intent.wantsFullStackScaffold && (isBackendImplementationSkill(skill) || isApiRouteImplementationSkill(skill) || isDatabaseImplementationSkill(skill))) score += 0.35;
  if (intent.wantsBackend && isBackendImplementationSkill(skill)) score += 0.65;
  if (intent.wantsApiRoutes && isApiRouteImplementationSkill(skill)) score += 0.7;
  if (intent.wantsDatabase && isDatabaseImplementationSkill(skill)) score += 0.75;
  if (intent.wantsBackendWorkflow && /\b(api|route|endpoint|express|backend|database|sql|migration|schema|docker|env|frontend)\b/.test(text)) score += 0.12;
  if (!intent.wantsBackendWorkflow && !intent.wantsState && (isBackendImplementationSkill(skill) || isApiRouteImplementationSkill(skill) || isDatabaseImplementationSkill(skill))) score -= 0.55;

  if (intent.wantsCardUi && /\b(card|cards)\b/.test(text)) score += 0.18;
  if (intent.wantsCardUi && /\b(grid|flex|layout|responsive|component|avatar|image|media|profile)\b/.test(text)) score += 0.08;
  if (intent.wantsProfileCard && /\b(profile|avatar|social|user|portrait)\b/.test(text)) score += 0.28;
  if (intent.wantsProfileCard && /\b(project|portfolio|pricing|contact)\b/.test(text)) score -= 0.18;
  if (intent.wantsSaasProduct && intent.wantsProfileCard && /\b(card|layout|responsive|grid|flex|component|profile|user|avatar|account|metadata|settings|status|badge|storage|file)\b/.test(text)) score += 0.18;
  if (intent.wantsSaasProduct && isProductAppNoiseSkill(skill)) score -= 0.7;
  if (intent.wantsSaasProduct && !intent.wantsSocialLinks && /\b(social link|social links|social navigation|social icon)\b/.test(text)) score -= 0.45;
  if (intent.wantsSaasProduct && !intent.wantsExplicitHover && /\b(hover effects|image zoom|zoom effect|grayscale|color inversion|media hover|gallery overlay)\b/.test(text)) score -= 0.45;
  if (intent.wantsLogin && isLoginImplementationSkill(skill)) score += 0.85;
  if (intent.wantsLogin && isGenericLoginNoiseSkill(skill)) score -= 0.8;
  if (intent.wantsLogin && isFormImplementationSkill(skill)) score += 0.6;
  if (intent.wantsLogin && isButtonActionSkill(skill)) score += 0.28;
  if (intent.wantsLogin && /\b(form|input|label|submit|button|focus|required|email|password|accessibility|checkbox)\b/.test(text)) score += 0.3;
  if (intent.wantsLogin && /\b(card|panel|modal|shell|layout|responsive)\b/.test(text)) score += 0.12;
  if (intent.wantsLogin && /\b(game|canvas|calculator|board|timer|matching|memory card|contact|phone|location|textarea|pricing|project|portfolio|gallery|navigation|search|newsletter|booking|social|profile|avatar)\b/.test(text)) score -= 0.35;
  if (intent.wantsSingleCard && /\b(grid|collection|repeated|pricing grid|card grid|cards)\b/.test(text)) score -= 0.08;
  if (intent.wantsPricing && isPricingImplementationSkill(skill)) score += 0.55;
  if (intent.wantsContact && isContactImplementationSkill(skill)) score += 0.5;
  if (intent.wantsProductCart && isProductCartImplementationSkill(skill)) score += 0.65;
  if (intent.wantsPortfolioFilter && isPortfolioImplementationSkill(skill)) score += 0.55;
  if (intent.wantsTheme && isThemeImplementationSkill(skill)) score += 0.55;
  if (intent.wantsMobileNav && isMobileNavImplementationSkill(skill)) score += 0.55;
  if (intent.wantsGalleryOverlay && isGalleryOverlayImplementationSkill(skill)) score += 0.55;
  if (intent.wantsNewsletter && isNewsletterImplementationSkill(skill)) score += 0.6;
  if (intent.wantsTheme && /\b(theme|css custom propert|css variable|design token|color system)\b/.test(text)) score += 0.14;
  if (intent.wantsDataModel && /\b(type|typescript|interface|class|schema|model)\b/.test(text)) score += 0.14;

  if (!isSkillCompatibleWithPrompt(promptText, skill)) score -= 1;
  return score;
}

function rankSkillsForPrompt(promptText, skills) {
  return [...skills]
    .map((skill) => ({ skill, score: scoreSkillForPrompt(promptText, skill) }))
    .filter((item) => item.score > -0.5)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.skill);
}

function ensureIntentCoverage(promptText, selectedSkills, rankedSkills) {
  const intent = promptIntent(promptText);
  const selected = [...selectedSkills];
  const selectedIds = new Set(selected.map((skill) => Number(skill.id)));

  const addBest = (classifier, { prepend = false } = {}) => {
    if (selected.some(classifier)) return;
    const skill = rankedSkills.find((item) => classifier(item) && isSkillCompatibleWithPrompt(promptText, item));
    if (!skill || selectedIds.has(Number(skill.id))) return;
    if (prepend) selected.unshift(skill);
    else selected.push(skill);
    selectedIds.add(Number(skill.id));
  };

  if (intent.wantsPricing) addBest(isPricingImplementationSkill, { prepend: true });
  if (intent.wantsContact) addBest(isContactImplementationSkill, { prepend: true });
  if (intent.wantsProductCart) addBest(isProductCartImplementationSkill, { prepend: true });
  if (intent.wantsPortfolioFilter) addBest(isPortfolioImplementationSkill, { prepend: true });
  if (intent.wantsTheme) addBest(isThemeImplementationSkill, { prepend: true });
  if (intent.wantsMobileNav) addBest(isMobileNavImplementationSkill, { prepend: true });
  if (intent.wantsGalleryOverlay) addBest(isGalleryOverlayImplementationSkill, { prepend: true });
  if (intent.wantsNewsletter) addBest(isNewsletterImplementationSkill, { prepend: true });
  if (intent.wantsFullStackScaffold) addBest(isFullStackStructureSkill, { prepend: true });
  if (intent.wantsBackend) addBest(isBackendImplementationSkill, { prepend: true });
  if (intent.wantsApiRoutes) addBest(isApiRouteImplementationSkill, { prepend: true });
  if (intent.wantsDatabase) addBest(isDatabaseImplementationSkill, { prepend: true });
  if (intent.wantsLogin) addBest(isLoginImplementationSkill, { prepend: true });
  if (intent.wantsLogin) addBest(isLabeledFormControlSkill, { prepend: true });

  if (intent.wantsLogin && !selected.some(isFormImplementationSkill)) {
    const formSkill = rankedSkills.find((skill) => isFormImplementationSkill(skill) && isSkillCompatibleWithPrompt(promptText, skill));
    if (formSkill && !selectedIds.has(Number(formSkill.id))) {
      selected.unshift(formSkill);
      selectedIds.add(Number(formSkill.id));
    }
  }

  if (intent.wantsLogin && !selected.some(isButtonActionSkill)) {
    const buttonSkill = rankedSkills.find((skill) => isButtonActionSkill(skill) && isSkillCompatibleWithPrompt(promptText, skill));
    if (buttonSkill && !selectedIds.has(Number(buttonSkill.id))) {
      selected.push(buttonSkill);
      selectedIds.add(Number(buttonSkill.id));
    }
  }

  if (intent.wantsProfileCard && !selected.some((skill) => isProfileImplementationSkill(skill) && isSkillCompatibleWithPrompt(promptText, skill))) {
    const profileSkill = rankedSkills.find((skill) => isProfileImplementationSkill(skill) && isSkillCompatibleWithPrompt(promptText, skill));
    if (profileSkill && !selectedIds.has(Number(profileSkill.id))) {
      selected.unshift(profileSkill);
    }
  }

  return selected.slice(0, 5);
}

async function loadIntentSkillRows(promptText, existingIds = []) {
  const intent = promptIntent(promptText);
  const conditions = [];
  const ordering = [];

  if (intent.wantsLogin) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(login|auth|form controls|form|label|submit|required|password|email|button variant|checkbox|focus)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(structured form|form controls|labeled.*form|label|required|password|email|submit|floating label)' THEN 0");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(button variant|button|checkbox|focus)' THEN 1");
  }

  if (intent.wantsProfileCard) {
    if (intent.wantsSaasProduct) {
      conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(profile|user|avatar|portrait|card|component|layout|grid|flex|responsive|account|settings|status|badge|storage|file|css custom propert|css variable)'");
      ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(profile|user|avatar|profile image|circular image)' THEN 0");
      ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(card|component|layout|grid|flex|responsive|css variable|css custom propert)' THEN 1");
    } else {
      conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(profile|avatar|portrait|social|action link|circular image|profile image)'");
      ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(profile|avatar|portrait|social|profile image)' THEN 0");
    }
  }

  if (intent.wantsPricing) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(pricing|price|prices|plan|plans|subscription|equal-height|card-internal|cta)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(pricing|price|plan|plans|subscription)' THEN 0");
  }

  if (intent.wantsContact) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(contact|message|textarea|email|name field|form|label|required|validation)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(contact|message|textarea)' THEN 0");
  }

  if (intent.wantsProductCart) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(product|products|cart|add to cart|shopping|ecommerce|modal|catalog|inventory)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(product|cart|add to cart|ecommerce|modal)' THEN 0");
  }

  if (intent.wantsPortfolioFilter) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(portfolio|project|projects|category|filter|gallery|work card|hover-reveal)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(portfolio|project|filter|category)' THEN 0");
  }

  if (intent.wantsTheme) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(theme|theming|dark|light|css custom propert|css variable|design token|color-scheme|aria switch|toggle)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(theme|dark|light|css variable|color-scheme|aria switch)' THEN 0");
  }

  if (intent.wantsMobileNav) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(mobile|hamburger|navigation|navbar|nav drawer|sidebar|off-canvas|slide-in|expanded-state|menu item)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(mobile|hamburger|navigation|navbar|sidebar|off-canvas)' THEN 0");
  }

  if (intent.wantsGalleryOverlay) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(gallery|image|photo|card|overlay|hover|focus-within|zoom|dimming|media)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(gallery|image|overlay|hover|focus-within)' THEN 0");
  }

  if (intent.wantsNewsletter) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(newsletter|subscribe|signup|email input|email form|submit button|inline newsletter)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(newsletter|subscribe|email input|submit button)' THEN 0");
  }

  if (intent.wantsFullStackScaffold) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(full stack|full-stack|scaffold|project structure|folder structure|frontend.*backend|backend.*frontend|vite.*express|express.*vite|docker-compose|docker compose|env\\.example|backend.*database|api.*database)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(full stack|full-stack|scaffold|project structure|frontend.*backend|backend.*frontend|docker-compose|docker compose)' THEN 0");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(backend|express|api|routes|database|sql)' THEN 1");
  }

  if (intent.wantsBackend) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(backend|back-end|server-side|express|node server|middleware|controller|service layer|request handler|response handler|api server|config\\.js|cors|error handler|authorization middleware|route middleware)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(backend|express|server|middleware|controller|service layer)' THEN 0");
  }

  if (intent.wantsApiRoutes) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(api route|rest|endpoint|endpoints|resource route|route-specific|router|controller|middleware|request object|request handler|response handler|http method|crud|status code|express)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(api|rest|endpoint|route|router|controller|crud)' THEN 0");
  }

  if (intent.wantsDatabase) {
    conditions.push("(k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(\\msql\\M|database|db connection|postgres|postgresql|mysql|sqlite|schema\\.sql|migration|migrations|primary key|foreign key|query builder|transaction|connection pool)'");
    ordering.push("WHEN (k.name || ' ' || k.category || ' ' || k.summary || ' ' || k.guidance) ~* '(sql|database|postgres|schema\\.sql|migration|table|foreign key)' THEN 0");
  }

  if (!conditions.length) return [];

  const rows = await query(
    `SELECT k.*, s.name AS source_name, s.url AS source_url, 0::float AS similarity
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     WHERE k.enabled=TRUE
       AND k.embedding IS NOT NULL
       AND (s.id IS NULL OR s.enabled=TRUE)
       AND k.id <> ALL($1::int[])
       AND (${conditions.join(" OR ")})
     ORDER BY
       CASE
         ${ordering.join("\n         ")}
         ELSE 1
       END,
       k.updated_at DESC
     LIMIT 80`,
    [existingIds]
  );
  return rows.rows;
}

async function runCodexJsonPrompt(prompt, label = "codex-json") {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mcp-ml-codex-json-"));
  const outputFile = path.join(tempDir, "output.json");
  const codexBin = await resolveCodexBinary();
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile
  ];
  if (config.mlSkillModel) args.push("--model", config.mlSkillModel);
  args.push(`${prompt}\n\nOutput only JSON. No markdown fences.`);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(codexBin, args, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new ExternalServiceError(`${label} timed out`, null, "ML_CODEX_TIMEOUT"));
      }, config.codexTimeoutMs);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new ExternalServiceError(error.message, null, "ML_CODEX_PROCESS_ERROR"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new ExternalServiceError(`${label} failed with code ${code}`, { stderr: stderr.trim() }, "ML_CODEX_FAILED"));
      });
    });
    const raw = await readFile(outputFile, "utf8");
    return parseJsonObject(raw);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
}

async function getSkillVersion() {
  const row = await query(
    `SELECT
       COUNT(k.id)::int AS enabled_count,
       COALESCE(MAX(k.updated_at), TIMESTAMP 'epoch') AS max_updated_at
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     WHERE k.enabled=TRUE
       AND k.embedding IS NOT NULL
       AND (s.id IS NULL OR s.enabled=TRUE)`
  );
  const version = row.rows[0] || {};
  const updated = version.max_updated_at instanceof Date
    ? version.max_updated_at.toISOString()
    : String(version.max_updated_at || "");
  return `${MIND_SELECTOR_VERSION}:${version.enabled_count || 0}:${updated}`;
}

async function loadCachedSkills(promptHash, skillVersion) {
  const cache = await query(
    `SELECT *
     FROM ml_mind_cache
     WHERE prompt_hash=$1
       AND skill_version=$2
       AND expires_at > NOW()
     LIMIT 1`,
    [promptHash, skillVersion]
  );
  if (!cache.rowCount) return null;
  const ids = Array.isArray(cache.rows[0].selected_skill_ids)
    ? cache.rows[0].selected_skill_ids.map(Number).filter(Boolean)
    : [];
  if (!ids.length) {
    return {
      skills: [],
      reason: cache.rows[0].selector_reason || "",
      selectorStrategy: cache.rows[0].selector_strategy || "fast_cached",
      cacheHit: true
    };
  }
  const skills = await query(
    `SELECT k.*, s.name AS source_name, s.url AS source_url
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     WHERE k.id=ANY($1::int[])
       AND k.enabled=TRUE
       AND (s.id IS NULL OR s.enabled=TRUE)
     ORDER BY array_position($1::int[], k.id)`,
    [ids]
  );
  return {
    skills: skills.rows,
    reason: cache.rows[0].selector_reason || "",
    selectorStrategy: cache.rows[0].selector_strategy || "fast_cached",
    cacheHit: true
  };
}

async function saveMindCache(promptHash, skillVersion, selectedSkills, selectorReason, selectorStrategy) {
  const ids = selectedSkills.map((skill) => Number(skill.id)).filter(Boolean).slice(0, runtimeSkillLimit());
  const ttlMs = Math.max(1000, Number(config.mlMindCacheTtlMs || 86400000));
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await query(
    `INSERT INTO ml_mind_cache
     (prompt_hash, skill_version, selected_skill_ids, selector_reason, selector_strategy, expires_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6)
     ON CONFLICT (prompt_hash, skill_version)
     DO UPDATE SET
       selected_skill_ids=$3::jsonb,
       selector_reason=$4,
       selector_strategy=$5,
       expires_at=$6,
       updated_at=NOW()`,
    [promptHash, skillVersion, JSON.stringify(ids), selectorReason || "", selectorStrategy || "fast_cached", expiresAt]
  ).catch(() => null);
}

function selectSkillsForPromptFast(promptText, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    return { skills: [], reason: "No candidate skills matched the prompt.", warning: "", selectorStrategy: "fast_cached" };
  }
  const selectorLimit = Math.max(8, Math.min(24, config.mlRetrievalLimit * 3));
  const ranked = rankSkillsForPrompt(promptText, list).slice(0, selectorLimit);
  const compatible = ranked.filter((skill) => isSkillCompatibleWithPrompt(promptText, skill));
  const selected = ensureIntentCoverage(promptText, compatible.slice(0, runtimeSkillLimit()), ranked)
    .filter((skill) => isSkillCompatibleWithPrompt(promptText, skill))
    .slice(0, runtimeSkillLimit());
  const reason = selected.length
    ? `Fast deterministic selector chose ${selected.length} skill(s) from ${list.length} candidates.`
    : "No candidate skills directly matched the requested task.";
  return {
    skills: selected,
    reason,
    warning: "",
    selectorStrategy: "fast_cached"
  };
}

async function selectSkillsForPromptWithCodex(promptText, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { skills: [], warning: "", selectorStrategy: "codex" };
  const selectorLimit = Math.max(8, Math.min(16, config.mlRetrievalLimit * 2));
  const ranked = rankSkillsForPrompt(promptText, list).slice(0, selectorLimit);
  if (!ranked.length) return { skills: [], reason: "No candidate skills directly matched the requested task.", warning: "" };
  const payload = ranked.map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    summary: skill.summary,
    guidance: skill.guidance,
    source: skill.source_name || "",
    similarity: Number(skill.similarity || 0)
  }));
  const prompt = [
    "You are selecting learned implementation skills for a KiraAI prompt.",
    "Use GPT-5.5-level judgment: select only skills that directly improve the requested output.",
    "Return JSON with this shape: {\"selectedSkillIds\":[1,2],\"reason\":\"short string\"}",
    "",
    "Rules:",
    "- Select 0 to 5 skills.",
    "- Prefer implementation guidance from HTML/CSS/JS/TS skills.",
    "- Do not select a skill just because words overlap; it must help the task.",
    "- For UI/card/component prompts, choose concrete layout, card, responsive, avatar/media, or interaction skills.",
    "- For user/profile card prompts, prefer card composition, avatar/profile metadata, restrained actions, and responsive layout; reject pricing, project-grid, contact-form, and data-model skills.",
    "- Only choose social-link skills when the user explicitly asks for social links, social icons, or public profile/social actions.",
    "- For SaaS/dashboard/admin/filebrowser/product-app prompts, prefer operational app UI guidance; reject portfolio hover/media effects, grayscale/zoom/gallery treatments, and personal-site social-link styling unless explicitly requested.",
    "- For login/auth card prompts, prefer form/input/label/password/email/submit/focus/accessibility/card-shell skills; reject contact-form, pricing, portfolio/project, and theme-only skills.",
    "- Do not choose TypeScript/data-modeling skills unless the user asks for types, classes, schema, state, or data modeling.",
    "- Do not choose generic theme/color-system skills unless the user asks for themes, CSS variables, design tokens, colors, or theming.",
    "- Keep the KiraAI prompt compact.",
    "",
    `User prompt: ${promptText}`,
    "",
    `Candidate skills: ${JSON.stringify(payload)}`
  ].join("\n");

  try {
    const result = await runCodexJsonPrompt(prompt, "KiraAI skill selector");
    const allowed = new Set(ranked.map((skill) => Number(skill.id)));
    const selectedIds = (Array.isArray(result.selectedSkillIds) ? result.selectedSkillIds : [])
      .map(Number)
      .filter((id) => allowed.has(id))
      .slice(0, 5);
    const selectedSkills = ranked
      .filter((skill) => selectedIds.includes(Number(skill.id)))
      .filter((skill) => isSkillCompatibleWithPrompt(promptText, skill));
    const coveredSkills = ensureIntentCoverage(
      promptText,
      selectedSkills.length
        ? selectedSkills
        : ranked.filter((skill) => isSkillCompatibleWithPrompt(promptText, skill)).slice(0, Math.min(3, ranked.length)),
      ranked
    );
    return {
      skills: coveredSkills,
      reason: cleanOneLine(result.reason || "", 300),
      warning: "",
      selectorStrategy: "codex"
    };
  } catch (error) {
    return {
      skills: ensureIntentCoverage(
        promptText,
        ranked.filter((skill) => isSkillCompatibleWithPrompt(promptText, skill)).slice(0, Math.min(3, ranked.length)),
        ranked
      ),
      reason: "",
      warning: `Skill selector failed; using top vector matches. ${error.message}`,
      selectorStrategy: "codex_fallback"
    };
  }
}

async function selectSkillsForPrompt(promptText, candidates, { deep = false } = {}) {
  if (deep || config.mlRuntimeSelector === "codex") {
    const result = await withTimeout(
      selectSkillsForPromptWithCodex(promptText, candidates),
      config.mlSelectorTimeoutMs,
      "KiraAI skill selector timed out"
    );
    return { ...result, skills: result.skills.slice(0, runtimeSkillLimit()) };
  }
  return selectSkillsForPromptFast(promptText, candidates);
}

async function retrieveMind(promptText, options = {}) {
  const startedAt = Date.now();
  if (!config.mlMindEnabled || !String(promptText || "").trim()) {
    return { context: "", skills: [], chunks: [], disabled: !config.mlMindEnabled, durationMs: Date.now() - startedAt };
  }
  if (config.mlEmbeddingProvider === "openai" && !openai) {
    return {
      context: "",
      skills: [],
      chunks: [],
      warning: "OPENAI_API_KEY is missing, so KiraAI retrieval was skipped.",
      durationMs: Date.now() - startedAt
    };
  }

  const promptHash = hashText(promptText);
  const skillVersion = await getSkillVersion();
  if (!options.deep && config.mlRuntimeSelector === "fast_cached") {
    const cached = await loadCachedSkills(promptHash, skillVersion);
    if (cached) {
      const selectedSkills = cached.skills
        .filter((skill) => isSkillCompatibleWithPrompt(promptText, skill))
        .slice(0, runtimeSkillLimit())
        .map(serializeRetrievedSkill);
      return {
        context: buildMindContext({ skills: selectedSkills }),
        skills: selectedSkills,
        chunks: [],
        candidates: [],
        selectorReason: cached.reason || "",
        selectorStrategy: cached.selectorStrategy || "fast_cached",
        cacheHit: true,
        candidateCount: 0,
        warning: "",
        durationMs: Date.now() - startedAt
      };
    }
  }

  const [embedding] = await createEmbeddings([promptText]);
  const vector = vectorLiteral(embedding);
  const limit = Math.max(32, config.mlRetrievalLimit * 5);
  const skillRows = await query(
    `SELECT k.*, s.name AS source_name, s.url AS source_url, 1 - (k.embedding <=> $1::vector) AS similarity
     FROM ml_skills k
     LEFT JOIN ml_sources s ON s.id = k.source_id
     WHERE k.enabled=TRUE AND k.embedding IS NOT NULL AND (s.id IS NULL OR s.enabled=TRUE)
     ORDER BY k.embedding <=> $1::vector
     LIMIT $2`,
    [vector, limit]
  );
  const existingIds = skillRows.rows.map((skill) => Number(skill.id));
  const supplementalRows = await loadIntentSkillRows(promptText, existingIds);
  const rowsById = new Map();
  for (const skill of [...skillRows.rows, ...supplementalRows]) {
    rowsById.set(Number(skill.id), skill);
  }
  const candidateRows = [...rowsById.values()];
  const selected = await selectSkillsForPrompt(promptText, candidateRows, { deep: Boolean(options.deep) });
  const selectedSkills = selected.skills.map(serializeRetrievedSkill);
  const selectorStrategy = selected.selectorStrategy || (options.deep ? "codex" : "fast_cached");
  if (!options.deep && config.mlRuntimeSelector === "fast_cached") {
    await saveMindCache(promptHash, skillVersion, selectedSkills, selected.reason, selectorStrategy);
  }

  return {
    context: buildMindContext({ skills: selectedSkills }),
    skills: selectedSkills,
    chunks: [],
    candidates: candidateRows.map(serializeRetrievedSkill),
    selectorReason: selected.reason || "",
    selectorStrategy,
    cacheHit: false,
    candidateCount: candidateRows.length,
    warning: selected.warning || "",
    durationMs: Date.now() - startedAt
  };
}

export async function buildMindContextForPrompt({ prompt, codeJobId = null } = {}) {
  const startedAt = Date.now();
  const result = await withTimeout(
    retrieveMind(prompt),
    config.mlSelectorTimeoutMs,
    `KiraAI retrieval exceeded ${config.mlSelectorTimeoutMs}ms budget`
  ).catch((error) => ({
    context: "",
    skills: [],
    chunks: [],
    candidates: [],
    selectorReason: "",
    selectorStrategy: "timeout",
    cacheHit: false,
    candidateCount: 0,
    warning: error.message,
    durationMs: Date.now() - startedAt
  }));
  const skillIds = result.skills.map((skill) => skill.id);
  const chunkIds = result.chunks.map((chunk) => chunk.id);

  if (skillIds.length) {
    await query(
      "UPDATE ml_skills SET usage_count=usage_count + 1, last_used_at=NOW() WHERE id=ANY($1::int[])",
      [skillIds]
    ).catch(() => null);
  }

  if (result.context || skillIds.length || chunkIds.length) {
    await query(
      `INSERT INTO ml_prompt_usages (code_job_id, prompt_hash, prompt_text, selected_skill_ids, selected_chunk_ids, context_text)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        codeJobId,
        hashText(prompt),
        String(prompt || "").slice(0, 4000),
        JSON.stringify(skillIds),
        JSON.stringify(chunkIds),
        result.context || ""
      ]
    ).catch(() => null);
  }

  return { ...result, durationMs: result.durationMs ?? Date.now() - startedAt };
}

export async function debugMindQuery(prompt, options = {}) {
  if (!String(prompt || "").trim()) throw new ValidationError("prompt is required");
  return options.deep ? retrieveMind(prompt, { deep: true }) : buildMindContextForPrompt({ prompt });
}

export async function recoverInterruptedMlJobsOnStartup() {
  if (!config.jobResumeEnabled) return [];
  const maxAttempts = maxMlResumeAttempts();
  if (maxAttempts <= 0) return [];

  await query(
    `UPDATE ml_learning_jobs
     SET runner_id=NULL,
         interrupted_at=COALESCE(interrupted_at, NOW()),
         resume_reason=COALESCE(resume_reason, 'server_restart'),
         updated_at=NOW()
     WHERE status IN ('queued','running')
       AND resume_count < $1`,
    [maxAttempts]
  );

  const row = await query(
    `SELECT id, source_id, status, stage, resume_count
     FROM ml_learning_jobs
     WHERE status IN ('queued','running')
       AND resume_count < $1
     ORDER BY updated_at ASC
     LIMIT 20`,
    [maxAttempts]
  );

  const sourceIds = [...new Set(row.rows.map((item) => item.source_id).filter(Boolean))];
  if (sourceIds.length) {
    await query("UPDATE ml_sources SET status='learning', updated_at=NOW() WHERE id=ANY($1::int[])", [sourceIds]).catch(() => null);
  }

  for (const job of row.rows) {
    void runLearningJob(job.id, { resumed: true, reason: "server_restart" });
  }
  return row.rows;
}

export async function markInterruptedMlJobs() {
  return recoverInterruptedMlJobsOnStartup();
}
