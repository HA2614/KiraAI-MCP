import { useEffect } from "react";

export const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

export function upsertById(items, nextItem) {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex((item) => Number(item.id) === Number(nextItem.id));
  if (index === -1) return [nextItem, ...list];
  return list.map((item, i) => (i === index ? { ...item, ...nextItem } : item));
}

export function useMlJobEvents({ activeJobIds, openMlJobEvents, setJobs, refreshMlPanel }) {
  useEffect(() => {
    if (!activeJobIds.length) return undefined;
    const streams = activeJobIds.map((jobId) => {
      const stream = openMlJobEvents(jobId);
      stream.addEventListener("ml-job", (event) => {
        const payload = JSON.parse(event.data || "{}");
        if (payload.job) {
          setJobs((prev) => (
            ACTIVE_JOB_STATUSES.has(payload.job.status)
              ? upsertById(prev, payload.job)
              : prev.filter((job) => Number(job.id) !== Number(payload.job.id))
          ));
        }
      });
      stream.onerror = () => stream.close();
      return stream;
    });
    const poll = setInterval(() => refreshMlPanel({ silent: true }).catch(() => null), 3000);
    return () => {
      streams.forEach((stream) => stream.close());
      clearInterval(poll);
    };
  }, [activeJobIds.join("|")]);
}
