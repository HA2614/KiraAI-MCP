import axios from "axios";

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:4000/api",
  timeout: Number(import.meta.env.VITE_API_TIMEOUT_MS || 15000)
});

function unwrap(response) {
  if (response?.data?.ok) return response.data.data;
  if (response?.data && response.data.ok === false) {
    const err = new Error(response.data.error?.message || "Request failed");
    err.details = response.data.error;
    throw err;
  }
  return response.data;
}

export async function apiGet(url, config = {}) {
  const res = await client.get(url, config);
  return unwrap(res);
}

export async function apiPost(url, body = {}, config = {}) {
  const res = await client.post(url, body, config);
  return unwrap(res);
}

export async function apiPut(url, body = {}, config = {}) {
  const res = await client.put(url, body, config);
  return unwrap(res);
}

export async function apiPatch(url, body = {}, config = {}) {
  const res = await client.patch(url, body, config);
  return unwrap(res);
}

export async function apiDelete(url, config = {}) {
  const res = await client.delete(url, config);
  return unwrap(res);
}

export async function importProject(targetPath) {
  return apiPost("/projects/import", { targetPath });
}

export async function fsList(targetPath) {
  return apiPost("/fs/list", { targetPath });
}

export async function fsTree(targetPath, depth = 2) {
  return apiPost("/fs/tree", { targetPath, depth });
}

export async function fsRead(targetPath) {
  return apiPost("/fs/read", { targetPath });
}

export async function fsWrite(targetPath, content, conflictPolicy = "overwrite") {
  return apiPost("/fs/write", { targetPath, content, conflictPolicy });
}

export async function fsMkdir(targetPath) {
  return apiPost("/fs/mkdir", { targetPath });
}

export async function fsCreateFile(targetPath, content = "", conflictPolicy = "fail") {
  return apiPost("/fs/create-file", { targetPath, content, conflictPolicy });
}

export async function fsDeletePath(targetPath) {
  return apiPost("/fs/delete", { targetPath });
}

export async function fsRename(sourcePath, newName, conflictPolicy = "fail") {
  return apiPost("/fs/rename", { sourcePath, newName, conflictPolicy });
}

export async function fsMove(sourcePath, destinationPath, conflictPolicy = "fail") {
  return apiPost("/fs/move", { sourcePath, destinationPath, conflictPolicy });
}

export async function fsCopy(sourcePath, destinationPath, conflictPolicy = "fail") {
  return apiPost("/fs/copy", { sourcePath, destinationPath, conflictPolicy });
}

export function openFsEvents(root) {
  const base = (import.meta.env.VITE_API_URL || "http://localhost:4000/api").replace(/\/api\/?$/, "");
  return new EventSource(`${base}/api/fs/events?root=${encodeURIComponent(root)}`);
}

export async function createCodeJob(projectId, userPrompt) {
  return apiPost("/code-jobs", { projectId, userPrompt });
}

export async function getCodeJob(id) {
  return apiGet(`/code-jobs/${id}`);
}

export async function listCodeJobs(limit = 20, offset = 0) {
  return apiGet(`/code-jobs?limit=${limit}&offset=${offset}`);
}

export async function getProjectPerformanceRuns(projectId, options = {}) {
  const params = new URLSearchParams();
  if (options.type) params.set("type", options.type);
  params.set("limit", String(options.limit || 30));
  return apiGet(`/projects/${projectId}/performance-runs?${params.toString()}`);
}

export async function applyCodeJob(id) {
  return apiPost(`/code-jobs/${id}/apply`, {});
}

export async function rejectCodeJob(id) {
  return apiPost(`/code-jobs/${id}/reject`, {});
}

export async function addSummaryAsProject(id) {
  return apiPost(`/analysis/summaries/${id}/add-as-project`, {});
}

export async function healthCheck(timeout = 3000) {
  return apiGet("/health", {
    timeout,
    headers: { "Cache-Control": "no-cache" }
  });
}

export function openCodeJobEvents(id) {
  const base = (import.meta.env.VITE_API_URL || "http://localhost:4000/api").replace(/\/api\/?$/, "");
  return new EventSource(`${base}/api/code-jobs/${id}/events`);
}

export function openMlJobEvents(id) {
  const base = (import.meta.env.VITE_API_URL || "http://localhost:4000/api").replace(/\/api\/?$/, "");
  return new EventSource(`${base}/api/ml/jobs/${id}/events`);
}
