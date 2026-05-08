import { watch } from "node:fs";
import path from "node:path";
import { resolveSafePath } from "./structure.js";
import { logError, logInfo } from "./logger.js";

const clients = new Set();
const watchers = new Map();

function sendEvent(res, event) {
  res.write(`event: fs\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function ensureWatcher(rootPath) {
  const safe = resolveSafePath(rootPath);
  if (watchers.has(safe)) {
    watchers.get(safe).count += 1;
    return safe;
  }
  const entry = { count: 1, watcher: null, enabled: false };
  watchers.set(safe, entry);

  try {
    // Docker Desktop bind mounts can hang or crash with recursive watches. Watching
    // the current folder non-recursively is enough to trigger UI refreshes safely.
    entry.watcher = watch(safe, { recursive: false }, (eventType, filename) => {
      const changedPath = filename ? path.resolve(safe, filename.toString()) : safe;
      const payload = {
        type: eventType === "rename" ? "renamed" : "updated",
        root: safe,
        path: changedPath,
        ts: new Date().toISOString()
      };
      for (const c of clients) {
        if (changedPath.startsWith(c.root)) sendEvent(c.res, payload);
      }
    });
    entry.enabled = true;
    entry.watcher.on("error", (error) => {
      logError("fs_watcher_error", {
        root: safe,
        message: error.message,
        code: error.code || "FS_WATCH_ERROR"
      });
      for (const c of clients) {
        if (c.root === safe) {
          sendEvent(c.res, {
            type: "watcher_error",
            root: safe,
            message: error.message,
            ts: new Date().toISOString()
          });
        }
      }
      releaseWatcher(safe, { force: true });
    });
  } catch (error) {
    logError("fs_watcher_start_failed", {
      root: safe,
      message: error.message,
      code: error.code || "FS_WATCH_START_FAILED"
    });
    entry.enabled = false;
  }

  return safe;
}

function releaseWatcher(rootPath, options = {}) {
  const item = watchers.get(rootPath);
  if (!item) return;
  item.count = options.force ? 0 : item.count - 1;
  if (item.count <= 0) {
    try {
      item.watcher?.close();
    } catch {
      // Closing a failed watcher should never bring down the API.
    }
    watchers.delete(rootPath);
  }
}

export function registerFsEventStream(req, res) {
  const rootParam = String(req.query.root || "").trim() || process.env.FS_BASE_PATH || process.cwd();
  let root = null;
  try {
    root = ensureWatcher(rootParam);
  } catch (error) {
    res.statusCode = error.statusCode || 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: { message: error.message, code: error.code || "FS_EVENTS_FAILED" } }));
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const client = { res, root };
  clients.add(client);
  const watcher = watchers.get(root);
  sendEvent(res, {
    type: "connected",
    root,
    watcherEnabled: Boolean(watcher?.enabled),
    mode: watcher?.enabled ? "watch" : "polling-only",
    ts: new Date().toISOString()
  });
  logInfo("fs_events_connected", { root, watcherEnabled: Boolean(watcher?.enabled) });
  const ping = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
    releaseWatcher(root);
  });
}
