import dotenv from "dotenv";
import path from "node:path";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env"), override: false });

function parseCsv(value, fallback) {
  if (!value) return fallback;
  const list = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseIntEnv(value, fallback, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mcp_pm",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  aiProvider: process.env.AI_PROVIDER || "codex_cli",
  aiFallbackProviders: parseCsv(process.env.AI_FALLBACK_PROVIDERS, ["codex_cli", "claude_cli", "openai", "anthropic"]),
  aiRetryCount: Number(process.env.AI_RETRY_COUNT || 2),
  aiRetryDelayMs: Number(process.env.AI_RETRY_DELAY_MS || 600),
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  codeAiModel: process.env.CODE_AI_MODEL || "gpt-5.5",
  codeAgentProvider: process.env.CODE_AGENT_PROVIDER || process.env.AI_PROVIDER || "codex_cli",
  codeJobSandbox: process.env.CODE_JOB_SANDBOX || process.env.CODEX_SUMMARY_SANDBOX || "read-only",
  codeJobReasoningEffort: process.env.CODE_JOB_REASONING_EFFORT || "low",
  codeJobTimeoutMs: Number(process.env.CODE_JOB_TIMEOUT_MS || 900000),
  codeJobPrepareDeps: parseBool(process.env.CODE_JOB_PREPARE_DEPS, true),
  codeJobPrepareDepsTimeoutMs: Number(process.env.CODE_JOB_PREPARE_DEPS_TIMEOUT_MS || 180000),
  codeJobRequireLearnedSkills: parseBool(process.env.CODE_JOB_REQUIRE_LEARNED_SKILLS, true),
  imageGenerationEnabled: parseBool(process.env.IMAGE_GENERATION_ENABLED, true),
  imageProvider: process.env.IMAGE_PROVIDER || "codex_cli",
  imageCodexModel: process.env.IMAGE_CODEX_MODEL || process.env.CODE_AI_MODEL || "gpt-5.5",
  imageCodexSandbox: process.env.IMAGE_CODEX_SANDBOX || "workspace-write",
  imageCodexReasoningEffort: process.env.IMAGE_CODEX_REASONING_EFFORT || process.env.CODE_JOB_REASONING_EFFORT || "low",
  imageCodexTimeoutMs: Number(process.env.IMAGE_CODEX_TIMEOUT_MS || process.env.CODE_JOB_TIMEOUT_MS || 900000),
  imageDefaultSize: process.env.IMAGE_DEFAULT_SIZE || "1024x1024",
  imageMaxPerJob: Number(process.env.IMAGE_MAX_PER_JOB || 1),
  jobResumeEnabled: parseBool(process.env.JOB_RESUME_ENABLED, true),
  codeJobMaxResumeAttempts: Number(process.env.CODE_JOB_MAX_RESUME_ATTEMPTS || 2),
  mlJobMaxResumeAttempts: Number(process.env.ML_JOB_MAX_RESUME_ATTEMPTS || 2),
  jobResumeStaleMs: Number(process.env.JOB_RESUME_STALE_MS || 30000),
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
  codexModel: process.env.CODEX_MODEL || "",
  codexSummaryModel: process.env.CODEX_SUMMARY_MODEL || "gpt-5.3-codex",
  codexSummarySandbox: process.env.CODEX_SUMMARY_SANDBOX || "read-only",
  codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 900000),
  codexBin: process.env.CODEX_BIN || "codex",
  claudeBin: process.env.CLAUDE_BIN || "claude",
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || "",
  claudeModel: process.env.CLAUDE_MODEL || "sonnet",
  claudePermissionMode: process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions",
  claudeMaxTurns: parseIntEnv(process.env.CLAUDE_MAX_TURNS, 20, { min: 1 }),
  fsBasePath: process.env.FS_BASE_PATH || process.cwd(),
  fsMaxReadBytes: parseIntEnv(process.env.FS_MAX_READ_BYTES, 1024 * 1024, { min: 1024 }),
  staticFrontendDir: process.env.STATIC_FRONTEND_DIR || "",
  trustProxy: parseBool(process.env.TRUST_PROXY, false),
  authEnabled: parseBool(process.env.AUTH_ENABLED, false),
  authAdminPasswordHash: process.env.AUTH_ADMIN_PASSWORD_HASH || "",
  authBootstrapEmail: process.env.AUTH_BOOTSTRAP_EMAIL || process.env.AUTH_ADMIN_EMAIL || "",
  authBootstrapPasswordHash: process.env.AUTH_BOOTSTRAP_PASSWORD_HASH || process.env.AUTH_ADMIN_PASSWORD_HASH || "",
  inviteTtlMs: parseIntEnv(process.env.INVITE_TTL_MS, 7 * 24 * 60 * 60 * 1000, { min: 60_000 }),
  sessionSecret: process.env.SESSION_SECRET || "",
  authSessionTtlMs: parseIntEnv(process.env.AUTH_SESSION_TTL_MS, 12 * 60 * 60 * 1000, { min: 60_000 }),
  authCookieName: process.env.AUTH_COOKIE_NAME || "kiraai.jwt",
  authCookieSecure: parseBool(process.env.AUTH_COOKIE_SECURE, false),
  corsAllowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS, []),
  rateLimitWindowMs: parseIntEnv(process.env.RATE_LIMIT_WINDOW_MS, 60_000, { min: 1000 }),
  rateLimitMax: parseIntEnv(process.env.RATE_LIMIT_MAX, 300, { min: 1 }),
  loginRateLimitMax: parseIntEnv(process.env.AUTH_LOGIN_RATE_LIMIT_MAX, 10, { min: 1 }),
  expensiveRateLimitMax: parseIntEnv(process.env.EXPENSIVE_RATE_LIMIT_MAX, 30, { min: 1 }),
  codeJobMaxActive: parseIntEnv(process.env.CODE_JOB_MAX_ACTIVE, 0, { min: 0 }),
  mlJobMaxActive: parseIntEnv(process.env.ML_JOB_MAX_ACTIVE, 0, { min: 0 }),
  mlMindEnabled: parseBool(process.env.ML_MIND_ENABLED, true),
  mlAiProvider: process.env.ML_AI_PROVIDER || "codex_cli",
  mlEmbeddingProvider: process.env.ML_EMBEDDING_PROVIDER || "local_hash",
  mlEmbeddingModel: process.env.ML_EMBEDDING_MODEL || "text-embedding-3-small",
  mlSkillModel: process.env.ML_SKILL_MODEL || "gpt-5.5",
  mlMaxRepoMb: Number(process.env.ML_MAX_REPO_MB || 120),
  mlMaxFileBytes: Number(process.env.ML_MAX_FILE_BYTES || 200000),
  mlChunkSize: Number(process.env.ML_CHUNK_SIZE || 1800),
  mlChunkOverlap: Number(process.env.ML_CHUNK_OVERLAP || 250),
  mlRetrievalLimit: Number(process.env.ML_RETRIEVAL_LIMIT || 8),
  mlRuntimeSelector: process.env.ML_RUNTIME_SELECTOR || "fast_cached",
  mlSelectorTimeoutMs: Number(process.env.ML_SELECTOR_TIMEOUT_MS || 2500),
  mlMindCacheTtlMs: Number(process.env.ML_MIND_CACHE_TTL_MS || 86400000),
  mlMindMaxRuntimeSkills: Number(process.env.ML_MIND_MAX_RUNTIME_SKILLS || 3),
  mlScraperMaxPages: Number(process.env.ML_SCRAPER_MAX_PAGES || 25),
  mlScraperMaxDepth: Number(process.env.ML_SCRAPER_MAX_DEPTH || 2),
  mlScraperMaxTotalMb: Number(process.env.ML_SCRAPER_MAX_TOTAL_MB || 30),
  mlScraperTimeoutMs: Number(process.env.ML_SCRAPER_TIMEOUT_MS || 15000),
  mlAllowPrivateNetworkFetches: parseBool(process.env.ML_ALLOW_PRIVATE_NETWORK_FETCHES, false)
};
