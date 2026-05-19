import { useEffect, useMemo, useState } from "react";
import {
  apiGet,
  apiPost,
  apiPut,
  applyCodeJob,
  acceptInvite,
  authStatus,
  createCodeJob,
  createProjectInvite,
  createProjectFolder,
  fsCopy,
  fsCreateFile,
  fsDeletePath,
  fsList,
  fsMkdir,
  fsMove,
  fsRead,
  fsRename,
  fsTree,
  fsWrite,
  getInvite,
  getCodeJob,
  getProjectMembers,
  getProjectPerformanceRuns,
  healthCheck,
  importProject,
  listCodeJobs,
  listProjectCodeJobs,
  login as authLogin,
  logout as authLogout,
  openCodeJobEvents,
  openFsEvents,
  rejectCodeJob,
  removeProjectMember,
  revokeProjectInvite,
  setupAccount
} from "./api";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectsView } from "@/features/projects-view";
import { PlansView } from "@/features/plans-view";
import { StructureView } from "@/features/structure-view";
import { ExplorerView } from "@/features/explorer-view";
import { AnalyzerView } from "@/features/analyzer-view";
import { CodeWorkerView } from "@/features/code-worker-view";
import {
  CODE_JOB_RESTORABLE_STATUSES,
  CODE_JOB_RUNNING_STATUSES,
  applyJobToCodeSession,
  codeJobProjectId,
  emptyCodeSession,
  needsCodeJobAssetSync,
  isNewerJob,
  normalizeCodeSession,
  projectKey,
  readSavedCodeWorkerSessions,
  useCodeJobStreams,
  writeCodeWorkerSessions
} from "@/features/code-worker-session";
import { SettingsView } from "@/features/settings-view";

const DEFAULT_ROOT = import.meta.env.VITE_DEFAULT_ROOT || "/workspace";
const SETTINGS_STORAGE_KEY = "mcpserver.settings.v1";
const CODE_JOB_ACTIVE_STATUSES = new Set(["queued", "planning", "running", "awaiting_review"]);

function initialConnectionStatus() {
  return {
    status: "checking",
    message: "Checking backend...",
    checkedAt: null,
    latencyMs: null
  };
}

function emptyForm() {
  return { name: "", goals: "", techStack: "", timeline: "", budget: "", rootPath: "" };
}

function readSavedSettings() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function initialSettings() {
  const saved = readSavedSettings();
  return {
    provider: saved.provider || "codex_cli",
    targetPath: saved.targetPath || DEFAULT_ROOT,
    profile: saved.profile || "web+api",
    dryRun: saved.dryRun ?? true,
    overwriteStrategy: saved.overwriteStrategy || "skip_existing",
    structurePrompt: saved.structurePrompt || ""
  };
}

function pathName(value) {
  const cleaned = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return cleaned.split("/").filter(Boolean).pop() || cleaned || "Root";
}

function isBroadFilesystemRoot(value) {
  const cleaned = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return cleaned === "/host" || /^\/host\/[a-z]$/.test(cleaned) || /^[a-z]:$/i.test(cleaned) || /^[a-z]:\/$/i.test(cleaned);
}

function isDefaultWorkspaceRoot(value) {
  const cleaned = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return !cleaned || cleaned === DEFAULT_ROOT || cleaned === "/workspace" || isBroadFilesystemRoot(cleaned);
}

function shallowTreeFromEntries(rootPath, entries = []) {
  return {
    path: rootPath,
    name: pathName(rootPath),
    kind: "directory",
    children: entries
      .filter((entry) => entry.kind === "directory")
      .slice(0, 80)
      .map((entry) => ({
        ...entry,
        children: []
      })),
    truncated: entries.filter((entry) => entry.kind === "directory").length > 80
  };
}

export default function App() {
  const initial = useMemo(() => initialSettings(), []);
  const [authState, setAuthState] = useState({ checking: true, enabled: false, authenticated: false, setupRequired: false, user: null });
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [setupDisplayName, setSetupDisplayName] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [inviteState, setInviteState] = useState({ token: "", invite: null, loading: false, error: "", accepted: null });
  const [tab, setTab] = useState("projects");
  const [form, setForm] = useState(emptyForm());
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(initial);
  const [connectionStatus, setConnectionStatus] = useState(initialConnectionStatus);
  const [savedDefaultPath, setSavedDefaultPath] = useState(initial.targetPath);
  const [historyFilter, setHistoryFilter] = useState({ status: "", provider: "", limit: 20, offset: 0 });
  const [historyRows, setHistoryRows] = useState([]);
  const [compareVersion, setCompareVersion] = useState("");
  const [compareResult, setCompareResult] = useState(null);
  const [structureResult, setStructureResult] = useState(null);
  const [currentPath, setCurrentPath] = useState(initial.targetPath);
  const [explorerLoaded, setExplorerLoaded] = useState(false);
  const [explorerBackStack, setExplorerBackStack] = useState([]);
  const [explorerForwardStack, setExplorerForwardStack] = useState([]);
  const [entries, setEntries] = useState([]);
  const [tree, setTree] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState([]);
  const [fsConnected, setFsConnected] = useState(false);
  const [filter, setFilter] = useState("");
  const [parentPath, setParentPath] = useState(null);
  const [openFilePath, setOpenFilePath] = useState("");
  const [openFileContent, setOpenFileContent] = useState("");
  const [dirtyFile, setDirtyFile] = useState(false);
  const [analysisProjectId, setAnalysisProjectId] = useState(null);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysisJob, setAnalysisJob] = useState(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [projectSummaries, setProjectSummaries] = useState([]);
  const [performanceProjectId, setPerformanceProjectId] = useState(null);
  const [performanceRuns, setPerformanceRuns] = useState([]);
  const [performanceBusy, setPerformanceBusy] = useState(false);
  const [codeProjectId, setCodeProjectId] = useState(null);
  const [codeSessions, setCodeSessions] = useState({});
  const [codeSessionsHydrated, setCodeSessionsHydrated] = useState(false);
  const [codeLearningProfile, setCodeLearningProfile] = useState(null);
  const [codeHistory, setCodeHistory] = useState([]);
  const [codeHistoryBusy, setCodeHistoryBusy] = useState(false);

  const selectedLatestPlan = selectedProject?.plans?.[0] || null;
  const selectedCodeProject = useMemo(
    () => projects.find((project) => Number(project.id) === Number(codeProjectId)) || null,
    [projects, codeProjectId]
  );
  const selectedCodeSession = useMemo(
    () => normalizeCodeSession(codeSessions[projectKey(codeProjectId)]),
    [codeSessions, codeProjectId]
  );
  const codePrompt = selectedCodeSession.prompt;
  const codeMode = selectedCodeSession.responseMode || "auto";
  const codeJob = selectedCodeSession.job;
  const codeBusy = selectedCodeSession.busy;
  const codeLogs = selectedCodeSession.logs;
  const codeSessionRestored = selectedCodeSession.restored;
  const codeTerminalStatus = selectedCodeSession.terminalStatus;
  const codeLastLogAt = selectedCodeSession.lastLogAt;
  const personalWorkspacePath = useMemo(() => {
    if (!authState.enabled || !authState.authenticated) return "";
    if (authState.user?.role === "admin") return "";
    return authState.user?.workspaceRoot || "";
  }, [authState.enabled, authState.authenticated, authState.user]);
  const projectDefaultPath = personalWorkspacePath || settings.targetPath || DEFAULT_ROOT;
  const runningCodeJobSignature = useMemo(() => {
    return Object.entries(codeSessions)
      .filter(([, session]) => session?.job?.id && CODE_JOB_RUNNING_STATUSES.has(session.job.status))
      .map(([key, session]) => `${key}:${session.job.id}:${session.job.status}`)
      .sort()
      .join("|");
  }, [codeSessions]);
  const imageAssetSyncSignature = useMemo(() => {
    return Object.entries(codeSessions)
      .filter(([, session]) => needsCodeJobAssetSync(session?.job))
      .map(([key, session]) => `${key}:${session.job.id}:${session.job.updated_at || ""}`)
      .sort()
      .join("|");
  }, [codeSessions]);
  const selectedLatestJson = selectedLatestPlan?.plan_json || null;
  const sortedMilestones = useMemo(() => [...(selectedLatestJson?.milestones || [])].sort((a, b) => (a.week || 0) - (b.week || 0)), [selectedLatestJson]);
  const inviteToken = useMemo(() => {
    if (typeof window === "undefined") return "";
    const match = window.location.pathname.match(/^\/invite\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }, []);

  useEffect(() => {
    authStatus()
      .then((status) => {
        setAuthState({
          checking: false,
          enabled: Boolean(status.enabled),
          authenticated: Boolean(status.authenticated),
          setupRequired: Boolean(status.setupRequired),
          user: status.user || null
        });
      })
      .catch((e) => {
        setAuthState({ checking: false, enabled: false, authenticated: true, setupRequired: false, user: null });
        setError(e.message || "Could not check auth status");
      });
  }, []);

  useEffect(() => {
    if (!inviteToken) return;
    setInviteState((prev) => ({ ...prev, token: inviteToken, loading: true, error: "" }));
    getInvite(inviteToken)
      .then((invite) => {
        setInviteState({ token: inviteToken, invite, loading: false, error: "", accepted: null });
        setLoginEmail((current) => current || invite.email || "");
      })
      .catch((e) => setInviteState({ token: inviteToken, invite: null, loading: false, error: e.message || "Invite not found", accepted: null }));
  }, [inviteToken]);

  useEffect(() => {
    if (authState.checking) return;
    checkConnection({ silent: false }).catch(() => null);
    if (authState.enabled && !authState.authenticated) return;
    refreshProjects().catch((e) => setError(e.message));
    restoreCodeWorkerSessions().catch(() => setCodeSessionsHydrated(true));
  }, [authState.checking, authState.enabled, authState.authenticated]);

  useEffect(() => {
    if (!personalWorkspacePath) return;
    if (!isDefaultWorkspaceRoot(settings.targetPath) && !isDefaultWorkspaceRoot(currentPath)) return;
    setSettings((prev) => ({ ...prev, targetPath: isDefaultWorkspaceRoot(prev.targetPath) ? personalWorkspacePath : prev.targetPath }));
    setSavedDefaultPath(personalWorkspacePath);
    if (isDefaultWorkspaceRoot(currentPath)) {
      setCurrentPath(personalWorkspacePath);
      setExplorerLoaded(false);
    }
  }, [personalWorkspacePath]);

  useEffect(() => {
    const run = () => checkConnection({ silent: true }).catch(() => null);
    const interval = setInterval(run, 6000);
    window.addEventListener("online", run);
    window.addEventListener("focus", run);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", run);
      window.removeEventListener("focus", run);
    };
  }, []);

  useEffect(() => {
    if (tab !== "explorer" || explorerLoaded) return;
    loadExplorer(currentPath).then(() => setExplorerLoaded(true)).catch((e) => setError(e.message));
  }, [tab, explorerLoaded, currentPath]);

  useEffect(() => {
    if (tab !== "explorer" || !explorerLoaded || !currentPath) {
      setFsConnected(false);
      return;
    }
    const stream = openFsEvents(currentPath);
    let poll = null;
    stream.addEventListener("fs", () => {
      setFsConnected(true);
      loadExplorer(currentPath).catch(() => null);
    });
    stream.onerror = () => {
      setFsConnected(false);
      stream.close();
      poll = setInterval(() => loadExplorer(currentPath).catch(() => null), 8000);
    };
    return () => {
      stream.close();
      if (poll) clearInterval(poll);
    };
  }, [tab, explorerLoaded, currentPath]);

  useCodeJobStreams({
    codeSessions,
    runningCodeJobSignature,
    updateCodeSession,
    fetchCodeJobSnapshot,
    openCodeJobEvents
  });

  useEffect(() => {
    if (!imageAssetSyncSignature) return;
    const pending = Object.entries(codeSessions)
      .filter(([, session]) => needsCodeJobAssetSync(session?.job))
      .map(([key, session]) => ({ key, jobId: session.job.id }));
    for (const item of pending) {
      fetchCodeJobSnapshot(item.key, item.jobId).catch(() => null);
    }
  }, [imageAssetSyncSignature]);

  useEffect(() => {
    if (!codeSessionsHydrated) return;
    writeCodeWorkerSessions(codeProjectId, codeSessions);
  }, [codeSessionsHydrated, codeProjectId, codeSessions]);

  useEffect(() => {
    if (!codeProjectId && selectedProjectId) setCodeProjectId(selectedProjectId);
    if (!analysisProjectId && selectedProjectId) setAnalysisProjectId(selectedProjectId);
  }, [analysisProjectId, codeProjectId, selectedProjectId]);

  useEffect(() => {
    setAnalysisResult(null);
    setAnalysisJob(null);
    loadProjectSummaries(analysisProjectId).catch((e) => setError(e.message));
  }, [analysisProjectId]);

  useEffect(() => {
    const root = selectedCodeProject?.root_path;
    if (!root) {
      setCodeLearningProfile(null);
      return;
    }
    apiGet(`/analysis/learning-profile?rootPath=${encodeURIComponent(root)}`)
      .then(setCodeLearningProfile)
      .catch(() => setCodeLearningProfile(null));
  }, [selectedCodeProject?.root_path]);

  useEffect(() => {
    if (!codeProjectId) {
      setCodeHistory([]);
      return;
    }
    loadCodeHistory(codeProjectId).catch(() => null);
  }, [codeProjectId]);

  async function checkConnection({ silent = false } = {}) {
    const started = Date.now();
    if (!silent) {
      setConnectionStatus((prev) => ({
        ...prev,
        status: "checking",
        message: "Checking backend..."
      }));
    }
    try {
      await healthCheck(2500);
      setConnectionStatus({
        status: "online",
        message: "Backend online",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started
      });
      return true;
    } catch (err) {
      setConnectionStatus({
        status: "offline",
        message: err.code === "ECONNABORTED" ? "Backend timed out" : err.message || "Backend offline",
        checkedAt: new Date().toISOString(),
        latencyMs: null
      });
      return false;
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      const result = authState.setupRequired
        ? await setupAccount(loginEmail, loginPassword, setupDisplayName)
        : await authLogin(loginEmail, loginPassword);
      setLoginEmail("");
      setLoginPassword("");
      setSetupDisplayName("");
      setAuthState({
        checking: false,
        enabled: Boolean(result.enabled),
        authenticated: Boolean(result.authenticated),
        setupRequired: Boolean(result.setupRequired),
        user: result.user || null
      });
    } catch (e) {
      setLoginError(e.message || "Login failed");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    await authLogout().catch(() => null);
    setProjects([]);
    setSelectedProjectId(null);
    setSelectedProject(null);
    setAuthState({ checking: false, enabled: true, authenticated: false, setupRequired: false, user: null });
  }

  async function submitInviteAccept(event) {
    event.preventDefault();
    if (!inviteToken) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const payload = authState.authenticated ? {} : { password: loginPassword, displayName: setupDisplayName };
      const result = await acceptInvite(inviteToken, payload);
      setInviteState((prev) => ({ ...prev, accepted: result, error: "" }));
      setLoginPassword("");
      setSetupDisplayName("");
      setAuthState({
        checking: false,
        enabled: true,
        authenticated: true,
        setupRequired: false,
        user: result.user || null
      });
      await refreshProjects();
      if (result.project?.id) {
        setSelectedProjectId(result.project.id);
        setCodeProjectId(result.project.id);
        setAnalysisProjectId(result.project.id);
      }
    } catch (e) {
      setLoginError(e.message || "Could not accept invite");
    } finally {
      setLoginBusy(false);
    }
  }

  async function refreshProjects() {
    const data = await apiGet("/projects");
    setProjects(data);
  }

  async function refreshSelectedProject(projectId = selectedProjectId) {
    if (!projectId) return;
    const data = await apiGet(`/projects/${projectId}`);
    setSelectedProject(data);
    setSelectedProjectId(projectId);
    return data;
  }

  async function loadHistory(projectId = selectedProjectId) {
    if (!projectId) return;
    const params = new URLSearchParams();
    if (historyFilter.status) params.set("status", historyFilter.status);
    if (historyFilter.provider) params.set("provider", historyFilter.provider);
    params.set("limit", String(historyFilter.limit));
    params.set("offset", String(historyFilter.offset));
    setHistoryRows(await apiGet(`/projects/${projectId}/plans?${params.toString()}`));
  }

  async function loadExplorer(p = currentPath, options = {}) {
    const data = await fsList(p);
    if (options.pushHistory && data.path !== currentPath) {
      setExplorerBackStack((prev) => [...prev, currentPath].filter(Boolean).slice(-50));
      setExplorerForwardStack([]);
    }
    setCurrentPath(data.path);
    setParentPath(data.parent);
    setEntries(data.entries || []);
    setTree(shallowTreeFromEntries(data.path, data.entries || []));
    setSelectedPaths([]);
    setExplorerLoaded(true);

    if (!isBroadFilesystemRoot(data.path)) {
      fsTree(data.path, 1)
        .then(setTree)
        .catch(() => null);
    }
  }

  async function navigateExplorer(path) {
    await loadExplorer(path, { pushHistory: true });
  }

  async function goExplorerBack() {
    const previous = explorerBackStack[explorerBackStack.length - 1];
    if (!previous) return;
    setExplorerBackStack((prev) => prev.slice(0, -1));
    setExplorerForwardStack((prev) => [currentPath, ...prev].filter(Boolean).slice(0, 50));
    await loadExplorer(previous);
  }

  async function goExplorerForward() {
    const next = explorerForwardStack[0];
    if (!next) return;
    setExplorerForwardStack((prev) => prev.slice(1));
    setExplorerBackStack((prev) => [...prev, currentPath].filter(Boolean).slice(-50));
    await loadExplorer(next);
  }

  async function saveDefaultSettings(nextSettings = settings) {
    const cleaned = {
      ...nextSettings,
      targetPath: (nextSettings.targetPath || "").trim() || DEFAULT_ROOT
    };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(cleaned));
    setSettings(cleaned);
    setSavedDefaultPath(cleaned.targetPath);
    setCurrentPath(cleaned.targetPath);
    setEntries([]);
    setTree(null);
    setExplorerLoaded(false);
    setNotice(`Default target path opgeslagen: ${cleaned.targetPath}`);
  }

  async function loadProjectSummaries(projectId = analysisProjectId) {
    if (!projectId) {
      setProjectSummaries([]);
      return [];
    }
    const rows = await apiGet(`/projects/${projectId}/analysis-summaries?limit=40&offset=0`);
    setProjectSummaries(rows);
    return rows;
  }

  async function loadProjectPerformanceRuns(projectId, options = {}) {
    if (!projectId) {
      setPerformanceRuns([]);
      setPerformanceProjectId(null);
      return [];
    }
    setPerformanceBusy(true);
    try {
      const rows = await getProjectPerformanceRuns(projectId, { limit: options.limit || 30, type: options.type || "" });
      setPerformanceProjectId(projectId);
      setPerformanceRuns(rows);
      return rows;
    } finally {
      setPerformanceBusy(false);
    }
  }

  async function loadCodeHistory(projectId = codeProjectId, options = {}) {
    const scope = options.scope || "project";
    if (scope !== "all" && !projectId) {
      setCodeHistory([]);
      return [];
    }
    setCodeHistoryBusy(true);
    try {
      const queryOptions = {
        limit: options.limit || 40,
        offset: options.offset || 0,
        status: options.status || "",
        type: options.type || ""
      };
      const rows = scope === "all"
        ? await listCodeJobs(queryOptions.limit, queryOptions.offset, queryOptions)
        : await listProjectCodeJobs(projectId, queryOptions);
      setCodeHistory(rows);
      return rows;
    } finally {
      setCodeHistoryBusy(false);
    }
  }

  function updateCodeSession(projectId, updater) {
    const key = projectKey(projectId);
    if (!key) return;
    setCodeSessions((prev) => {
      const current = normalizeCodeSession(prev[key]);
      const nextSession = typeof updater === "function" ? updater(current) : { ...current, ...updater };
      return { ...prev, [key]: normalizeCodeSession(nextSession) };
    });
  }

  function setCurrentCodePrompt(nextPrompt) {
    updateCodeSession(codeProjectId, (session) => ({
      ...session,
      prompt: typeof nextPrompt === "function" ? nextPrompt(session.prompt) : nextPrompt
    }));
  }

  function setCurrentCodeMode(nextMode) {
    updateCodeSession(codeProjectId, (session) => ({
      ...session,
      responseMode: ["auto", "code", "image"].includes(nextMode) ? nextMode : "auto"
    }));
  }

  function mergeJobIntoCodeSession(projectId, job, options = {}) {
    const key = projectKey(projectId);
    if (!key || !job) return;
    updateCodeSession(key, (session) => applyJobToCodeSession(session, job, options));
  }

  async function fetchCodeJobSnapshot(projectId, jobId, options = {}) {
    const job = await getCodeJob(jobId);
    const nextProjectId = codeJobProjectId(job) || projectId;
    mergeJobIntoCodeSession(nextProjectId, job, options);
    return job;
  }

  async function openCodeHistoryJob(jobId) {
    setError("");
    setNotice("");
    try {
      const job = await getCodeJob(jobId);
      const projectId = codeJobProjectId(job) || codeProjectId;
      if (projectId) setCodeProjectId(projectId);
      mergeJobIntoCodeSession(projectId, job, { restored: true });
      return job;
    } catch (err) {
      setError(err.message || "Failed to open KiraAI history item");
      return null;
    }
  }

  async function restoreCodeWorkerSessions() {
    const saved = readSavedCodeWorkerSessions();
    const nextSessions = {};
    let nextSelectedProjectId = saved.selectedProjectId || null;

    for (const [key, session] of Object.entries(saved.sessions || {})) {
      nextSessions[key] = normalizeCodeSession({ prompt: session.prompt || "" });
    }

    const savedJobs = await Promise.all(
      Object.entries(saved.sessions || {})
        .filter(([, session]) => session.jobId)
        .map(async ([key, session]) => {
          try {
            const job = await getCodeJob(session.jobId);
            return { key, job };
          } catch {
            return null;
          }
        })
    );

    for (const restored of savedJobs.filter(Boolean)) {
      const key = projectKey(codeJobProjectId(restored.job) || restored.key);
      if (!key) continue;
      nextSessions[key] = applyJobToCodeSession(nextSessions[key], restored.job, { restored: true });
      if (!nextSelectedProjectId) nextSelectedProjectId = key;
    }

    const recentJobs = await listCodeJobs(50, 0).catch(() => []);
    for (const job of recentJobs) {
      if (!CODE_JOB_RESTORABLE_STATUSES.has(job.status)) continue;
      const key = projectKey(codeJobProjectId(job));
      if (!key) continue;
      if (isNewerJob(job, nextSessions[key]?.job)) {
        nextSessions[key] = applyJobToCodeSession(nextSessions[key], job, { restored: true });
      }
      if (!nextSelectedProjectId) nextSelectedProjectId = key;
    }

    setCodeSessions(nextSessions);
    if (nextSelectedProjectId) setCodeProjectId(nextSelectedProjectId);
    setCodeSessionsHydrated(true);
  }

  function normalizeSummaryResult(data) {
    const fullReport = data.fullReport || data.full_report || "";
    let parsed = data.analysisJson || data.analysis_json || null;
    if (!parsed) {
      try { parsed = JSON.parse(fullReport || "{}"); } catch {}
    }
    return {
      ...data,
      root: data.root || data.root_path,
      fullReport,
      analysisJson: parsed,
      summaryId: data.summaryId || data.id,
      analysisVersion: data.analysisVersion ?? data.analysis_version,
      projectId: data.projectId ?? data.project_id,
      projectName: data.projectName || data.project_name,
      durationMs: data.durationMs ?? data.duration_ms,
      stageTimings: data.stageTimings || data.stage_timings
    };
  }

  async function createProjectAndPlan(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const project = await apiPost("/projects", form);
      await apiPost(`/projects/${project.id}/generate-plan`, { provider: settings.provider });
      await refreshProjects();
      await refreshSelectedProject(project.id);
      setForm(emptyForm());
      setTab("plans");
    } catch (err) {
      setError(err.message || "Failed to create project");
    } finally {
      setBusy(false);
    }
  }

  async function importExistingProject(targetPath) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await importProject(targetPath);
      await refreshProjects();
      const project = await refreshSelectedProject(result.project.id);
      setAnalysisProjectId(result.project.id);
      setCodeProjectId(result.project.id);
      await loadProjectSummaries(result.project.id);
      if (project?.root_path) {
        setSettings((prev) => ({ ...prev, targetPath: project.root_path }));
        setCurrentPath(project.root_path);
        setExplorerLoaded(false);
      }
      setNotice(`${result.created ? "Project geimporteerd" : "Project bijgewerkt"}: ${result.project.name}. Run KiraAI Analyzer om metadata en improvements op te halen.`);
      setTab("analyzer");
      return result.project;
    } catch (err) {
      setError(err.message || "Failed to import project");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspaceProject(payload) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await createProjectFolder(payload);
      await refreshProjects();
      const project = await refreshSelectedProject(result.project.id);
      setAnalysisProjectId(result.project.id);
      setCodeProjectId(result.project.id);
      await loadProjectSummaries(result.project.id);
      const rootPath = project?.root_path || result.rootPath;
      if (rootPath) {
        setSettings((prev) => ({ ...prev, targetPath: rootPath }));
        setCurrentPath(rootPath);
        setExplorerLoaded(false);
      }
      setNotice(`Project created: ${result.project.name} at ${rootPath}.`);
      return result.project;
    } catch (err) {
      setError(err.message || "Failed to create project folder");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openProject(id) {
    setError("");
    setNotice("");
    try {
      const project = await refreshSelectedProject(id);
      await loadHistory(id);
      setCodeProjectId(id);
      setAnalysisProjectId(id);
      await loadProjectSummaries(id);
      if (project?.root_path) {
        setSettings((prev) => ({ ...prev, targetPath: project.root_path }));
        setCurrentPath(project.root_path);
        setExplorerLoaded(false);
      }
      setTab("plans");
    } catch (err) {
      setError(err.message || "Failed to open project");
    }
  }

  async function updateProjectRoot(project, rootPath) {
    setError("");
    setNotice("");
    try {
      const payload = {
        name: project.name,
        goals: project.goals,
        techStack: project.tech_stack || "",
        timeline: project.timeline || "",
        budget: project.budget || "",
        rootPath
      };
      await apiPut(`/projects/${project.id}`, payload);
      await refreshProjects();
      if (Number(selectedProjectId) === Number(project.id)) await refreshSelectedProject(project.id);
    } catch (err) {
      setError(err.message || "Failed to update project root");
    }
  }

  async function loadProjectMembers(projectId) {
    return getProjectMembers(projectId);
  }

  async function inviteProjectMember(projectId, email) {
    const invite = await createProjectInvite(projectId, email);
    await refreshProjects().catch(() => null);
    if (Number(selectedProjectId) === Number(projectId)) await refreshSelectedProject(projectId).catch(() => null);
    if (invite.project?.root_path) {
      setSettings((prev) => ({ ...prev, targetPath: invite.project.root_path }));
      setCurrentPath(invite.project.root_path);
      setExplorerLoaded(false);
    }
    return invite;
  }

  async function removeProjectCollaborator(projectId, userId) {
    return removeProjectMember(projectId, userId);
  }

  async function revokeProjectMemberInvite(projectId, inviteId) {
    return revokeProjectInvite(projectId, inviteId);
  }

  async function runCompare() {
    if (!selectedProjectId || !compareVersion) return;
    setCompareResult(await apiGet(`/projects/${selectedProjectId}/plans/compare?againstVersion=${compareVersion}`));
  }

  async function generatePlan(projectId, provider, onRefreshProject, onLoadHistory) {
    await apiPost(`/projects/${projectId}/generate-plan`, { provider });
    await onRefreshProject();
    await onLoadHistory();
  }

  async function getSummaryById(id) {
    return apiGet(`/analysis/summaries/${id}`);
  }

  async function promoteBaseline(planId) {
    await apiPost(`/plans/${planId}/promote-baseline`, {});
    await refreshSelectedProject();
    await loadHistory();
  }

  async function updateFeedback(planId, action) {
    await apiPost(`/plans/${planId}/feedback`, { action, comments: "from frontend" });
    await refreshSelectedProject();
    await loadHistory();
  }

  async function runStructure() {
    if (!selectedProjectId) return;
    const out = await apiPost(`/projects/${selectedProjectId}/generate-structure`, {
      targetPath: settings.targetPath,
      profile: settings.profile,
      dryRun: settings.dryRun,
      overwriteStrategy: settings.overwriteStrategy,
      structurePrompt: settings.structurePrompt || ""
    });
    setStructureResult(out);
    if (out.root) {
      setCurrentPath(out.root);
      setExplorerLoaded(false);
    }
    setTab("structure");
  }

  async function openFile(filePath) {
    if (dirtyFile && !window.confirm("Unsaved changes will be lost. Continue?")) return;
    const data = await fsRead(filePath);
    setOpenFilePath(data.path);
    setOpenFileContent(data.content);
    setDirtyFile(false);
  }

  async function saveFile() {
    if (!openFilePath) return;
    await fsWrite(openFilePath, openFileContent, "overwrite");
    setDirtyFile(false);
  }

  function toggleSelect(targetPath, additive) {
    if (additive) {
      setSelectedPaths((prev) => prev.includes(targetPath) ? prev.filter((p) => p !== targetPath) : [...prev, targetPath]);
      return;
    }
    setSelectedPaths([targetPath]);
  }

  async function openEntry(entry) {
    if (entry.kind === "directory") {
      await navigateExplorer(entry.path);
      return;
    }
    await openFile(entry.path);
  }

  async function createFolder() {
    const name = window.prompt("New folder name");
    if (!name) return;
    await fsMkdir(`${currentPath}\\${name}`);
    await loadExplorer(currentPath);
  }

  async function createFile() {
    const name = window.prompt("New file name");
    if (!name) return;
    await fsCreateFile(`${currentPath}\\${name}`, "", "fail");
    await loadExplorer(currentPath);
  }

  async function renameSelected() {
    if (selectedPaths.length !== 1) return;
    const newName = window.prompt("Rename to");
    if (!newName) return;
    await fsRename(selectedPaths[0], newName, "fail");
    await loadExplorer(currentPath);
  }

  async function deleteSelected() {
    if (!selectedPaths.length) return;
    if (!window.confirm(`Delete ${selectedPaths.length} item(s)?`)) return;
    await Promise.all(selectedPaths.map((p) => fsDeletePath(p)));
    await loadExplorer(currentPath);
  }

  async function copySelected() {
    if (!selectedPaths.length) return;
    const destinationDir = window.prompt("Copy to folder path", currentPath);
    if (!destinationDir) return;
    await Promise.all(selectedPaths.map((p) => fsCopy(p, `${destinationDir}\\${p.split("\\").pop()}`, "fail")));
    await loadExplorer(currentPath);
  }

  async function moveSelected() {
    if (!selectedPaths.length) return;
    const destinationDir = window.prompt("Move to folder path", currentPath);
    if (!destinationDir) return;
    await Promise.all(selectedPaths.map((p) => fsMove(p, `${destinationDir}\\${p.split("\\").pop()}`, "fail")));
    await loadExplorer(currentPath);
  }

  async function runCodebaseSummary() {
    const projectId = analysisProjectId || selectedProjectId;
    const project = projects.find((item) => Number(item.id) === Number(projectId)) || selectedProject;
    if (!projectId || !project?.root_path) {
      setError("Selecteer eerst een geimporteerd project met een root path.");
      return;
    }
    setAnalysisBusy(true);
    setAnalysisResult(null);
    setError("");
    setNotice("");
    try {
      const started = await apiPost(`/projects/${projectId}/analyze-codebase/start`, {});
      setAnalysisJob(started);
      const jobId = started.jobId;
      let keepPolling = true;
      while (keepPolling) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const job = await apiGet(`/analysis/summarize-codebase/jobs/${jobId}`);
        setAnalysisJob(job);
        if (job.status === "done") {
          setAnalysisResult(normalizeSummaryResult(job.result));
          await loadProjectSummaries(projectId);
          await refreshProjects();
          await refreshSelectedProject(projectId);
          keepPolling = false;
        }
        if (job.status === "failed") throw new Error(job.error?.message || job.message || "Analysis failed");
      }
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function startCodeWorker() {
    setError("");
    setNotice("");
    if (!selectedCodeProject?.root_path) {
      setError("Selecteer eerst een project met een workspace root path.");
      return;
    }
    const prompt = codePrompt.trim();
    if (!prompt) {
      setError("Schrijf eerst een prompt voor dit project.");
      return;
    }
    updateCodeSession(selectedCodeProject.id, {
      busy: true,
      logs: [],
      restored: false,
      responseMode: codeMode,
      terminalStatus: "connecting",
      lastLogAt: null
    });
    try {
      const job = await createCodeJob(Number(selectedCodeProject.id), prompt, { responseMode: codeMode });
      mergeJobIntoCodeSession(selectedCodeProject.id, job);
      await loadCodeHistory(selectedCodeProject.id).catch(() => null);
      const latest = await getCodeJob(job.id);
      mergeJobIntoCodeSession(selectedCodeProject.id, latest);
    } catch (err) {
      setError(err.message || "Failed to start code job");
      updateCodeSession(selectedCodeProject.id, {
        busy: false,
        terminalStatus: "idle"
      });
    }
  }

  async function applyCurrentCodeJob() {
    if (!codeJob?.id) return;
    setError("");
    setNotice("");
    try {
      const updated = await applyCodeJob(codeJob.id);
      mergeJobIntoCodeSession(codeJobProjectId(updated) || codeProjectId, updated);
      await loadCodeHistory(codeJobProjectId(updated) || codeProjectId).catch(() => null);
      setNotice("Code proposal applied to the project files.");
    } catch (err) {
      setError(err.message || "Failed to accept code proposal");
    }
  }

  async function rejectCurrentCodeJob() {
    if (!codeJob?.id) return;
    setError("");
    setNotice("");
    try {
      const updated = await rejectCodeJob(codeJob.id);
      mergeJobIntoCodeSession(codeJobProjectId(updated) || codeProjectId, updated);
      await loadCodeHistory(codeJobProjectId(updated) || codeProjectId).catch(() => null);
      setNotice("Code proposal rejected.");
    } catch (err) {
      setError(err.message || "Failed to reject code proposal");
    }
  }

  function resetCodeWorker() {
    const key = projectKey(codeProjectId);
    if (!key) return;
    setCodeSessions((prev) => {
      const currentMode = normalizeCodeSession(prev[key]).responseMode;
      return {
        ...prev,
        [key]: {
          ...emptyCodeSession(),
          responseMode: currentMode
        }
      };
    });
  }

  const titleMap = {
    plans: "Plan Workspace",
    structure: "Advanced Structure",
    analyzer: "KiraAI Analyzer",
    code: "KiraAI Code",
    settings: "KiraAI Settings"
  };
  const title = titleMap[tab] || tab.charAt(0).toUpperCase() + tab.slice(1);

  if (authState.checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="workspace-panel w-full max-w-sm p-5">
          <p className="text-sm font-semibold">KiraAI</p>
          <p className="mt-1 text-sm text-muted-foreground">Checking secure session...</p>
        </div>
      </main>
    );
  }

  if (inviteToken) {
    const invite = inviteState.invite;
    const loggedInAsInviteEmail = authState.authenticated && invite?.email && authState.user?.email === invite.email;
    const needsPassword = !authState.authenticated;
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <form onSubmit={submitInviteAccept} className="workspace-panel w-full max-w-md p-5">
          <div className="mb-5">
            <p className="text-sm font-semibold">KiraAI Project Invite</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {inviteState.loading ? "Loading invite..." : invite ? `Join ${invite.projectName} as ${invite.email}.` : "Invite could not be loaded."}
            </p>
          </div>
          {inviteState.error ? (
            <Alert className="mb-4 border-destructive/40 bg-destructive/10 text-destructive">
              <AlertTitle>Invite unavailable</AlertTitle>
              <AlertDescription>{inviteState.error}</AlertDescription>
            </Alert>
          ) : null}
          {loginError ? (
            <Alert className="mb-4 border-destructive/40 bg-destructive/10 text-destructive">
              <AlertTitle>Accept failed</AlertTitle>
              <AlertDescription>{loginError}</AlertDescription>
            </Alert>
          ) : null}
          {inviteState.accepted ? (
            <Alert className="state-success mb-4">
              <AlertTitle>Invite accepted</AlertTitle>
              <AlertDescription>You now have access to {inviteState.accepted.project?.name || "this project"}.</AlertDescription>
            </Alert>
          ) : null}
          {invite?.expired ? (
            <Alert className="mb-4 border-destructive/40 bg-destructive/10 text-destructive">
              <AlertTitle>Expired</AlertTitle>
              <AlertDescription>This invite link has expired.</AlertDescription>
            </Alert>
          ) : null}
          {needsPassword ? (
            <div className="grid gap-3">
              <Input value={invite?.email || loginEmail} readOnly placeholder="Email" />
              <Input
                value={setupDisplayName}
                onChange={(event) => setSetupDisplayName(event.target.value)}
                placeholder="Display name"
                autoComplete="name"
              />
              <Input
                type="password"
                autoComplete="new-password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="Create password"
              />
            </div>
          ) : (
            <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              Signed in as {authState.user?.email}. {loggedInAsInviteEmail ? "Ready to accept." : "Sign out and log in with the invited email to accept this invite."}
            </p>
          )}
          <Button
            type="submit"
            className="mt-4 w-full"
            disabled={loginBusy || !invite || invite.expired || (!loggedInAsInviteEmail && authState.authenticated) || (needsPassword && !loginPassword)}
          >
            {loginBusy ? "Accepting..." : "Accept invite"}
          </Button>
        </form>
      </main>
    );
  }

  if (authState.enabled && !authState.authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <form onSubmit={submitLogin} className="workspace-panel w-full max-w-sm p-5">
          <div className="mb-5">
            <p className="text-sm font-semibold">{authState.setupRequired ? "Create KiraAI Admin" : "KiraAI Login"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {authState.setupRequired ? "Create the first admin account for this server." : "Sign in with your email and password."}
            </p>
          </div>
          {loginError ? (
            <Alert className="mb-4 border-destructive/40 bg-destructive/10 text-destructive">
              <AlertTitle>Login failed</AlertTitle>
              <AlertDescription>{loginError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-3">
            <Input
              type="email"
              autoComplete="email"
              value={loginEmail}
              onChange={(event) => setLoginEmail(event.target.value)}
              placeholder="Email"
            />
            {authState.setupRequired ? (
              <Input
                autoComplete="name"
                value={setupDisplayName}
                onChange={(event) => setSetupDisplayName(event.target.value)}
                placeholder="Display name"
              />
            ) : null}
          <Input
            type="password"
              autoComplete={authState.setupRequired ? "new-password" : "current-password"}
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
              placeholder="Password"
          />
          </div>
          <Button type="submit" className="mt-4 w-full" disabled={loginBusy || !loginEmail || !loginPassword}>
            {loginBusy ? (authState.setupRequired ? "Creating..." : "Signing in...") : (authState.setupRequired ? "Create admin" : "Sign in")}
          </Button>
        </form>
      </main>
    );
  }

  return (
    <AppShell tab={tab} setTab={setTab} title={title} connectionStatus={connectionStatus} onRetryConnection={() => checkConnection({ silent: false })} authState={authState} onLogout={logout}>
      {error ? (
        <Alert className="border-destructive/40 bg-destructive/10 text-destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert className="state-success">
          <AlertTitle>Success</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {tab === "projects" ? <ProjectsView busy={busy} projects={projects} refreshProjects={refreshProjects} openProject={openProject} updateProjectRoot={updateProjectRoot} importExistingProject={importExistingProject} createWorkspaceProject={createWorkspaceProject} defaultTargetPath={projectDefaultPath} performanceProjectId={performanceProjectId} performanceRuns={performanceRuns} performanceBusy={performanceBusy} loadProjectPerformanceRuns={loadProjectPerformanceRuns} loadProjectMembers={loadProjectMembers} inviteProjectMember={inviteProjectMember} removeProjectCollaborator={removeProjectCollaborator} revokeProjectMemberInvite={revokeProjectMemberInvite} currentUser={authState.user} /> : null}
      {tab === "plans" ? <PlansView selectedProjectId={selectedProjectId} selectedLatestJson={selectedLatestJson} selectedLatestPlan={selectedLatestPlan} sortedMilestones={sortedMilestones} settings={settings} refreshSelectedProject={refreshSelectedProject} loadHistory={loadHistory} updateFeedback={updateFeedback} promoteBaseline={promoteBaseline} historyFilter={historyFilter} setHistoryFilter={setHistoryFilter} historyRows={historyRows} compareVersion={compareVersion} setCompareVersion={setCompareVersion} runCompare={runCompare} compareResult={compareResult} generatePlan={generatePlan} /> : null}
      {tab === "structure" ? <StructureView settings={settings} setSettings={setSettings} runStructure={runStructure} selectedProjectId={selectedProjectId} structureResult={structureResult} /> : null}
      {tab === "explorer" ? <ExplorerView parentPath={parentPath} loadExplorer={loadExplorer} navigateExplorer={navigateExplorer} goBack={goExplorerBack} goForward={goExplorerForward} canGoBack={explorerBackStack.length > 0} canGoForward={explorerForwardStack.length > 0} currentPath={currentPath} entries={entries} tree={tree} openEntry={openEntry} selectedPaths={selectedPaths} toggleSelect={toggleSelect} openFilePath={openFilePath} setOpenFilePath={setOpenFilePath} openFileContent={openFileContent} setOpenFileContent={setOpenFileContent} dirtyFile={dirtyFile} setDirtyFile={setDirtyFile} saveFile={saveFile} fsConnected={fsConnected} createFolder={createFolder} createFile={createFile} renameSelected={renameSelected} deleteSelected={deleteSelected} copySelected={copySelected} moveSelected={moveSelected} filter={filter} setFilter={setFilter} /> : null}
      {tab === "analyzer" ? <AnalyzerView projects={projects} selectedProjectId={analysisProjectId} setSelectedProjectId={setAnalysisProjectId} runCodebaseSummary={runCodebaseSummary} analysisBusy={analysisBusy} analysisJob={analysisJob} analysisResult={analysisResult} projectSummaries={projectSummaries} loadProjectSummaries={loadProjectSummaries} setAnalysisResult={(data) => setAnalysisResult(normalizeSummaryResult(data))} setError={setError} getSummaryById={getSummaryById} /> : null}
      {tab === "code" ? <CodeWorkerView projects={projects} sessionsByProject={codeSessions} selectedProject={selectedCodeProject} selectedProjectId={codeProjectId} setSelectedProjectId={setCodeProjectId} codePrompt={codePrompt} setCodePrompt={setCurrentCodePrompt} codeMode={codeMode} setCodeMode={setCurrentCodeMode} codeJob={codeJob} codeBusy={codeBusy} codeLogs={codeLogs} terminalStatus={codeTerminalStatus} lastLogAt={codeLastLogAt} learningProfile={codeLearningProfile} codeSessionRestored={codeSessionRestored} codeHistory={codeHistory} codeHistoryBusy={codeHistoryBusy} loadCodeHistory={loadCodeHistory} openCodeHistoryJob={openCodeHistoryJob} startCodeWorker={startCodeWorker} applyCurrentCodeJob={applyCurrentCodeJob} rejectCurrentCodeJob={rejectCurrentCodeJob} resetCodeWorker={resetCodeWorker} /> : null}
      {tab === "settings" ? <SettingsView settings={settings} setSettings={setSettings} savedDefaultPath={savedDefaultPath} saveDefaultSettings={saveDefaultSettings} currentUser={authState.user} /> : null}
    </AppShell>
  );
}
