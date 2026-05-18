import { useEffect } from "react";

export const CODE_JOB_RUNNING_STATUSES = new Set(["queued", "planning", "running"]);
export const CODE_JOB_RESTORABLE_STATUSES = new Set(["queued", "planning", "running", "awaiting_review"]);
export const CODE_WORKER_LEGACY_STORAGE_KEY = "mcpserver.codeWorker.v1";
export const CODE_WORKER_SESSIONS_STORAGE_KEY = "mcpserver.codeWorker.sessions.v1";

export function projectKey(projectId) {
  if (projectId === null || projectId === undefined || projectId === "") return null;
  return String(projectId);
}

export function emptyCodeSession() {
  return {
    prompt: "",
    responseMode: "auto",
    job: null,
    logs: [],
    busy: false,
    restored: false,
    terminalStatus: "idle",
    lastLogAt: null
  };
}

function readJsonStorage(key, fallback = null) {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function normalizeResponseMode(value) {
  return ["auto", "code", "image"].includes(value) ? value : "auto";
}

function logFingerprint(log) {
  if (!log) return "";
  return `${log.ts || ""}|${log.message || ""}|${JSON.stringify(log.data || {})}`;
}

export function mergeCodeLogs(...logLists) {
  const seen = new Set();
  const merged = [];
  for (const list of logLists) {
    if (!Array.isArray(list)) continue;
    for (const log of list) {
      const key = logFingerprint(log);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(log);
    }
  }
  return merged.slice(-300);
}

export function latestLogTimestamp(logs) {
  const list = Array.isArray(logs) ? logs : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.ts) return list[index].ts;
  }
  return null;
}

export function normalizeCodeSession(session = {}) {
  const jobResponseMode = session.job?.request_metadata?.responseMode || session.job?.response_metadata?.responseMode;
  return {
    ...emptyCodeSession(),
    ...session,
    prompt: session.prompt || session.job?.user_prompt || "",
    responseMode: normalizeResponseMode(session.responseMode || jobResponseMode),
    logs: Array.isArray(session.logs) ? session.logs : [],
    busy: Boolean(session.busy),
    restored: Boolean(session.restored)
  };
}

export function applyJobToCodeSession(session, job, options = {}) {
  const current = normalizeCodeSession(session);
  const logs = mergeCodeLogs(current.logs, job?.logs);
  const running = CODE_JOB_RUNNING_STATUSES.has(job?.status);
  const restorable = CODE_JOB_RESTORABLE_STATUSES.has(job?.status);
  const nextJob = job
    ? {
        ...job,
        assets: Array.isArray(job.assets) && job.assets.length
          ? job.assets
          : Number(job.id) === Number(current.job?.id) && Array.isArray(current.job?.assets)
            ? current.job.assets
            : job.assets
      }
    : current.job;
  return {
    ...current,
    job: nextJob,
    prompt: job?.user_prompt || current.prompt || "",
    responseMode: normalizeResponseMode(current.responseMode || job?.request_metadata?.responseMode),
    logs,
    busy: running,
    restored: options.restored ? restorable : current.restored && restorable,
    terminalStatus: running ? (current.terminalStatus === "live" ? "live" : "polling") : restorable ? "review" : "idle",
    lastLogAt: latestLogTimestamp(logs) || current.lastLogAt
  };
}

export function isNewerJob(candidate, existing) {
  if (!existing) return true;
  const candidateDate = new Date(candidate.updated_at || candidate.created_at || 0).getTime();
  const existingDate = new Date(existing.updated_at || existing.created_at || 0).getTime();
  if (candidateDate !== existingDate) return candidateDate > existingDate;
  return Number(candidate.id || 0) > Number(existing.id || 0);
}

export function readSavedCodeWorkerSessions() {
  const saved = readJsonStorage(CODE_WORKER_SESSIONS_STORAGE_KEY, null);
  if (saved?.sessions && typeof saved.sessions === "object") return saved;

  const legacy = readJsonStorage(CODE_WORKER_LEGACY_STORAGE_KEY, null);
  const key = projectKey(legacy?.projectId);
  if (!key) return { selectedProjectId: null, sessions: {} };
  return {
    selectedProjectId: legacy.projectId,
    sessions: {
      [key]: {
        projectId: legacy.projectId,
        jobId: legacy.jobId || null,
        prompt: legacy.prompt || "",
        responseMode: normalizeResponseMode(legacy.responseMode),
        status: legacy.status || null,
        updatedAt: legacy.updatedAt || null
      }
    }
  };
}

export function writeCodeWorkerSessions(selectedProjectId, sessions) {
  if (typeof window === "undefined") return;
  const serialized = { selectedProjectId: selectedProjectId || null, sessions: {} };
  for (const [key, rawSession] of Object.entries(sessions || {})) {
    const session = normalizeCodeSession(rawSession);
    if (!session.prompt.trim() && !session.job?.id && session.responseMode === "auto") continue;
    serialized.sessions[key] = {
      projectId: Number.isNaN(Number(key)) ? key : Number(key),
      jobId: session.job?.id || null,
      prompt: session.job?.user_prompt || session.prompt || "",
      responseMode: session.responseMode,
      status: session.job?.status || null,
      updatedAt: new Date().toISOString()
    };
  }
  window.localStorage.setItem(CODE_WORKER_SESSIONS_STORAGE_KEY, JSON.stringify(serialized));
  window.localStorage.removeItem(CODE_WORKER_LEGACY_STORAGE_KEY);
}

export function codeJobProjectId(job) {
  return job?.project_id ?? job?.projectId ?? null;
}

export function expectedCodeJobAssetCount(job = {}) {
  const metadata = job?.response_metadata && typeof job.response_metadata === "object" ? job.response_metadata : {};
  if (Number(job?.asset_count || 0) > 0) return Number(job.asset_count);
  if (Number(metadata.assetCount || 0) > 0) return Number(metadata.assetCount);
  return Array.isArray(metadata.assetIds) ? metadata.assetIds.length : 0;
}

export function needsCodeJobAssetSync(job = {}) {
  if (!job?.id || job.status !== "done" || job.response_kind !== "image") return false;
  const expected = expectedCodeJobAssetCount(job);
  const loaded = Array.isArray(job.assets) ? job.assets.length : 0;
  return expected > loaded;
}

export function useCodeJobStreams({
  codeSessions,
  runningCodeJobSignature,
  updateCodeSession,
  fetchCodeJobSnapshot,
  openCodeJobEvents
}) {
  useEffect(() => {
    if (!runningCodeJobSignature) return undefined;
    const cleanups = [];
    const runningSessions = Object.entries(codeSessions)
      .filter(([, session]) => session?.job?.id && CODE_JOB_RUNNING_STATUSES.has(session.job.status));

    for (const [key, session] of runningSessions) {
      const jobId = session.job.id;
      let stream = openCodeJobEvents(jobId);
      let streamClosed = false;

      const syncSnapshot = () => {
        fetchCodeJobSnapshot(key, jobId).catch(() => null);
      };

      updateCodeSession(key, { terminalStatus: "connecting" });
      syncSnapshot();

      const poll = setInterval(syncSnapshot, 1500);

      stream.onopen = () => {
        updateCodeSession(key, { terminalStatus: "live" });
        syncSnapshot();
      };

      stream.addEventListener("code-job", (event) => {
        const payload = JSON.parse(event.data || "{}");
        const eventProjectId = projectKey(codeJobProjectId(payload.job) || key);
        if (!eventProjectId) return;
        updateCodeSession(eventProjectId, (current) => {
          const logs = mergeCodeLogs(current.logs, payload.job?.logs, payload.entry ? [payload.entry] : []);
          const withLogs = {
            ...current,
            logs,
            terminalStatus: "live",
            lastLogAt: latestLogTimestamp(logs) || current.lastLogAt
          };
          return payload.job ? applyJobToCodeSession(withLogs, payload.job) : withLogs;
        });
      });

      stream.onerror = () => {
        if (streamClosed) return;
        updateCodeSession(key, { terminalStatus: "polling" });
        stream.close();
        streamClosed = true;
      };

      cleanups.push(() => {
        clearInterval(poll);
        streamClosed = true;
        stream.close();
      });
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [runningCodeJobSignature]);
}
