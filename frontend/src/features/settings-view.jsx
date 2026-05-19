import React, { useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle2,
  Download,
  GitBranch,
  Globe2,
  Pause,
  Play,
  RefreshCcw,
  Search,
  Trash2,
  UserPlus,
  Users,
  XCircle
} from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost, openMlJobEvents } from "@/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PathPickerDialog } from "@/components/path-picker-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ACTIVE_JOB_STATUSES, upsertById, useMlJobEvents } from "@/features/ml-panel-events";

export function SettingsView({ settings, setSettings, savedDefaultPath, saveDefaultSettings, currentUser }) {
  const [mlStatus, setMlStatus] = useState(null);
  const [sources, setSources] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [skills, setSkills] = useState([]);
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState({ email: "", password: "", displayName: "", role: "user" });
  const [usersBusy, setUsersBusy] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [usersNotice, setUsersNotice] = useState("");
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [repoLinks, setRepoLinks] = useState("");
  const [websiteLinks, setWebsiteLinks] = useState("");
  const [snippetTitle, setSnippetTitle] = useState("");
  const [snippetLanguage, setSnippetLanguage] = useState("JavaScript");
  const [snippetCode, setSnippetCode] = useState("");
  const [mlBusy, setMlBusy] = useState(false);
  const [mlError, setMlError] = useState("");
  const [mlNotice, setMlNotice] = useState("");
  const [debugPrompt, setDebugPrompt] = useState("");
  const [debugResult, setDebugResult] = useState(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [showArchivedSources, setShowArchivedSources] = useState(false);

  const activeJobIds = useMemo(
    () => jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).map((job) => job.id).sort((a, b) => a - b),
    [jobs]
  );

  useEffect(() => {
    refreshMlPanel().catch((error) => setMlError(error.message));
  }, []);

  useEffect(() => {
    if (currentUser?.role !== "admin") return;
    refreshUsers().catch((error) => setUsersError(error.message || "Could not load users"));
  }, [currentUser?.role]);

  useEffect(() => {
    refreshMlPanel({ silent: true }).catch(() => null);
  }, [showArchivedSources]);

  useMlJobEvents({ activeJobIds, openMlJobEvents, setJobs, refreshMlPanel });

  async function refreshMlPanel({ silent = false } = {}) {
    if (!silent) {
      setMlBusy(true);
      setMlError("");
    }
    try {
      const [status, nextSources, nextJobs, nextSkills] = await Promise.all([
        apiGet("/ml/status"),
        apiGet(`/ml/sources?includeArchived=${showArchivedSources ? "true" : "false"}`),
        apiGet("/ml/jobs?limit=30&offset=0"),
        apiGet("/ml/skills?limit=100&offset=0")
      ]);
      setMlStatus(status);
      setSources(nextSources);
      setJobs(nextJobs);
      setSkills(nextSkills);
      if (selectedSkill?.id) {
        apiGet(`/ml/skills/${selectedSkill.id}`)
          .then(setSelectedSkill)
          .catch(() => setSelectedSkill(null));
      }
    } finally {
      if (!silent) setMlBusy(false);
    }
  }

  async function refreshUsers() {
    if (currentUser?.role !== "admin") return;
    setUsersBusy(true);
    setUsersError("");
    try {
      setUsers(await apiGet("/admin/users"));
    } finally {
      setUsersBusy(false);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setUsersBusy(true);
    setUsersError("");
    setUsersNotice("");
    try {
      const created = await apiPost("/admin/users", userForm);
      setUserForm({ email: "", password: "", displayName: "", role: "user" });
      setUsersNotice(`User created: ${created.email}`);
      await refreshUsers();
    } catch (error) {
      setUsersError(error.message || "Could not create user");
    } finally {
      setUsersBusy(false);
    }
  }

  async function addSources() {
    const text = repoLinks.trim();
    if (!text) return;
    setMlBusy(true);
    setMlError("");
    setMlNotice("");
    try {
      const result = await apiPost("/ml/sources/batch", { text }, { timeout: 45000 });
      setRepoLinks("");
      const totals = result.totals || {};
      setMlNotice(`Sources queued: ${totals.created || 0} added and learning started, ${totals.duplicates || 0} duplicates skipped, ${totals.invalid || 0} invalid URL(s) skipped.`);
      await refreshMlPanel({ silent: true });
    } catch (error) {
      setMlError(error.message || "Failed to add KiraAI sources");
    } finally {
      setMlBusy(false);
    }
  }

  async function addWebsites() {
    const text = websiteLinks.trim();
    if (!text) return;
    setMlBusy(true);
    setMlError("");
    setMlNotice("");
    try {
      const result = await apiPost("/ml/websites/batch", { text }, { timeout: 120000 });
      setWebsiteLinks("");
      const totals = result.totals || {};
      setMlNotice(`Websites checked: ${totals.created || 0} added and learning started, ${totals.duplicates || 0} duplicates skipped, ${totals.invalid || 0} blocked/failed skipped.`);
      await refreshMlPanel({ silent: true });
    } catch (error) {
      setMlError(error.message || "Failed to add KiraAI websites");
    } finally {
      setMlBusy(false);
    }
  }

  async function learnSnippetCode() {
    if (!snippetCode.trim()) return;
    setMlBusy(true);
    setMlError("");
    setMlNotice("");
    try {
      const result = await apiPost("/ml/snippets/learn", {
        title: snippetTitle || "Pasted Code Skill",
        language: snippetLanguage || "JavaScript",
        content: snippetCode
      });
      if (result.job && ACTIVE_JOB_STATUSES.has(result.job.status)) {
        setJobs((prev) => upsertById(prev, result.job));
      }
      setSnippetTitle("");
      setSnippetCode("");
      setMlNotice(`${result.duplicate ? "Duplicate code found; relearning" : "Snippet learning started"} as ${result.source?.name || "pasted code"}.`);
      await refreshMlPanel({ silent: true });
    } catch (error) {
      setMlError(error.message || "Failed to learn pasted code");
    } finally {
      setMlBusy(false);
    }
  }

  async function startLearning(sourceId) {
    setMlError("");
    setMlNotice("");
    try {
      const job = await apiPost(`/ml/sources/${sourceId}/learn`, {});
      if (ACTIVE_JOB_STATUSES.has(job.status)) {
        setJobs((prev) => upsertById(prev, job));
      }
      setMlNotice(`Learning started for job #${job.id}`);
      await refreshMlPanel({ silent: true });
    } catch (error) {
      setMlError(error.message || "Failed to start learning");
    }
  }

  async function toggleSource(source) {
    const updated = await apiPatch(`/ml/sources/${source.id}`, { enabled: !source.enabled });
    setSources((prev) => upsertById(prev, updated));
  }

  async function deleteSource(id) {
    await apiDelete(`/ml/sources/${id}`);
    await refreshMlPanel({ silent: true });
  }

  async function cancelJob(id) {
    const job = await apiPost(`/ml/jobs/${id}/cancel`, {});
    setJobs((prev) => (
      ACTIVE_JOB_STATUSES.has(job.status)
        ? upsertById(prev, job)
        : prev.filter((item) => Number(item.id) !== Number(id))
    ));
  }

  async function openSkill(id) {
    setSelectedSkill(await apiGet(`/ml/skills/${id}`));
  }

  async function toggleSkill(skill) {
    const updated = await apiPatch(`/ml/skills/${skill.id}`, { enabled: !skill.enabled });
    setSkills((prev) => upsertById(prev, updated));
    if (selectedSkill?.id === skill.id) setSelectedSkill({ ...selectedSkill, ...updated });
  }

  async function removeSkill(id) {
    await apiDelete(`/ml/skills/${id}`);
    setSelectedSkill((current) => (current?.id === id ? null : current));
    await refreshMlPanel({ silent: true });
  }

  async function runDebugQuery() {
    if (!debugPrompt.trim()) return;
    setMlError("");
    setDebugResult(null);
    setDebugBusy(true);
    try {
      setDebugResult(await apiPost("/ml/query", { prompt: debugPrompt }, { timeout: 120000 }));
    } catch (error) {
      setMlError(error.message || "KiraAI query failed");
    } finally {
      setDebugBusy(false);
    }
  }

  function exportSkillSources() {
    const repoSources = sources
      .filter((source) => String(source.source_type || "").toLowerCase() === "github")
      .map((source) => source.url || source.name)
      .filter(Boolean);
    const unique = [...new Set(repoSources)];
    const content = unique.length
      ? unique.join("\n")
      : "No GitHub skill sources found.";
    const blob = new Blob([`${content}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "kiraai-skill-sources.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Tabs defaultValue="general" className="space-y-3">
      <TabsList className="flex w-fit flex-wrap">
        <TabsTrigger value="general">General</TabsTrigger>
        {currentUser?.role === "admin" ? <TabsTrigger value="users">Users</TabsTrigger> : null}
        <TabsTrigger value="mind">KiraAI Learning</TabsTrigger>
        <TabsTrigger value="skills">KiraAI Skills</TabsTrigger>
        <TabsTrigger value="jobs">KiraAI Jobs</TabsTrigger>
      </TabsList>

      <TabsContent value="general">
        <Card>
          <CardHeader>
            <CardTitle>KiraAI Settings</CardTitle>
            <CardDescription>Global defaults for provider and target path used across workflows.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="text-sm">Provider</label>
            <Select value={settings.provider} onValueChange={(v) => setSettings({ ...settings, provider: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{["codex_cli", "claude_cli", "openai", "anthropic"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
            </Select>
            <label className="text-sm">Default target path</label>
            <div className="flex flex-wrap gap-2">
              <Input className="min-w-0 flex-1 font-mono text-xs" value={settings.targetPath} onChange={(e) => setSettings({ ...settings, targetPath: e.target.value })} />
              <PathPickerDialog value={settings.targetPath} onSelect={(targetPath) => setSettings({ ...settings, targetPath })} />
              <Button onClick={() => saveDefaultSettings(settings)}>Save as default</Button>
            </div>
            <p className="rounded-md border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
              Saved default: <span className="font-mono text-foreground">{savedDefaultPath || "Not saved yet"}</span>
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      {currentUser?.role === "admin" ? (
        <TabsContent value="users">
          <div className="grid gap-3 xl:grid-cols-[390px_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserPlus className="h-5 w-5 text-primary" />
                  Create User
                </CardTitle>
                <CardDescription>Admin-created accounts can log in directly with email and password.</CardDescription>
              </CardHeader>
              <CardContent>
                <form className="grid gap-3" onSubmit={createUser}>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="user@example.com"
                    value={userForm.email}
                    onChange={(event) => setUserForm((prev) => ({ ...prev, email: event.target.value }))}
                  />
                  <Input
                    placeholder="Display name"
                    autoComplete="name"
                    value={userForm.displayName}
                    onChange={(event) => setUserForm((prev) => ({ ...prev, displayName: event.target.value }))}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Temporary password, min 10 chars"
                    value={userForm.password}
                    onChange={(event) => setUserForm((prev) => ({ ...prev, password: event.target.value }))}
                  />
                  <Select value={userForm.role} onValueChange={(role) => setUserForm((prev) => ({ ...prev, role }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="submit" disabled={usersBusy || !userForm.email || userForm.password.length < 10}>
                    {usersBusy ? "Creating..." : "Create user"}
                  </Button>
                  {usersError ? <p className="state-danger rounded-md border p-3 text-sm">{usersError}</p> : null}
                  {usersNotice ? <p className="state-success rounded-md border p-3 text-sm">{usersNotice}</p> : null}
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Users className="h-5 w-5 text-primary" />
                      Users
                    </CardTitle>
                    <CardDescription>Personal workspaces stay isolated unless a project is shared.</CardDescription>
                  </div>
                  <Button variant="outline" onClick={refreshUsers} disabled={usersBusy}>Refresh</Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2">
                {users.map((user) => (
                  <div key={user.id} className="rounded-md border border-border/70 bg-card/70 p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{user.displayName || user.email}</span>
                          <Badge variant={user.role === "admin" ? "default" : "outline"}>{user.role}</Badge>
                          <Badge variant={user.status === "active" ? "secondary" : "outline"}>{user.status}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">{user.email}</div>
                        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{user.workspaceRoot || "Workspace pending"}</div>
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground">
                        <div>Last login</div>
                        <div>{formatDate(user.lastLoginAt || user.last_login_at)}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {!users.length ? <p className="rounded-md border p-3 text-sm text-muted-foreground">No users found.</p> : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      ) : null}

      <TabsContent value="mind">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card>
            <CardHeader className="border-b bg-secondary/20">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Brain className="h-5 w-5 text-primary" />
                    KiraAI Learning Core
                  </CardTitle>
                  <CardDescription>GitHub, website, and pasted-code knowledge used by KiraAI.</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setShowArchivedSources((value) => !value)}>
                    {showArchivedSources ? "Hide archived" : "Show archived"}
                  </Button>
                  <Button variant="outline" onClick={exportSkillSources}>
                    <Download className="mr-2 h-4 w-4" />
                    Export sources
                  </Button>
                  <Button variant="outline" onClick={() => refreshMlPanel()} disabled={mlBusy}>
                    <RefreshCcw className="mr-2 h-4 w-4" />
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 p-4">
              <StatusStrip status={mlStatus} />
              {mlError ? <p className="state-danger rounded-md border p-3 text-sm">{mlError}</p> : null}
              {mlNotice ? <p className="state-success rounded-md border p-3 text-sm">{mlNotice}</p> : null}

              <div className="grid gap-3 xl:grid-cols-3">
                <div className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <GitBranch className="h-4 w-4" />
                    GitHub sources
                  </div>
                  <Textarea
                    className="min-h-[130px] font-mono text-xs"
                    value={repoLinks}
                    onChange={(event) => setRepoLinks(event.target.value)}
                    placeholder={"https://github.com/owner/repo\nhttps://github.com/another/repo"}
                  />
                  <Button onClick={addSources} disabled={mlBusy || !repoLinks.trim()}>
                    <GitBranch className="mr-2 h-4 w-4" />
                    Add Sources
                  </Button>
                </div>

                <div className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Globe2 className="h-4 w-4" />
                    Website scraper
                  </div>
                  <Textarea
                    className="min-h-[130px] font-mono text-xs"
                    value={websiteLinks}
                    onChange={(event) => setWebsiteLinks(event.target.value)}
                    placeholder={"https://example.com/templates\nhttps://example.com/components"}
                  />
                  <Button onClick={addWebsites} disabled={mlBusy || !websiteLinks.trim()}>
                    <Globe2 className="mr-2 h-4 w-4" />
                    Scrape & Learn
                  </Button>
                </div>

                <div className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Brain className="h-4 w-4" />
                    Learn pasted code
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px]">
                    <Input value={snippetTitle} onChange={(event) => setSnippetTitle(event.target.value)} placeholder="Skill title" />
                    <Input value={snippetLanguage} onChange={(event) => setSnippetLanguage(event.target.value)} placeholder="JavaScript" />
                  </div>
                  <Textarea
                    className="min-h-[130px] font-mono text-xs"
                    value={snippetCode}
                    onChange={(event) => setSnippetCode(event.target.value)}
                    placeholder="Paste HTML, CSS, JS, or component code here..."
                  />
                  <Button onClick={learnSnippetCode} disabled={mlBusy || !snippetCode.trim()}>
                    <Brain className="mr-2 h-4 w-4" />
                    Learn Code as Skill
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                {sources.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    onLearn={() => startLearning(source.id)}
                    onToggle={() => toggleSource(source)}
                    onDelete={() => deleteSource(source.id)}
                  />
                ))}
                {!sources.length ? <p className="rounded-md border p-3 text-sm text-muted-foreground">No KiraAI sources yet.</p> : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">KiraAI Skill Debug</CardTitle>
              <CardDescription>Preview which learned skills KiraAI would attach to a prompt.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Textarea
                className="min-h-[120px] font-mono text-xs"
                value={debugPrompt}
                onChange={(event) => setDebugPrompt(event.target.value)}
                placeholder="maak responsive cards met vanilla JS filter"
              />
              <Button onClick={runDebugQuery} disabled={debugBusy || !debugPrompt.trim()}>
                <Search className="mr-2 h-4 w-4" />
                {debugBusy ? "Querying..." : "Query KiraAI"}
              </Button>
              {debugBusy ? (
                <p className="rounded-md border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                  Selecting matching KiraAI skills with the fast cache...
                </p>
              ) : null}
              {debugResult ? (
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{debugResult.skills?.length || 0} selected</Badge>
                    <Badge variant="outline">{debugResult.candidates?.length || 0} candidates</Badge>
                    <Badge variant="outline">{debugResult.selectorStrategy || "selector"}</Badge>
                    <Badge variant="outline">{debugResult.cacheHit ? "cache hit" : "cache miss"}</Badge>
                    <Badge variant="outline">{debugResult.durationMs ?? 0}ms</Badge>
                    {debugResult.selectorReason ? <span>{debugResult.selectorReason}</span> : null}
                    {debugResult.warning ? <span className="text-amber-300">{debugResult.warning}</span> : null}
                  </div>
                  <ScrollArea className="h-[360px] rounded-md border bg-secondary/20 p-3">
                    <pre className="whitespace-pre-wrap text-xs">{debugResult.context || "No learned skills matched this prompt yet."}</pre>
                  </ScrollArea>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="skills">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
          <Card>
            <CardHeader>
              <CardTitle>KiraAI Skills</CardTitle>
              <CardDescription>Enabled skills are a shared server library and are usable by every signed-in user.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  selected={selectedSkill?.id === skill.id}
                  onOpen={() => openSkill(skill.id)}
                  onToggle={() => toggleSkill(skill)}
                  onDelete={() => removeSkill(skill.id)}
                />
              ))}
              {!skills.length ? (
                <p className="rounded-md border p-3 text-sm text-muted-foreground">
                  No learned skills yet. Strict skill mode blocks Code Worker and image jobs until KiraAI learns server skills.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{selectedSkill?.name || "Skill Details"}</CardTitle>
              <CardDescription>{selectedSkill?.source_name || "Select a skill to inspect its source chunks."}</CardDescription>
            </CardHeader>
            <CardContent>
              {selectedSkill ? (
                <div className="grid gap-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={selectedSkill.enabled ? "default" : "secondary"}>{selectedSkill.enabled ? "enabled" : "disabled"}</Badge>
                    <Badge variant="outline">{selectedSkill.category}</Badge>
                    <Badge variant="outline">confidence {Number(selectedSkill.confidence || 0).toFixed(2)}</Badge>
                    <Badge variant="outline">{selectedSkill.usage_count || 0} uses</Badge>
                  </div>
                  <p>{selectedSkill.summary}</p>
                  <p className="rounded-md border bg-secondary/30 p-3 text-muted-foreground">{selectedSkill.guidance}</p>
                  <Separator />
                  <ScrollArea className="h-[360px]">
                    <div className="grid gap-2">
                      {(selectedSkill.sourceChunks || []).map((chunk) => (
                        <div key={chunk.id} className="rounded-md border p-3">
                          <div className="mb-1 font-mono text-xs text-muted-foreground">{chunk.path}</div>
                          <pre className="whitespace-pre-wrap text-xs">{chunk.content.slice(0, 1200)}</pre>
                        </div>
                      ))}
                      {!selectedSkill.sourceChunks?.length ? <p className="text-sm text-muted-foreground">No source chunks attached.</p> : null}
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Select a learned skill.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="jobs">
        <Card>
          <CardHeader>
            <CardTitle>KiraAI Learning Jobs</CardTitle>
            <CardDescription>Progress, duration, logs, learned chunks, learned skills, and errors.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {jobs.map((job) => (
              <JobPanel key={job.id} job={job} onCancel={() => cancelJob(job.id)} />
            ))}
            {!jobs.length ? <p className="rounded-md border p-3 text-sm text-muted-foreground">No active learning jobs.</p> : null}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function StatusStrip({ status }) {
  const totals = status?.totals || {};
  return (
    <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-7">
      <Metric label="KiraAI" value={status?.enabled ? "enabled" : "disabled"} />
      <Metric label="Selector" value={status?.runtimeSelector || "-"} />
      <Metric label="AI provider" value={status?.aiProvider || "-"} />
      <Metric label="Embeddings" value={status?.embeddingProvider === "openai" ? status?.embeddingModel : status?.embeddingProvider || "-"} />
      <Metric label="Sources" value={totals.sources ?? 0} />
      <Metric label="Chunks" value={totals.chunks ?? 0} />
      <Metric label="Skills" value={totals.enabled_skills ?? 0} />
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function SourceRow({ source, onLearn, onToggle, onDelete }) {
  const status = sourceStatusInfo(source);
  return (
    <div className={cn("rounded-md border border-border/70 p-3", status.tone === "failed" && "state-danger")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-medium">{source.name}</div>
            <Badge variant="outline">{source.source_type || "github"}</Badge>
            {source.archived ? <Badge variant="secondary">archived</Badge> : null}
            <Badge variant={source.enabled ? "default" : "secondary"}>{source.enabled ? "enabled" : "disabled"}</Badge>
            <Badge variant={status.variant} className={status.className}>{status.label}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{source.url}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{source.document_count || 0} docs</span>
            <span>{source.chunk_count || 0} chunks</span>
            <span>{source.skill_count || 0} skills</span>
            {source.archive_reason ? <span>{source.archive_reason}</span> : null}
            {source.last_error ? <span className="text-red-300">{source.last_error}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onLearn} disabled={!source.enabled || source.status === "learning"}>
            <Play className="mr-2 h-4 w-4" />
            {source.archived ? "Relearn" : "Learn"}
          </Button>
          <Button size="sm" variant="outline" onClick={onToggle}>
            {source.enabled ? <Pause className="mr-2 h-4 w-4" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {source.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function sourceStatusInfo(source = {}) {
  const raw = String(source.status || "idle").toLowerCase();
  if (source.archived && raw === "learned") return { label: "learned", variant: "default", tone: "done" };
  if (raw === "learning") return { label: "learning", variant: "secondary", tone: "active" };
  if (raw === "learned") return { label: "learned", variant: "default", tone: "done" };
  if (raw === "failed") {
    return {
      label: "failed",
      variant: "outline",
      tone: "failed",
      className: "border-red-500/30 bg-red-500/10 text-red-200"
    };
  }
  if (raw === "idle") return { label: "idle", variant: "outline", tone: "idle" };
  return { label: raw || "idle", variant: "outline", tone: "idle" };
}

function SkillRow({ skill, selected, onOpen, onToggle, onDelete }) {
  return (
    <div className={cn("rounded-md border p-3", selected && "border-primary bg-primary/10")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{skill.name}</span>
            <Badge variant={skill.enabled ? "default" : "secondary"}>{skill.enabled ? "enabled" : "disabled"}</Badge>
            <Badge variant="outline">{skill.category}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{skill.summary}</p>
          <div className="mt-1 text-xs text-muted-foreground">{skill.source_name || "unknown source"}</div>
        </button>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onToggle}>
            {skill.enabled ? <Pause className="mr-2 h-4 w-4" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {skill.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function JobPanel({ job, onCancel }) {
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const stats = job.stats || {};
  const active = ACTIVE_JOB_STATUSES.has(job.status);
  const resumeCount = Number(job.resume_count || 0);
  const duration = formatDuration(job.started_at || job.created_at, job.finished_at || (active ? new Date().toISOString() : job.updated_at));
  return (
    <div className="rounded-md border p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Job #{job.id}</span>
            <JobBadge status={job.status} />
            <Badge variant="outline">{job.source_name}</Badge>
            <Badge variant="outline">{duration}</Badge>
            {resumeCount > 0 ? <Badge variant="secondary">resumed x{resumeCount}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {job.stage} - {job.message}
            {job.resume_reason ? ` (${job.resume_reason})` : ""}
          </p>
        </div>
        {active ? (
          <Button size="sm" variant="outline" onClick={onCancel}>
            <XCircle className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        ) : null}
      </div>
      <Progress value={Number(job.progress || 0)} />
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{stats.files || 0} files</span>
        <span>{stats.chunks || 0} chunks</span>
        <span>{stats.skills || 0} skills</span>
        {job.runner_id ? <span>runner active</span> : null}
      </div>
      {job.error?.message ? <p className="state-danger mt-2 rounded-md border p-2 text-sm">{job.error.message}</p> : null}
      <ScrollArea className="terminal-panel mt-3 h-[160px] p-3">
        <pre className="whitespace-pre-wrap text-xs">{formatJobLogs(logs)}</pre>
      </ScrollArea>
    </div>
  );
}

function JobBadge({ status }) {
  const variant = status === "done" ? "default" : status === "failed" ? "secondary" : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

function formatJobLogs(logs) {
  if (!logs.length) return "Waiting for learning output...";
  return logs.map((log) => {
    const time = log.ts ? new Date(log.ts).toLocaleTimeString() : "";
    const details = log.data?.commentary || log.data?.line || log.data?.error || "";
    const resume = log.data?.resumeCount ? `resumed x${log.data.resumeCount}` : "";
    return `${time} ${log.message}${details ? ` | ${details}` : ""}${resume ? ` | ${resume}` : ""}`.trim();
  }).join("\n");
}

function formatDuration(start, end) {
  const startMs = new Date(start || 0).getTime();
  const endMs = new Date(end || 0).getTime();
  if (!startMs || !endMs || endMs < startMs) return "0s";
  const seconds = Math.round((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
