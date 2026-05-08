export function createRunTimer(options = {}) {
  const startMs = Number(options.startMs || Date.now());
  const startedAt = options.startedAt || new Date(startMs).toISOString();
  const stages = { ...(options.stages || {}) };
  let currentStage = options.currentStage || null;
  let currentStartedMs = Number(options.currentStartedMs || startMs);

  function closeCurrent(nowMs = Date.now()) {
    if (!currentStage) return;
    const current = stages[currentStage] || {};
    const elapsed = Math.max(0, nowMs - currentStartedMs);
    stages[currentStage] = {
      ...current,
      durationMs: Math.max(0, Number(current.durationMs || 0)) + elapsed,
      finishedAt: new Date(nowMs).toISOString()
    };
    currentStage = null;
  }

  function snapshot(extra = {}) {
    return {
      startedAt,
      currentStage,
      stages,
      ...extra
    };
  }

  function mark(stage, metadata = {}) {
    const nowMs = Date.now();
    closeCurrent(nowMs);
    currentStage = stage;
    currentStartedMs = nowMs;
    stages[stage] = {
      ...(stages[stage] || {}),
      ...metadata,
      startedAt: new Date(nowMs).toISOString(),
      durationMs: Number(stages[stage]?.durationMs || 0)
    };
    return snapshot();
  }

  function record(stage, metadata = {}) {
    stages[stage] = {
      ...(stages[stage] || {}),
      ...metadata
    };
    return snapshot();
  }

  function finish(status, metadata = {}) {
    const nowMs = Date.now();
    closeCurrent(nowMs);
    return {
      startedAt,
      finishedAt: new Date(nowMs).toISOString(),
      durationMs: Math.max(0, nowMs - startMs),
      stageTimings: snapshot({ status, ...metadata })
    };
  }

  return { startedAt, mark, record, snapshot, finish };
}

export function durationFromDates(startedAt, finishedAt = new Date()) {
  const start = new Date(startedAt || Date.now()).getTime();
  const end = new Date(finishedAt || Date.now()).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function finishTimingSnapshot(snapshot = {}, fallbackStartedAt = new Date(), status = "done", metadata = {}) {
  const startedAt = snapshot.startedAt || fallbackStartedAt || new Date();
  const finishedAt = new Date();
  const stages = { ...(snapshot.stages || {}) };
  const currentStage = snapshot.currentStage;

  if (currentStage && stages[currentStage]?.startedAt) {
    const stageStartMs = new Date(stages[currentStage].startedAt).getTime();
    const finishedMs = finishedAt.getTime();
    if (Number.isFinite(stageStartMs) && finishedMs >= stageStartMs) {
      stages[currentStage] = {
        ...stages[currentStage],
        durationMs: Math.max(0, Number(stages[currentStage].durationMs || 0)) + (finishedMs - stageStartMs),
        finishedAt: finishedAt.toISOString()
      };
    }
  }

  return {
    startedAt,
    finishedAt: finishedAt.toISOString(),
    durationMs: durationFromDates(startedAt, finishedAt) || 0,
    stageTimings: {
      ...snapshot,
      currentStage: null,
      stages,
      status,
      ...metadata
    }
  };
}
