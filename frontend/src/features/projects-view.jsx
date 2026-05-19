import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PathPickerDialog } from "@/components/path-picker-dialog";
import { Badge } from "@/components/ui/badge";

export function ProjectsView({
  busy,
  projects,
  refreshProjects,
  openProject,
  updateProjectRoot,
  importExistingProject,
  createWorkspaceProject,
  defaultTargetPath,
  performanceProjectId,
  performanceRuns,
  performanceBusy,
  loadProjectPerformanceRuns,
  loadProjectMembers,
  inviteProjectMember,
  removeProjectCollaborator,
  revokeProjectMemberInvite,
  currentUser
}) {
  const [query, setQuery] = useState("");
  const [importPath, setImportPath] = useState(defaultTargetPath || "/host/c/Users/Hayan/Downloads");
  const [projectName, setProjectName] = useState("");
  const [projectGoals, setProjectGoals] = useState("");
  const [projectBasePath, setProjectBasePath] = useState(defaultTargetPath || "/workspace");
  const [shareProject, setShareProject] = useState(null);
  const [shareState, setShareState] = useState({ loading: false, error: "", data: null, inviteEmail: "", inviteLink: "" });
  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    return projects.filter((p) => `${p.name} ${p.root_path || ""}`.toLowerCase().includes(needle));
  }, [projects, query]);

  useEffect(() => {
    if (!importPath && defaultTargetPath) setImportPath(defaultTargetPath);
    if (defaultTargetPath && (!projectBasePath || isDefaultWorkspacePath(projectBasePath))) setProjectBasePath(defaultTargetPath);
  }, [defaultTargetPath, importPath, projectBasePath]);

  async function submitImport(event) {
    event.preventDefault();
    if (!importPath.trim()) return;
    await importExistingProject(importPath.trim());
  }

  async function submitCreate(event) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    const created = await createWorkspaceProject({
      name,
      goals: projectGoals.trim(),
      basePath: projectBasePath.trim()
    });
    if (created) {
      setProjectName("");
      setProjectGoals("");
    }
  }

  async function openShare(project) {
    if (!loadProjectMembers) return;
    setShareProject(project);
    setShareState({ loading: true, error: "", data: null, inviteEmail: "", inviteLink: "" });
    try {
      const data = await loadProjectMembers(project.id);
      setShareState((prev) => ({ ...prev, loading: false, data }));
    } catch (error) {
      setShareState((prev) => ({ ...prev, loading: false, error: error.message || "Could not load members" }));
    }
  }

  async function sendInvite(event) {
    event.preventDefault();
    if (!shareProject || !shareState.inviteEmail.trim()) return;
    setShareState((prev) => ({ ...prev, loading: true, error: "", inviteLink: "" }));
    try {
      const invite = await inviteProjectMember(shareProject.id, shareState.inviteEmail.trim());
      const data = await loadProjectMembers(shareProject.id);
      setShareState((prev) => ({ ...prev, loading: false, data, inviteEmail: "", inviteLink: invite.inviteLink || "" }));
    } catch (error) {
      setShareState((prev) => ({ ...prev, loading: false, error: error.message || "Could not create invite" }));
    }
  }

  async function removeMember(userId) {
    if (!shareProject) return;
    await removeProjectCollaborator(shareProject.id, userId);
    const data = await loadProjectMembers(shareProject.id);
    setShareState((prev) => ({ ...prev, data }));
  }

  async function revokeInvite(inviteId) {
    if (!shareProject) return;
    await revokeProjectMemberInvite(shareProject.id, inviteId);
    const data = await loadProjectMembers(shareProject.id);
    setShareState((prev) => ({ ...prev, data }));
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[390px_minmax(0,1fr)]">
      <div className="grid gap-4">
        <Card>
          <CardHeader className="border-b border-border/70 bg-secondary/20">
            <CardTitle>Create Project Folder</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={submitCreate}>
              <Input placeholder="Project name" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
              <Input placeholder="Optional goal or first task" value={projectGoals} onChange={(e) => setProjectGoals(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Input className="min-w-0 flex-1" placeholder="/workspace" value={projectBasePath} onChange={(e) => setProjectBasePath(e.target.value)} />
                <PathPickerDialog value={projectBasePath} onSelect={setProjectBasePath} />
              </div>
              <Button type="submit" disabled={busy || !projectName.trim()}>{busy ? "Creating..." : "Create Project"}</Button>
              <p className="text-xs text-muted-foreground">
                KiraAI creates a safe folder from the project name, then links it as this project's workspace root.
              </p>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border/70 bg-secondary/20">
            <CardTitle>Import Existing Codebase</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={submitImport}>
              <div className="flex flex-wrap gap-2">
                <Input className="min-w-0 flex-1" placeholder="/host/c/Users/Hayan/Downloads/my-project" value={importPath} onChange={(e) => setImportPath(e.target.value)} />
                <PathPickerDialog value={importPath} onSelect={setImportPath} />
              </div>
              <Button type="submit" disabled={busy || !importPath.trim()}>{busy ? "Importing..." : "Import Folder as Project"}</Button>
              <p className="text-xs text-muted-foreground">
                Imported projects start with pending metadata. KiraAI Analyzer will process the folder and update the project after the run.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b border-border/70 bg-secondary/20">
          <CardTitle>Projects</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="Search projects..." value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button variant="outline" onClick={refreshProjects}>Refresh</Button>
          </div>
          <ScrollArea className="h-[520px] rounded-md border border-border/70 bg-background/40 p-2">
            <div className="grid gap-2">
              {filtered.map((project) => (
                <div key={project.id} className="rounded-lg border border-border/70 bg-card/80 p-3 text-sm transition-[border-color,background-color] duration-150 hover:border-primary/40 hover:bg-secondary/30">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">#{project.id} {project.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{project.root_path || "No workspace root set"}</div>
                      {project.source_analysis_version ? (
                        <div className="text-xs text-muted-foreground">
                          KiraAI summary v{project.source_analysis_version}
                          {project.source_summary_id ? ` (#${project.source_summary_id})` : ""}
                        </div>
                      ) : (
                        <div className="text-xs text-amber-300">Not analyzed yet</div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {project.membership_role ? <Badge variant="outline">{project.membership_role}</Badge> : null}
                        <TimingBadge label="Code" value={project.latest_code_job_duration_ms} empty="No code run" />
                        <TimingBadge label="Analyzer" value={project.source_analysis_duration_ms} empty="No analyzer run" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => openProject(project.id)}>Open</Button>
                      {project.membership_role === "owner" ? (
                        <Button size="sm" variant="outline" onClick={() => openShare(project)}>Share</Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => loadProjectPerformanceRuns(project.id).catch(() => null)}>
                        Performance
                      </Button>
                      {project.membership_role === "owner" || !project.membership_role ? (
                        <PathPickerDialog value={project.root_path || ""} triggerLabel="Set root" onSelect={(rootPath) => updateProjectRoot(project, rootPath)} />
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
              {!filtered.length ? <p className="rounded-lg border p-3 text-sm text-muted-foreground">No projects yet. Import a folder to start.</p> : null}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {shareProject ? (
        <Card className="xl:col-span-2">
          <CardHeader className="border-b border-border/70 bg-secondary/20">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Share {shareProject.name}</CardTitle>
              <Button variant="outline" size="sm" onClick={() => setShareProject(null)}>Close</Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[360px_minmax(0,1fr)]">
            <form className="grid content-start gap-3" onSubmit={sendInvite}>
              <Input
                type="email"
                placeholder="collaborator@example.com"
                value={shareState.inviteEmail}
                onChange={(event) => setShareState((prev) => ({ ...prev, inviteEmail: event.target.value }))}
              />
              <Button type="submit" disabled={shareState.loading || !shareState.inviteEmail.trim()}>
                {shareState.loading ? "Working..." : "Create invite link"}
              </Button>
              {shareState.inviteLink ? (
                <div className="rounded-md border border-border/70 bg-background/50 p-3 text-sm">
                  <div className="mb-2 break-all font-mono text-xs">{shareState.inviteLink}</div>
                  <Button type="button" size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(shareState.inviteLink)}>
                    Copy link
                  </Button>
                </div>
              ) : null}
              {shareState.error ? <p className="text-sm text-destructive">{shareState.error}</p> : null}
            </form>
            <div className="grid gap-3">
              <div>
                <p className="mb-2 text-sm font-medium">Members</p>
                <div className="grid gap-2">
                  {(shareState.data?.members || []).map((member) => (
                    <div key={member.id} className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/40 p-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{member.display_name || member.email}</div>
                        <div className="text-xs text-muted-foreground">{member.email} - {member.role}</div>
                      </div>
                      {member.role !== "owner" && Number(member.id) !== Number(currentUser?.id) ? (
                        <Button size="sm" variant="outline" onClick={() => removeMember(member.id)}>Remove</Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Pending invites</p>
                <div className="grid gap-2">
                  {(shareState.data?.invites || []).map((invite) => (
                    <div key={invite.id} className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/40 p-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{invite.email}</div>
                        <div className="text-xs text-muted-foreground">Expires {formatDate(invite.expires_at)}</div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => revokeInvite(invite.id)}>Revoke</Button>
                    </div>
                  ))}
                  {!shareState.data?.invites?.length ? <p className="text-sm text-muted-foreground">No pending invites.</p> : null}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="xl:col-span-2">
        <CardHeader className="border-b border-border/70 bg-secondary/20">
          <CardTitle>Performance History</CardTitle>
        </CardHeader>
        <CardContent>
          {!performanceProjectId ? (
            <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">No project selected for performance history.</div>
          ) : performanceBusy ? (
            <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading performance runs...</div>
          ) : !performanceRuns.length ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No Code Worker or Analyzer timing data for this project yet.</div>
          ) : (
            <ScrollArea className="h-[320px] rounded-md border border-border/70 bg-background/40 p-2">
              <div className="grid gap-2">
                {performanceRuns.map((run) => (
                  <div key={`${run.run_type}-${run.id}`} className="rounded-lg border border-border/70 bg-card/80 p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={run.run_type === "code_prompt" ? "default" : "secondary"}>{formatRunType(run.run_type)}</Badge>
                          <Badge variant="outline">{run.status || "done"}</Badge>
                          <TimingBadge label="Total" value={run.duration_ms} empty="Timing pending" />
                        </div>
                        <div className="mt-2 truncate font-medium">{run.title || `Run #${run.id}`}</div>
                        {run.description ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{run.description}</div> : null}
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground">
                        <div>{formatDate(run.created_at)}</div>
                        {run.model ? <div>{run.model}</div> : null}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {stageEntries(run.stage_timings).map(([name, timing]) => (
                        <Badge key={name} variant="outline" className="font-normal">
                          {formatStageName(name)} {formatDuration(timing.durationMs)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function isDefaultWorkspacePath(value) {
  const cleaned = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return !cleaned || cleaned === "/workspace" || cleaned === "/host" || /^\/host\/[a-z]$/.test(cleaned) || /^[a-z]:$/.test(cleaned);
}

function TimingBadge({ label, value, empty }) {
  const text = formatDuration(value);
  return (
    <Badge variant={text ? "secondary" : "outline"} className={text ? "" : "text-muted-foreground"}>
      {label}: {text || empty}
    </Badge>
  );
}

function formatDuration(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatDate(value) {
  if (!value) return "No date";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatRunType(value) {
  if (value === "code_prompt") return "Code Worker";
  if (value === "analyzer_summary") return "Analyzer";
  return value || "Run";
}

function formatStageName(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stageEntries(stageTimings) {
  const stages = stageTimings?.stages && typeof stageTimings.stages === "object" ? stageTimings.stages : {};
  return Object.entries(stages)
    .filter(([, timing]) => Number(timing?.durationMs || 0) > 0)
    .sort((a, b) => Number(b[1]?.durationMs || 0) - Number(a[1]?.durationMs || 0))
    .slice(0, 8);
}
