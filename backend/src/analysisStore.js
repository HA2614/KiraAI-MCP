import path from "node:path";
import { query } from "./db.js";
import { resolveSafePath } from "./structure.js";

let ensured = false;

function normalizeSuggestions(analysisJson = {}) {
  return Array.isArray(analysisJson.improvementSuggestions) ? analysisJson.improvementSuggestions : [];
}

function normalizeStyleProfile(analysisJson = {}) {
  return {
    observations: analysisJson.codeStyleObservations || [],
    architectureOverview: analysisJson.architectureOverview || [],
    updatedFromTitle: analysisJson.title || ""
  };
}

function normalizePromptProfile(analysisJson = {}) {
  return {
    preferredPatterns: analysisJson.codeStyleObservations || [],
    recurringImprovements: normalizeSuggestions(analysisJson).slice(0, 12)
  };
}

function clampText(value, fallback, max = 400) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, max);
}

function arrayText(value, maxItems = 6) {
  if (!Array.isArray(value)) return "";
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, maxItems).join(", ");
}

function getProjectMetadata(summary) {
  const analysisJson = summary.analysis_json || summary.analysisJson || {};
  const metadata = analysisJson.projectMetadata || {};
  const root = summary.root_path || summary.root || "";
  const folderName = path.basename(root) || "Existing Codebase";
  const title = metadata.name || analysisJson.title || summary.title || folderName;
  const description = metadata.productDescription || metadata.description || analysisJson.projectDescription || summary.description || "";
  const techStack = metadata.techStack || arrayText(metadata.detectedFrameworks) || arrayText(analysisJson.architectureOverview) || arrayText((analysisJson.files || []).map((file) => file.role));

  return {
    name: clampText(title, folderName, 120),
    goals: clampText(metadata.goals || description, `Maintain and improve the existing ${folderName} codebase.`, 1000),
    techStack: clampText(techStack, "Detected from analyzer summary", 500),
    timeline: "Existing codebase - ongoing",
    budget: "N/A",
    rootPath: root
  };
}

function withSummaryAliases(row) {
  if (!row) return null;
  return {
    ...row,
    analysisVersion: row.analysis_version,
    projectId: row.project_id,
    projectName: row.project_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    stageTimings: row.stage_timings
  };
}

async function ensureSummariesTable() {
  if (ensured) return;
  await query(`
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
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS analysis_json JSONB;
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS analysis_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
    ALTER TABLE codebase_summaries ADD COLUMN IF NOT EXISTS stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  ensured = true;
}

export async function saveCodebaseSummary(result) {
  await ensureSummariesTable();
  const analysisJson = result.analysisJson || null;
  const versionRow = await query(
    "SELECT COALESCE(MAX(analysis_version), 0) + 1 AS next_version FROM codebase_summaries WHERE root_path=$1",
    [result.root]
  );
  const analysisVersion = Number(versionRow.rows[0]?.next_version || 1);
  const inserted = await query(
    `INSERT INTO codebase_summaries
       (root_path, project_id, analysis_version, title, description, full_report, analysis_json, model, started_at, finished_at, duration_ms, stage_timings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, root_path, project_id, analysis_version, title, description, full_report, analysis_json, model, started_at, finished_at, duration_ms, stage_timings, created_at`,
    [
      result.root,
      result.projectId || null,
      analysisVersion,
      result.title,
      result.description,
      result.fullReport,
      analysisJson,
      result.model || null,
      result.startedAt || null,
      result.finishedAt || null,
      result.durationMs || null,
      JSON.stringify(result.stageTimings || {})
    ]
  );
  const summary = withSummaryAliases(inserted.rows[0]);
  const learning = await saveAnalysisLearning({ ...result, summaryId: summary.id, analysisVersion, analysisJson: analysisJson || {} });
  return { ...summary, ...learning };
}

export async function updateCodebaseSummaryTiming(summaryId, timing = {}) {
  await ensureSummariesTable();
  const row = await query(
    `UPDATE codebase_summaries
     SET started_at=COALESCE($2, started_at),
         finished_at=COALESCE($3, finished_at),
         duration_ms=COALESCE($4, duration_ms),
         stage_timings=COALESCE($5::jsonb, stage_timings)
     WHERE id=$1
     RETURNING id, root_path, project_id, analysis_version, title, description, full_report, analysis_json, model,
               started_at, finished_at, duration_ms, stage_timings, created_at`,
    [
      summaryId,
      timing.startedAt || null,
      timing.finishedAt || null,
      timing.durationMs ?? null,
      timing.stageTimings ? JSON.stringify(timing.stageTimings) : null
    ]
  );
  return withSummaryAliases(row.rows[0]) || null;
}

export async function saveAnalysisLearning(result) {
  const analysisJson = result.analysisJson || {};
  const run = await query(
    `INSERT INTO analysis_runs (summary_id, root_path, title, status, model, analysis_json)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [result.summaryId || null, result.root, result.title, "done", result.model || null, analysisJson]
  );
  const analysisRun = run.rows[0];
  const prior = await listOpenImprovementSuggestions(result.root);
  const checks = await saveImprovementChecks(result.root, analysisRun.id, prior, normalizeSuggestions(analysisJson));
  const suggestions = await saveImprovementSuggestions(result.root, analysisRun.id, normalizeSuggestions(analysisJson));
  const styleProfile = await upsertStyleProfile(result.root, normalizeStyleProfile(analysisJson));
  const promptProfile = await upsertPromptProfile(result.root, normalizePromptProfile(analysisJson));
  const event = await saveLearningEvent(result.root, "analysis_completed", {
    analysisRunId: analysisRun.id,
    summaryId: result.summaryId || null,
    analysisVersion: result.analysisVersion || null,
    durationMs: result.durationMs || null,
    suggestionCount: suggestions.length,
    checkCount: checks.length
  });
  return { analysisRun, improvementChecks: checks, suggestions, styleProfile, promptProfile, learningEvents: [event] };
}

async function saveImprovementSuggestions(rootPath, analysisRunId, suggestions) {
  const inserted = [];
  for (const item of suggestions) {
    const row = await query(
      `INSERT INTO improvement_suggestions
       (analysis_run_id, root_path, file_path, function_name, issue, suggestion, priority, follow_up_criteria)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        analysisRunId,
        rootPath,
        item.file || "",
        item.function || "",
        item.issue || "",
        item.suggestion || "",
        item.priority || "medium",
        item.followUpCriteria || item.follow_up_criteria || ""
      ]
    );
    inserted.push(row.rows[0]);
  }
  return inserted;
}

async function saveImprovementChecks(rootPath, analysisRunId, priorSuggestions, currentSuggestions) {
  const checks = [];
  for (const prior of priorSuggestions) {
    const current = currentSuggestions.find((s) => {
      return (s.file || "") === (prior.file_path || "") && (s.function || "") === (prior.function_name || "");
    });
    let status = "implemented";
    let explanation = "The previous issue was not repeated in the latest analysis.";
    if (current && String(current.suggestion || "").toLowerCase() === String(prior.suggestion || "").toLowerCase()) {
      status = "not_implemented";
      explanation = "The same improvement is still suggested for this function.";
    } else if (current) {
      status = "partially_implemented";
      explanation = "The function still has related improvement feedback, but the suggestion changed.";
    } else if (!prior.file_path) {
      status = "obsolete";
      explanation = "The previous suggestion had no stable file reference.";
    }
    const row = await query(
      `INSERT INTO improvement_checks (suggestion_id, analysis_run_id, status, explanation)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [prior.id, analysisRunId, status, explanation]
    );
    await query(
      "UPDATE improvement_suggestions SET status=$1, updated_at=NOW() WHERE id=$2",
      [status === "implemented" ? "closed" : "open", prior.id]
    );
    checks.push(row.rows[0]);
  }
  if (checks.length) {
    await saveLearningEvent(rootPath, "improvements_checked", { analysisRunId, checkCount: checks.length });
  }
  return checks;
}

async function upsertStyleProfile(rootPath, profile) {
  const row = await query(
    `INSERT INTO code_style_profiles (root_path, profile_json, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (root_path)
     DO UPDATE SET profile_json=$2, updated_at=NOW()
     RETURNING *`,
    [rootPath, profile]
  );
  return row.rows[0];
}

async function upsertPromptProfile(rootPath, profile) {
  const row = await query(
    `INSERT INTO prompt_profiles (root_path, profile_json, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (root_path)
     DO UPDATE SET profile_json=$2, updated_at=NOW()
     RETURNING *`,
    [rootPath, profile]
  );
  return row.rows[0];
}

export async function saveLearningEvent(rootPath, eventType, payload = {}) {
  const row = await query(
    `INSERT INTO learning_events (root_path, event_type, payload)
     VALUES ($1,$2,$3)
     RETURNING *`,
    [rootPath, eventType, payload]
  );
  return row.rows[0];
}

export async function listOpenImprovementSuggestions(rootPath, limit = 100) {
  const rows = await query(
    `SELECT * FROM improvement_suggestions
     WHERE root_path=$1 AND status='open'
     ORDER BY created_at DESC
     LIMIT $2`,
    [rootPath, limit]
  );
  return rows.rows;
}

export async function listImprovementSuggestions(rootPath, limit = 100, offset = 0) {
  const params = [];
  let where = "";
  if (rootPath) {
    params.push(rootPath);
    where = "WHERE root_path=$1";
  }
  params.push(limit, offset);
  const rows = await query(
    `SELECT * FROM improvement_suggestions
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.rows;
}

export async function getLearningProfile(rootPath) {
  const style = await query("SELECT * FROM code_style_profiles WHERE root_path=$1 LIMIT 1", [rootPath]);
  const prompt = await query("SELECT * FROM prompt_profiles WHERE root_path=$1 LIMIT 1", [rootPath]);
  const events = await query(
    `SELECT * FROM learning_events WHERE root_path=$1 ORDER BY created_at DESC LIMIT 20`,
    [rootPath]
  );
  const improvements = await listImprovementSuggestions(rootPath, 20, 0);
  return {
    rootPath,
    styleProfile: style.rows[0]?.profile_json || {},
    promptProfile: prompt.rows[0]?.profile_json || {},
    improvements,
    learningEvents: events.rows
  };
}

export async function listCodebaseSummaries(limit = 20, offset = 0) {
  await ensureSummariesTable();
  const rows = await query(
    `SELECT s.id, s.root_path, s.project_id, s.analysis_version, s.title, s.description, s.model,
            s.started_at, s.finished_at, s.duration_ms, s.stage_timings, s.created_at,
            p.name AS project_name
     FROM codebase_summaries s
     LEFT JOIN projects p ON p.id = s.project_id
     ORDER BY s.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.rows.map(withSummaryAliases);
}

export async function listProjectCodebaseSummaries(project, limit = 40, offset = 0) {
  await ensureSummariesTable();
  const rows = await query(
    `SELECT s.id, s.root_path, s.project_id, s.analysis_version, s.title, s.description, s.model,
            s.started_at, s.finished_at, s.duration_ms, s.stage_timings, s.created_at,
            p.name AS project_name
     FROM codebase_summaries s
     LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.project_id=$1 OR ($2 <> '' AND s.root_path=$2)
     ORDER BY s.analysis_version DESC, s.created_at DESC
     LIMIT $3 OFFSET $4`,
    [project.id, project.root_path || "", limit, offset]
  );
  return rows.rows.map(withSummaryAliases);
}

export async function getCodebaseSummaryById(id) {
  await ensureSummariesTable();
  const row = await query(
    `SELECT s.id, s.root_path, s.project_id, s.analysis_version, s.title, s.description, s.full_report, s.analysis_json, s.model,
            s.started_at, s.finished_at, s.duration_ms, s.stage_timings, s.created_at,
            p.name AS project_name
     FROM codebase_summaries s
     LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.id=$1
     LIMIT 1`,
    [id]
  );
  return withSummaryAliases(row.rows[0]) || null;
}

export async function addSummaryAsProject(summaryId) {
  await ensureSummariesTable();
  const summary = await getCodebaseSummaryById(summaryId);
  if (!summary) return null;

  const safeRoot = resolveSafePath(summary.root_path);
  const metadata = getProjectMetadata({ ...summary, root_path: safeRoot });
  const existing = await query("SELECT * FROM projects WHERE root_path=$1 LIMIT 1", [safeRoot]);

  let project;
  let created = false;
  let updated = false;
  if (existing.rowCount) {
    const row = await query(
      `UPDATE projects
       SET name=$1, goals=$2, tech_stack=$3, timeline=$4, budget=$5, root_path=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING *`,
      [metadata.name, metadata.goals, metadata.techStack, metadata.timeline, metadata.budget, safeRoot, existing.rows[0].id]
    );
    project = row.rows[0];
    updated = true;
  } else {
    const row = await query(
      `INSERT INTO projects (name, goals, tech_stack, timeline, budget, root_path)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [metadata.name, metadata.goals, metadata.techStack, metadata.timeline, metadata.budget, safeRoot]
    );
    project = row.rows[0];
    created = true;
  }

  await query("UPDATE codebase_summaries SET project_id=$1 WHERE id=$2", [project.id, summary.id]);
  const linkedSummary = await getCodebaseSummaryById(summary.id);
  return { project, summary: linkedSummary, created, updated };
}
