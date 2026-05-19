import axios from "axios";

const API_BASE_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/+$/, "") || "/api";
const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, "");

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: Number(import.meta.env.VITE_API_TIMEOUT_MS || 15000),
  withCredentials: true
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

function normalizeApiError(error) {
  const payload = error?.response?.data;
  if (payload?.ok === false) {
    const err = new Error(payload.error?.message || "Request failed");
    err.details = payload.error;
    return err;
  }
  if (error?.response?.status) {
    return new Error(`Request failed (${error.response.status})`);
  }
  return error;
}

async function request(promise) {
  try {
    return unwrap(await promise);
  } catch (error) {
    throw normalizeApiError(error);
  }
}

export async function apiGet(url, config = {}) {
  return request(client.get(url, config));
}

export async function apiPost(url, body = {}, config = {}) {
  return request(client.post(url, body, config));
}

export async function apiPut(url, body = {}, config = {}) {
  return request(client.put(url, body, config));
}

export async function apiPatch(url, body = {}, config = {}) {
  return request(client.patch(url, body, config));
}

export async function apiDelete(url, config = {}) {
  return request(client.delete(url, config));
}

export async function importProject(targetPath) {
  return apiPost("/projects/import", { targetPath });
}

export async function createProjectFolder(payload) {
  return apiPost("/projects/create-folder", payload);
}

export async function authStatus() {
  return apiGet("/auth/status");
}

export async function setupAccount(email, password, displayName = "") {
  return apiPost("/auth/setup", { email, password, displayName });
}

export async function login(email, password) {
  return apiPost("/auth/login", { email, password });
}

export async function logout() {
  return apiPost("/auth/logout", {});
}

export async function getInvite(token) {
  return apiGet(`/invites/${encodeURIComponent(token)}`);
}

export async function acceptInvite(token, payload = {}) {
  return apiPost(`/invites/${encodeURIComponent(token)}/accept`, payload);
}

export async function createProjectInvite(projectId, email) {
  return apiPost(`/projects/${projectId}/invites`, { email });
}

export async function getProjectMembers(projectId) {
  return apiGet(`/projects/${projectId}/members`);
}

export async function removeProjectMember(projectId, userId) {
  return apiDelete(`/projects/${projectId}/members/${userId}`);
}

export async function revokeProjectInvite(projectId, inviteId) {
  return apiPost(`/projects/${projectId}/invites/${inviteId}/revoke`, {});
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
  return new EventSource(`${API_ORIGIN}/api/fs/events?root=${encodeURIComponent(root)}`, { withCredentials: true });
}

export async function createCodeJob(projectId, userPrompt, options = {}) {
  return apiPost("/code-jobs", { projectId, userPrompt, responseMode: options.responseMode || "auto" });
}

export async function getCodeJob(id) {
  return apiGet(`/code-jobs/${id}`);
}

export function codeJobAssetUrl(jobId, assetId) {
  return `${API_BASE_URL}/code-jobs/${jobId}/assets/${assetId}`;
}

export async function listCodeJobs(limit = 20, offset = 0, options = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (options.status) params.set("status", options.status);
  if (options.type) params.set("type", options.type);
  return apiGet(`/code-jobs?${params.toString()}`);
}

export async function listProjectCodeJobs(projectId, options = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit || 30));
  params.set("offset", String(options.offset || 0));
  if (options.status) params.set("status", options.status);
  if (options.type) params.set("type", options.type);
  return apiGet(`/projects/${projectId}/code-jobs?${params.toString()}`);
}

export async function createCodeStructureJob(projectId, payload = {}) {
  return apiPost(`/projects/${projectId}/code-structure-jobs`, payload);
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
  return new EventSource(`${API_ORIGIN}/api/code-jobs/${id}/events`, { withCredentials: true });
}

export function openMlJobEvents(id) {
  return new EventSource(`${API_ORIGIN}/api/ml/jobs/${id}/events`, { withCredentials: true });
}
