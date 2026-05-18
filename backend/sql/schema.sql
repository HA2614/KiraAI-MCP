CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  goals TEXT NOT NULL,
  tech_stack TEXT,
  timeline TEXT,
  budget TEXT,
  root_path TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS root_path TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS project_plans (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  plan_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT,
  is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_feedback (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  comments TEXT,
  modified_plan_json JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE project_plans ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE project_plans ADD COLUMN IF NOT EXISTS is_baseline BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS codebase_summaries (
  id SERIAL PRIMARY KEY,
  root_path TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  analysis_version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  full_report TEXT NOT NULL,
  analysis_json JSONB,
  model TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  duration_ms INTEGER,
  stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS analysis_runs (
  id SERIAL PRIMARY KEY,
  summary_id INTEGER REFERENCES codebase_summaries(id) ON DELETE SET NULL,
  root_path TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  model TEXT,
  analysis_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id SERIAL PRIMARY KEY,
  analysis_run_id INTEGER REFERENCES analysis_runs(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  file_path TEXT,
  function_name TEXT,
  issue TEXT,
  suggestion TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  follow_up_criteria TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS improvement_checks (
  id SERIAL PRIMARY KEY,
  suggestion_id INTEGER REFERENCES improvement_suggestions(id) ON DELETE CASCADE,
  analysis_run_id INTEGER REFERENCES analysis_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  explanation TEXT NOT NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS code_style_profiles (
  id SERIAL PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prompt_profiles (
  id SERIAL PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_events (
  id SERIAL PRIMARY KEY,
  root_path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS code_jobs (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  root_path TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  improved_prompt TEXT,
  job_type TEXT NOT NULL DEFAULT 'prompt',
  title TEXT,
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  changed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  diff_summary TEXT,
  risk_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  test_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  response_markdown TEXT,
  response_kind TEXT NOT NULL DEFAULT 'code',
  response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_status TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  duration_ms INTEGER,
  stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS analysis_json JSONB;
ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS analysis_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS resume_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMP;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMP;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS runner_id TEXT;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS resume_reason TEXT;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS resume_state JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'prompt';
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS response_markdown TEXT;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS response_kind TEXT NOT NULL DEFAULT 'code';
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS code_job_assets (
  id SERIAL PRIMARY KEY,
  code_job_id INTEGER NOT NULL REFERENCES code_jobs(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL DEFAULT 'image',
  mime_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  content BYTEA NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ml_sources (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'github',
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  name TEXT NOT NULL,
  input_hash TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMP,
  archive_reason TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'idle',
  last_learned_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE ml_sources ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'github';
ALTER TABLE ml_sources ADD COLUMN IF NOT EXISTS input_hash TEXT;
ALTER TABLE ml_sources ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ml_sources ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ml_sources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE ml_sources ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE TABLE IF NOT EXISTS ml_learning_jobs (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES ml_sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued',
  message TEXT NOT NULL DEFAULT 'Queued',
  logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE ml_learning_jobs ADD COLUMN IF NOT EXISTS resume_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ml_learning_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMP;
ALTER TABLE ml_learning_jobs ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMP;
ALTER TABLE ml_learning_jobs ADD COLUMN IF NOT EXISTS runner_id TEXT;
ALTER TABLE ml_learning_jobs ADD COLUMN IF NOT EXISTS resume_reason TEXT;
ALTER TABLE ml_learning_jobs ADD COLUMN IF NOT EXISTS resume_state JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ml_documents (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES ml_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, path)
);

CREATE TABLE IF NOT EXISTS ml_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES ml_documents(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES ml_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  embedding vector(1536),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS ml_skills (
  id SERIAL PRIMARY KEY,
  source_id INTEGER REFERENCES ml_sources(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  summary TEXT NOT NULL,
  guidance TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  embedding vector(1536),
  source_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, slug)
);

UPDATE ml_sources
SET archived=TRUE,
    archived_at=COALESCE(archived_at, last_learned_at, updated_at, NOW()),
    archive_reason=COALESCE(archive_reason, 'Learning complete; skills are available.'),
    updated_at=NOW()
WHERE archived=FALSE
  AND (
    status='learned'
    OR last_learned_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM ml_skills WHERE ml_skills.source_id=ml_sources.id)
  );

CREATE TABLE IF NOT EXISTS ml_prompt_usages (
  id SERIAL PRIMARY KEY,
  code_job_id INTEGER REFERENCES code_jobs(id) ON DELETE SET NULL,
  prompt_hash TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  selected_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ml_mind_cache (
  id SERIAL PRIMARY KEY,
  prompt_hash TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  selected_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  selector_reason TEXT NOT NULL DEFAULT '',
  selector_strategy TEXT NOT NULL DEFAULT 'fast_cached',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (prompt_hash, skill_version)
);

CREATE INDEX IF NOT EXISTS idx_ml_sources_enabled ON ml_sources(enabled);
CREATE INDEX IF NOT EXISTS idx_ml_sources_archived ON ml_sources(archived);
CREATE INDEX IF NOT EXISTS idx_ml_sources_type_hash ON ml_sources(source_type, input_hash);
CREATE INDEX IF NOT EXISTS idx_code_jobs_status_resume ON code_jobs(status, resume_count, updated_at);
CREATE INDEX IF NOT EXISTS idx_code_jobs_project_duration ON code_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_jobs_project_type_created ON code_jobs(project_id, job_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_job_assets_job ON code_job_assets(code_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_codebase_summaries_project_duration ON codebase_summaries(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_learning_jobs_source_created ON ml_learning_jobs(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_learning_jobs_status_resume ON ml_learning_jobs(status, resume_count, updated_at);
CREATE INDEX IF NOT EXISTS idx_ml_chunks_source_enabled ON ml_chunks(source_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ml_skills_enabled ON ml_skills(enabled);
CREATE INDEX IF NOT EXISTS idx_ml_prompt_usages_code_job ON ml_prompt_usages(code_job_id);
CREATE INDEX IF NOT EXISTS idx_ml_mind_cache_prompt ON ml_mind_cache(prompt_hash, skill_version, expires_at);
