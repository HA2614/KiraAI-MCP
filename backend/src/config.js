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

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mcp_pm",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  aiProvider: process.env.AI_PROVIDER || "codex_cli",
  aiFallbackProviders: parseCsv(process.env.AI_FALLBACK_PROVIDERS, ["codex_cli", "openai", "anthropic"]),
  aiRetryCount: Number(process.env.AI_RETRY_COUNT || 2),
  aiRetryDelayMs: Number(process.env.AI_RETRY_DELAY_MS || 600),
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  codeAiModel: process.env.CODE_AI_MODEL || "gpt-5.5",
  codeJobSandbox: process.env.CODE_JOB_SANDBOX || process.env.CODEX_SUMMARY_SANDBOX || "read-only",
  codeJobReasoningEffort: process.env.CODE_JOB_REASONING_EFFORT || "low",
  codeJobTimeoutMs: Number(process.env.CODE_JOB_TIMEOUT_MS || 180000),
  jobResumeEnabled: parseBool(process.env.JOB_RESUME_ENABLED, true),
  codeJobMaxResumeAttempts: Number(process.env.CODE_JOB_MAX_RESUME_ATTEMPTS || 2),
  mlJobMaxResumeAttempts: Number(process.env.ML_JOB_MAX_RESUME_ATTEMPTS || 2),
  jobResumeStaleMs: Number(process.env.JOB_RESUME_STALE_MS || 30000),
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
  codexModel: process.env.CODEX_MODEL || "",
  codexSummaryModel: process.env.CODEX_SUMMARY_MODEL || "gpt-5.3-codex",
  codexSummarySandbox: process.env.CODEX_SUMMARY_SANDBOX || "read-only",
  codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 90000),
  codexBin: process.env.CODEX_BIN || "codex",
  fsBasePath: process.env.FS_BASE_PATH || process.cwd(),
  staticFrontendDir: process.env.STATIC_FRONTEND_DIR || "",
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
  mlScraperTimeoutMs: Number(process.env.ML_SCRAPER_TIMEOUT_MS || 15000)
};
