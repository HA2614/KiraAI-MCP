import { randomUUID } from "node:crypto";
import { summarizeCodebaseWithCodex } from "./codexCodebaseSummary.js";
import { addSummaryAsProject, saveCodebaseSummary, updateCodebaseSummaryTiming } from "./analysisStore.js";
import { createRunTimer } from "./performanceTiming.js";

const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

export function startCodebaseSummaryJob(targetPath, options = {}) {
  const jobId = randomUUID();
  const job = {
    jobId,
    status: "queued",
    progress: 0,
    stage: "queued",
    message: "Queued",
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    durationMs: null,
    stageTimings: {},
    updatedAt: nowIso(),
    result: null,
    error: null,
    logs: []
  };
  jobs.set(jobId, job);

  void runJob(jobId, targetPath, options);
  return job;
}

async function runJob(jobId, targetPath, options = {}) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "running";
  job.progress = 1;
  job.stage = "start";
  job.message = "Starting analysis";
  job.startedAt = nowIso();
  job.updatedAt = nowIso();
  const timer = createRunTimer({
    startedAt: job.startedAt,
    startMs: new Date(job.startedAt).getTime()
  });

  try {
    timer.mark("codex_analyzer", {
      projectId: options.projectId || null
    });
    const result = await summarizeCodebaseWithCodex(targetPath, {
      onProgress: (update) => {
        const j = jobs.get(jobId);
        if (!j) return;
        j.progress = Math.max(0, Math.min(100, Number(update.progress || 0)));
        j.stage = update.stage || j.stage;
        j.message = update.message || j.message;
        j.elapsedMs = Math.max(0, Date.now() - new Date(j.startedAt || j.createdAt).getTime());
        j.updatedAt = nowIso();
      },
      onLog: (entry) => {
        const j = jobs.get(jobId);
        if (!j) return;
        j.logs.push(entry);
        if (j.logs.length > 300) {
          j.logs = j.logs.slice(-300);
        }
        j.updatedAt = nowIso();
      }
    });

    for (const [stage, timing] of Object.entries(result.stageTimings?.stages || {})) {
      timer.record(stage, timing);
    }
    timer.mark("save_summary_learning");
    const saved = await saveCodebaseSummary({
      ...result,
      projectId: options.projectId || null,
      startedAt: timer.startedAt,
      stageTimings: timer.snapshot()
    });
    const projectLink = options.projectId ? await addSummaryAsProject(saved.id) : null;
    const finished = timer.finish("done", {
      summaryId: saved.id,
      projectId: projectLink?.project?.id || saved.projectId || null
    });
    const timedSummary = await updateCodebaseSummaryTiming(saved.id, finished);

    job.status = "done";
    job.progress = 100;
    job.stage = "done";
    job.message = "Analysis complete";
    job.finishedAt = finished.finishedAt;
    job.elapsedMs = finished.durationMs;
    job.durationMs = finished.durationMs;
    job.stageTimings = finished.stageTimings;
    job.result = {
      ...result,
      summaryId: saved.id,
      analysisVersion: saved.analysisVersion,
      projectId: projectLink?.project?.id || saved.projectId,
      projectName: projectLink?.project?.name || saved.projectName,
      startedAt: finished.startedAt,
      finishedAt: finished.finishedAt,
      durationMs: finished.durationMs,
      stageTimings: timedSummary?.stageTimings || finished.stageTimings,
      analysisRun: saved.analysisRun,
      improvementChecks: saved.improvementChecks || [],
      styleProfile: saved.styleProfile?.profile_json || {},
      promptProfile: saved.promptProfile?.profile_json || {},
      learningEvents: saved.learningEvents || []
    };
    job.updatedAt = nowIso();
  } catch (error) {
    const failed = timer.finish("failed", { errorCode: error.code || "ANALYSIS_JOB_FAILED" });
    job.status = "failed";
    job.stage = "failed";
    job.message = error.message || "Analysis failed";
    job.finishedAt = failed.finishedAt;
    job.elapsedMs = failed.durationMs;
    job.durationMs = failed.durationMs;
    job.stageTimings = failed.stageTimings;
    job.error = {
      message: error.message || "Unknown error",
      code: error.code || "ANALYSIS_JOB_FAILED",
      details: error.details || null
    };
    job.updatedAt = nowIso();
  }
}

export function getCodebaseSummaryJob(jobId) {
  return jobs.get(jobId) || null;
}
