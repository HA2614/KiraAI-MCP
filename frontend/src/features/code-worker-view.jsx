import React, { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Clock3, ExternalLink, GitPullRequest, History, ImageIcon, Layers3, Play, Search, ShieldAlert, TerminalSquare, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { codeJobAssetUrl } from "@/api";

const REVIEW_STATUSES = new Set(["awaiting_review"]);
const ACTIVE_STATUSES = new Set(["queued", "planning", "running", "awaiting_review"]);
const FINAL_STATUSES = new Set(["done", "applied", "rejected", "failed"]);

export function CodeWorkerView({
  projects,
  sessionsByProject = {},
  selectedProject,
  selectedProjectId,
  setSelectedProjectId,
  codePrompt,
  setCodePrompt,
  codeMode = "auto",
  setCodeMode,
  codeJob,
  codeBusy,
  codeLogs,
  terminalStatus,
  lastLogAt,
  learningProfile,
  codeSessionRestored,
  codeHistory = [],
  codeHistoryBusy = false,
  loadCodeHistory,
  openCodeHistoryJob,
  startCodeWorker,
  startCodeStructureWorker,
  applyCurrentCodeJob,
  rejectCurrentCodeJob,
  resetCodeWorker
}) {
  const [query, setQuery] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [historyScope, setHistoryScope] = useState("project");
  const [historyType, setHistoryType] = useState("");
  const [structureInstructions, setStructureInstructions] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const files = Array.isArray(codeJob?.changed_files) ? codeJob.changed_files : [];
  const risks = Array.isArray(codeJob?.risk_notes) ? codeJob.risk_notes : [];
  const tests = Array.isArray(codeJob?.test_commands) ? codeJob.test_commands : [];
  const assets = Array.isArray(codeJob?.assets) ? codeJob.assets : [];
  const logs = mergeDisplayLogs(codeLogs, codeJob?.logs);
  const selectedFile = files[selectedFileIndex] || files[0] || null;
  const readyForReview = REVIEW_STATUSES.has(codeJob?.status);
  const finished = FINAL_STATUSES.has(codeJob?.status);
  const failed = codeJob?.status === "failed";
  const imageOnlyJob = codeJob?.response_kind === "image";
  const responseMarkdown = codeJob?.response_markdown || (
    imageOnlyJob
      ? buildImagePendingResponse(codeJob?.user_prompt || codePrompt)
      : "The response appears when the proposal is ready."
  );
  const hasActiveJob = ACTIVE_STATUSES.has(codeJob?.status);
  const canStart = Boolean(selectedProject?.root_path && codePrompt.trim() && !codeBusy && !hasActiveJob && !codeJob);
  const canRetry = Boolean(failed && selectedProject?.root_path && codePrompt.trim() && !codeBusy);
  const hasStyleProfile = learningProfile?.styleProfile && Object.keys(learningProfile.styleProfile).length > 0;
  const styleStatus = hasStyleProfile ? "Style profile loaded" : "No style profile yet";
  const resumeCount = Number(codeJob?.resume_count || 0);
  const openImprovementCount = Array.isArray(learningProfile?.improvements) ? learningProfile.improvements.filter((item) => item.status === "open").length : 0;
  const liveRunDurationMs = codeJob?.duration_ms
    ? Number(codeJob.duration_ms)
    : codeJob?.started_at
      ? Math.max(0, nowMs - new Date(codeJob.started_at).getTime())
      : 0;
  const totalAdditions = files.reduce((sum, file) => sum + Number(file.additions || 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + Number(file.deletions || 0), 0);

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => {
      const label = `${project.name || ""} ${project.root_path || ""}`.toLowerCase();
      return label.includes(needle);
    });
  }, [projects, query]);

  useEffect(() => {
    setSelectedFileIndex(0);
  }, [codeJob?.id]);

  useEffect(() => {
    setTerminalOpen(false);
  }, [codeJob?.id]);

  useEffect(() => {
    setHistoryType("");
    setHistoryScope("project");
  }, [selectedProjectId]);

  useEffect(() => {
    if (!hasActiveJob && !codeJob?.started_at) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveJob, codeJob?.started_at]);

  async function refreshHistory(nextType = historyType, nextScope = historyScope) {
    if (!loadCodeHistory) return;
    if (nextScope !== "all" && !selectedProjectId) return;
    setHistoryType(nextType);
    setHistoryScope(nextScope);
    await loadCodeHistory(selectedProjectId, { type: nextType, scope: nextScope });
  }

  async function startStructure() {
    const job = await startCodeStructureWorker?.({ instructions: structureInstructions.trim() });
    if (job) setStructureInstructions("");
  }

  return (
    <div className="grid min-h-[calc(100vh-6.5rem)] w-full gap-3 xl:grid-cols-[340px_minmax(680px,1fr)_460px] 2xl:grid-cols-[380px_minmax(860px,1fr)_520px]">
      <div className="grid min-h-[620px] gap-3 xl:h-[calc(100vh-6.5rem)] xl:grid-rows-[minmax(260px,0.9fr)_minmax(260px,1.1fr)]">
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <GitPullRequest className="h-4 w-4" />
              Projects
            </CardTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search projects..." value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea className="h-full px-3 pb-3">
              <div className="grid gap-2">
                {filteredProjects.map((project) => {
                  const active = Number(project.id) === Number(selectedProjectId);
                  const session = sessionsByProject[String(project.id)] || {};
                  const sessionStatus = projectSessionStatus(project, session);
                  return (
                    <button
                      key={project.id}
                      onClick={() => setSelectedProjectId(project.id)}
                      className={cn(
                        "rounded-lg border p-3 text-left text-sm transition hover:border-primary/50 hover:bg-secondary/40",
                        active && "border-primary bg-primary/10"
                      )}
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="min-w-0 flex-1 break-words font-medium leading-snug">#{project.id} {project.name}</span>
                        <Badge variant={sessionStatus.variant} className="shrink-0">{sessionStatus.label}</Badge>
                      </div>
                      <div className="mt-1 line-clamp-2 break-all text-xs text-muted-foreground">{project.root_path || "Set a root path in Projects first"}</div>
                    </button>
                  );
                })}
                {!filteredProjects.length ? <p className="rounded-lg border p-3 text-sm text-muted-foreground">No projects found.</p> : null}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" />
                Prompt History
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => refreshHistory()} disabled={(historyScope !== "all" && !selectedProjectId) || codeHistoryBusy}>
                Refresh
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                ["project", "This project"],
                ["all", "All projects"]
              ].map(([value, label]) => (
                <Button key={value} size="sm" variant={historyScope === value ? "default" : "outline"} onClick={() => refreshHistory(historyType, value)} disabled={(value !== "all" && !selectedProjectId) || codeHistoryBusy}>
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                ["", "All"],
                ["prompt", "Prompts"],
                ["structure", "Structure"]
              ].map(([value, label]) => (
                <Button key={value || "all"} size="sm" variant={historyType === value ? "default" : "outline"} onClick={() => refreshHistory(value)} disabled={(historyScope !== "all" && !selectedProjectId) || codeHistoryBusy}>
                  {label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea className="h-full px-3 pb-3">
              <div className="grid gap-2">
                {codeHistory.map((job) => (
                  <button
                    key={job.id}
                    onClick={() => openCodeHistoryJob?.(job.id)}
                    className={cn(
                      "rounded-lg border p-3 text-left text-sm transition hover:border-primary/50 hover:bg-secondary/40",
                      Number(codeJob?.id) === Number(job.id) && "border-primary bg-primary/10"
                    )}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="min-w-0 line-clamp-2 font-medium">{job.title || job.user_prompt || `Job #${job.id}`}</span>
                      <Badge variant={job.job_type === "structure" ? "secondary" : "outline"}>{job.job_type || "prompt"}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">{job.status || "queued"}</Badge>
                      {historyScope === "all" && job.project_name ? <Badge variant="outline">{job.project_name}</Badge> : null}
                      {job.duration_ms ? <Badge variant="outline">{formatDurationMs(job.duration_ms)}</Badge> : null}
                      {Number(job.asset_count || 0) > 0 || job.response_kind === "image" ? <Badge variant="secondary"><ImageIcon className="mr-1 h-3 w-3" /> image</Badge> : null}
                      <DiffStats additions={sumChanged(job.changed_files, "additions")} deletions={sumChanged(job.changed_files, "deletions")} />
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{job.diff_summary || formatDate(job.created_at)}</div>
                  </button>
                ))}
                {codeHistoryBusy ? <p className="rounded-lg border p-3 text-sm text-muted-foreground">Loading history...</p> : null}
                {!codeHistoryBusy && !codeHistory.length ? <p className="rounded-lg border p-3 text-sm text-muted-foreground">{historyScope === "all" ? "No KiraAI Code history yet." : "No KiraAI Code history for this project yet."}</p> : null}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      <div className={cn(
        "grid min-h-[720px] gap-3 xl:h-[calc(100vh-6.5rem)]",
        terminalOpen ? "grid-rows-[minmax(0,1fr)_260px]" : "grid-rows-[minmax(0,1fr)]"
      )}>
        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="border-b bg-secondary/20">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-primary" />
                  Kira Code
                </CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={terminalOpen ? "secondary" : "outline"} onClick={() => setTerminalOpen((open) => !open)}>
                  <TerminalSquare className="mr-2 h-4 w-4" />
                  {terminalOpen ? "Hide terminal" : "Show terminal"}
                </Button>
                <StatusBadge status={codeJob?.status} busy={codeBusy} resumeCount={resumeCount} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid min-h-0 gap-4 p-4">
            <div className="rounded-lg border bg-background p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{selectedProject?.name || "No project selected"}</p>
                  <p className="text-xs text-muted-foreground">{selectedProject?.root_path || "Select a project with a workspace root."}</p>
                </div>
              <div className="flex flex-wrap gap-2">
                  {codeSessionRestored ? <Badge variant="secondary">Restored active job</Badge> : null}
                  {resumeCount > 0 ? <Badge variant="secondary">Resumed x{resumeCount}</Badge> : null}
                  {codeJob?.started_at ? <Badge variant="outline">Run time {formatDurationMs(liveRunDurationMs) || "pending"}</Badge> : null}
                  <Badge variant="outline">{styleStatus}</Badge>
                  <Badge variant="outline">{openImprovementCount} open improvements</Badge>
                </div>
              </div>
              {!selectedProject?.root_path ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  This project needs a workspace root before KiraAI can run. Set it from the Projects page.
                </div>
              ) : null}
            </div>

            <div className="rounded-lg border bg-background p-3">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Layers3 className="h-4 w-4 text-primary" />
                    Full-stack Structure Workflow
                  </p>
                  <p className="text-xs text-muted-foreground">Creates frontend, backend, API routes, database schema, Docker, env and README as a reviewable proposal.</p>
                </div>
                <Badge variant="secondary">reviewable</Badge>
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                <Textarea
                  className="min-h-[88px] resize-none text-sm"
                  value={structureInstructions}
                  onChange={(event) => setStructureInstructions(event.target.value)}
                  placeholder="Optional structure instructions, e.g. use Express routes for users and files, include SQL migrations..."
                  disabled={hasActiveJob && !finished}
                />
                <div className="grid content-start gap-2">
                  <Button onClick={startStructure} disabled={!selectedProject?.root_path || codeBusy || hasActiveJob}>
                    <Play className="mr-2 h-4 w-4" />
                    Start Structure Job
                  </Button>
                  <div className="grid gap-1 text-xs text-muted-foreground">
                    <span>Plan</span>
                    <span>Query KiraAI skills</span>
                    <span>Inspect project</span>
                    <span>Generate proposal</span>
                    <span>Collect diff</span>
                    <span>Review</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-sm font-medium">Prompt</label>
                  <ModeSelector value={codeMode} onChange={setCodeMode} disabled={hasActiveJob && !finished} />
                </div>
                <Textarea
                  className="min-h-[190px] resize-none font-mono text-sm"
                  value={codePrompt}
                  onChange={(event) => setCodePrompt(event.target.value)}
                  placeholder="Describe the code change. Example: Refactor the analyzer cards and add empty states."
                  disabled={hasActiveJob && !finished}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Run state</p>
                <div className="rounded-lg border p-3">
                  <StatusStep label="Planning" active={["planning", "running", "awaiting_review", "done", "applied", "rejected"].includes(codeJob?.status)} current={codeJob?.status === "planning"} />
                  <StatusStep label={imageOnlyJob ? "Generating image" : "Generating proposal"} active={["running", "awaiting_review", "done", "applied", "rejected"].includes(codeJob?.status)} current={codeJob?.status === "running"} />
                  <StatusStep label={imageOnlyJob ? "Response ready" : "Awaiting review"} active={["awaiting_review", "done", "applied", "rejected"].includes(codeJob?.status)} current={codeJob?.status === "awaiting_review"} />
                  <StatusStep label="Finished" active={finished} current={finished} />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {failed ? (
                <Button onClick={startCodeWorker} disabled={!canRetry}>
                  <Play className="mr-2 h-4 w-4" />
                  Retry
                </Button>
              ) : !finished ? (
                <Button onClick={startCodeWorker} disabled={!canStart}>
                  <Play className="mr-2 h-4 w-4" />
                  {codeBusy ? "Running..." : "Start KiraAI Job"}
                </Button>
              ) : null}
              {readyForReview ? (
                <>
                  <Button onClick={applyCurrentCodeJob}>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Accept Changes
                  </Button>
                  <Button variant="outline" onClick={rejectCurrentCodeJob}>
                    <XCircle className="mr-2 h-4 w-4" />
                    Reject Proposal
                  </Button>
                </>
              ) : null}
              {finished && !failed ? <Button variant="outline" onClick={resetCodeWorker}>Start another prompt</Button> : null}
              {readyForReview ? <span className="text-sm text-muted-foreground">KiraAI is asking for your decision.</span> : null}
            </div>

            {codeJob?.status === "failed" ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <div className="font-semibold">Code job failed</div>
                <div>{latestError(logs) || "Click Show terminal for details."}</div>
              </div>
            ) : null}

            {codeJob ? (
              <Panel title="KiraAI Response">
                <div className="rounded-lg border bg-background p-3">
                  {imageOnlyJob ? <AssetGallery job={codeJob} assets={assets} /> : null}
                  <ResponseMarkdown text={responseMarkdown} />
                  {!imageOnlyJob ? <AssetGallery job={codeJob} assets={assets} /> : null}
                </div>
              </Panel>
            ) : null}

            {codeJob ? (
              <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
                <Panel title="KiraAI prompt">
                  <ScrollArea className="h-[220px] rounded-md border bg-secondary/20 p-3">
                    <pre className="whitespace-pre-wrap text-xs">{codeJob.improved_prompt || "The improved prompt appears once planning starts."}</pre>
                  </ScrollArea>
                </Panel>
                <Panel title="Changed files">
                  <ScrollArea className="h-[220px] rounded-md border p-2">
                  <div className="grid gap-2">
                    {files.length ? files.map((file, index) => (
                      <button
                        key={`${file.path}-${index}`}
                        onClick={() => setSelectedFileIndex(index)}
                        className={cn(
                          "rounded-md border p-2 text-left text-sm transition hover:border-primary/50",
                          selectedFileIndex === index && "border-primary bg-primary/10"
                        )}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0 break-all font-medium">{file.path}</div>
                          <DiffStats additions={file.additions} deletions={file.deletions} />
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">{file.diffSummary || file.action || "Proposed change"}</div>
                      </button>
                    )) : <p className="text-sm text-muted-foreground">No files proposed yet.</p>}
                  </div>
                  </ScrollArea>
                </Panel>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {terminalOpen ? (
          <Card className="overflow-hidden border-slate-900 bg-slate-950 text-slate-100">
            <CardHeader className="border-b border-slate-800 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TerminalSquare className="h-4 w-4" />
                  Web terminal
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                  <span>{terminalStatusLabel(terminalStatus)}</span>
                  <span>{lastLogAt ? `last log ${new Date(lastLogAt).toLocaleTimeString()}` : "no logs yet"}</span>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={() => setTerminalOpen(false)}>
                    Hide
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[198px] p-3 font-mono text-xs">
                <pre className="whitespace-pre-wrap">{formatLogs(logs)}</pre>
              </ScrollArea>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="min-h-[620px] overflow-hidden xl:h-[calc(100vh-6.5rem)]">
        <CardHeader className="border-b bg-secondary/20">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Review</CardTitle>
            </div>
            <DiffStats additions={totalAdditions} deletions={totalDeletions} size="lg" />
          </div>
        </CardHeader>
        <CardContent className="grid min-h-0 gap-4 p-4">
          <Panel title="Proposal summary">
            <p className="text-sm text-muted-foreground">{codeJob?.diff_summary || "Run a prompt to get a reviewable proposal."}</p>
          </Panel>

          <Panel title="Selected file preview">
            {selectedFile ? (
              <div className="space-y-2">
                <div className="rounded-md border p-2 text-sm">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0 break-all font-medium">{selectedFile.path}</div>
                    <DiffStats additions={selectedFile.additions} deletions={selectedFile.deletions} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{selectedFile.diffSummary || selectedFile.action}</div>
                </div>
                <DiffViewer file={selectedFile} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Select a proposed file to preview its content.</p>
            )}
          </Panel>

          <Separator />

          <Panel title="Risk notes">
            <ListOrEmpty icon={<ShieldAlert className="h-4 w-4" />} items={risks} empty="No risk notes yet." />
          </Panel>

          <Panel title="Suggested tests">
            <ListOrEmpty icon={<Clock3 className="h-4 w-4" />} items={tests} empty="No test commands suggested yet." />
          </Panel>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status, busy, resumeCount = 0 }) {
  if (!status && !busy) return <Badge variant="outline">Idle</Badge>;
  if (status === "done") return <Badge variant="default">Done</Badge>;
  const label = `${busy ? status || "running" : status}${resumeCount > 0 ? ` - resumed x${resumeCount}` : ""}`;
  return <Badge variant={status === "awaiting_review" ? "default" : "secondary"}>{label}</Badge>;
}

function StatusStep({ label, active, current }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <span className={cn("h-2.5 w-2.5 rounded-full border", active ? "border-primary bg-primary" : "border-muted-foreground/40", current && "ring-2 ring-primary/30")} />
      <span className={active ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ModeSelector({ value = "auto", onChange, disabled = false }) {
  const modes = [
    ["auto", "Auto"],
    ["code", "Code"],
    ["image", "Image"]
  ];
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {modes.map(([mode, label]) => (
        <Button
          key={mode}
          type="button"
          size="sm"
          variant={value === mode ? "default" : "ghost"}
          className="h-7 rounded px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange?.(mode)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function ListOrEmpty({ icon, items, empty }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="grid gap-2">
      {items.map((item, index) => (
        <div key={`${item}-${index}`} className="flex gap-2 rounded-md border p-2 text-sm text-muted-foreground">
          <span className="mt-0.5 text-foreground">{icon}</span>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

function buildImagePendingResponse(prompt = "") {
  const preview = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 220);
  return [
    "## Ik ga dit maken",
    preview
      ? `Oké, ik ga nu een afbeelding maken van: ${preview}`
      : "Oké, ik ga nu een afbeelding maken op basis van je prompt.",
    "Dit duurt meestal ongeveer 1 tot 2 minuten.",
    "",
    "## Status",
    "Codex is bezig met genereren. Zodra de afbeelding klaar is, verschijnt de preview hieronder in de response box.",
    "De afbeelding wordt als KiraAI job asset bewaard, niet als bestand in je projectfolder."
  ].join("\n");
}

function ResponseMarkdown({ text }) {
  const lines = String(text || "").split(/\r?\n/);
  return (
    <div className="space-y-1 text-sm">
      {lines.map((line, index) => {
        if (!line.trim()) return <div key={index} className="h-2" />;
        if (line.startsWith("## ")) {
          return <h4 key={index} className="pt-1 text-sm font-semibold">{line.replace(/^##\s+/, "")}</h4>;
        }
        if (line.startsWith("- ")) {
          return <p key={index} className="pl-4 text-muted-foreground before:-ml-4 before:pr-2 before:content-['-']">{renderInlineCode(line.slice(2))}</p>;
        }
        return <p key={index} className="text-muted-foreground">{renderInlineCode(line)}</p>;
      })}
    </div>
  );
}

function renderInlineCode(text) {
  const parts = String(text || "").split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded bg-secondary px-1 py-0.5 font-mono text-xs text-foreground">{part.slice(1, -1)}</code>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function AssetGallery({ job, assets = [] }) {
  const imageAssets = assets.filter((asset) => String(asset.asset_type || "").toLowerCase() === "image");
  if (!imageAssets.length) return null;
  return (
    <div className="mb-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {imageAssets.map((asset) => {
          const src = codeJobAssetUrl(job.id, asset.id);
          return (
            <div key={asset.id} className="rounded-lg border bg-secondary/20 p-2">
              <img src={src} alt={asset.filename || "Generated KiraAI image"} className="aspect-square w-full rounded-md border bg-white object-contain" />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs text-muted-foreground">{asset.filename || `asset-${asset.id}`}</span>
                <Button asChild size="sm" variant="outline">
                  <a href={src} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-1 h-3.5 w-3.5" />
                    Open full size
                  </a>
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffStats({ additions = 0, deletions = 0, size = "sm" }) {
  const plus = Number(additions || 0);
  const minus = Number(deletions || 0);
  return (
    <div className={cn("inline-flex shrink-0 items-center gap-1 font-mono font-semibold", size === "lg" ? "text-sm" : "text-xs")}>
      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">+{plus}</span>
      <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-red-700">-{minus}</span>
    </div>
  );
}

function DiffViewer({ file }) {
  const hunks = Array.isArray(file?.diffHunks) ? file.diffHunks : [];
  if (!hunks.length) {
    return (
      <ScrollArea className="h-[520px] min-h-[360px] rounded-md border bg-slate-950 p-3 text-slate-100 xl:h-[calc(100vh-24rem)]">
        <pre className="whitespace-pre-wrap text-xs">{file?.content || "No diff preview returned for this file."}</pre>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-[520px] min-h-[360px] rounded-md border bg-white xl:h-[calc(100vh-24rem)]">
      <div className="font-mono text-[12px] leading-5">
        {hunks.map((hunk, hunkIndex) => (
          <div key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
            <div className="border-b border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {(hunk.lines || []).map((line, lineIndex) => (
              <DiffLine key={`${hunkIndex}-${lineIndex}`} line={line} />
            ))}
          </div>
        ))}
        {file?.diffTruncated ? (
          <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Diff preview truncated. The full proposed file is still used when accepting changes.
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function DiffLine({ line }) {
  const type = line?.type || "context";
  const sign = type === "add" ? "+" : type === "remove" ? "-" : " ";
  return (
    <div
      className={cn(
        "grid grid-cols-[48px_48px_24px_minmax(0,1fr)] gap-2 px-2 py-0.5",
        type === "add" && "bg-emerald-50 text-emerald-950",
        type === "remove" && "bg-red-50 text-red-950",
        type === "context" && "text-slate-700"
      )}
    >
      <span className="select-none text-right text-slate-400">{line?.oldLine ?? ""}</span>
      <span className="select-none text-right text-slate-400">{line?.newLine ?? ""}</span>
      <span className={cn("select-none font-bold", type === "add" && "text-emerald-700", type === "remove" && "text-red-700")}>{sign}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{line?.text || ""}</span>
    </div>
  );
}

function projectSessionStatus(project, session = {}) {
  const status = session.job?.status;
  if (status === "awaiting_review") return { label: "Review", variant: "default" };
  if (status === "done") return { label: "Done", variant: "secondary" };
  if (["queued", "planning", "running"].includes(status) && Number(session.job?.resume_count || 0) > 0) return { label: "Resumed", variant: "secondary" };
  if (["queued", "planning", "running"].includes(status)) return { label: "Running", variant: "secondary" };
  if (status === "applied") return { label: "Applied", variant: "secondary" };
  if (status === "rejected") return { label: "Rejected", variant: "outline" };
  if (status === "failed") return { label: "Failed", variant: "secondary" };
  if (session.prompt?.trim()) return { label: "Draft", variant: "secondary" };
  return { label: project.root_path ? "Ready" : "No root", variant: project.root_path ? "outline" : "outline" };
}

function logFingerprint(log) {
  if (!log) return "";
  return `${log.ts || ""}|${log.message || ""}|${JSON.stringify(log.data || {})}`;
}

function mergeDisplayLogs(...logLists) {
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
  return merged;
}

function terminalStatusLabel(status) {
  if (status === "live") return "live";
  if (status === "polling") return "syncing";
  if (status === "connecting") return "connecting";
  if (status === "review") return "proposal ready";
  return "idle";
}

function isNoisyTerminalText(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return false;
  return [
    "postgresql://",
    "database_url",
    "postgres",
    "psql",
    "pg_",
    "redis",
    "node_modules",
    "docker compose",
    "schema applied",
    "kiraai engine still running"
  ].some((needle) => text.includes(needle));
}

function looksLikeTerminalCodeSnippet(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^[+-]\s*(const|let|var|if|return|throw|reader\.|set[A-Z]|[A-Za-z0-9_$]+\()/u.test(text)) return true;
  if (/^[+-]\s*\{?error\s*&&/u.test(text)) return true;
  if (/^(const|let|var)\s+\[?error\b/u.test(text)) return true;
  if (/^(if|return|throw)\s*\(/u.test(text)) return true;
  if (/^set[A-Z][A-Za-z0-9_$]*\(/u.test(text)) return true;
  if (/^\{?error\s*&&/u.test(text)) return true;
  if (/^\.error\s*\{/u.test(text)) return true;
  return false;
}

function isRealTerminalErrorText(value) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (!text || looksLikeTerminalCodeSnippet(text)) return false;
  if (/^(error|fatal|failed|failure):\s/i.test(text)) return true;
  if (/^#?\s*error\s+\[[A-Z0-9_]+\]/.test(text)) return true;
  if (/\b(err_module_not_found|err_[a-z0-9_]+)\b/i.test(text)) return true;
  if (/\b(cannot find module|cannot find package|module not found|package not found)\b/i.test(text)) return true;
  if (/\b(test failed|build failed|verification failed|command failed|timed out|permission denied)\b/i.test(text)) return true;
  if (lower.startsWith("npm err!") || lower.startsWith("pnpm err") || lower.startsWith("yarn error")) return true;
  return false;
}

function isImportantTerminalText(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return false;
  if (isRealTerminalErrorText(value)) return true;
  return [
    "created",
    "updated",
    "changed",
    "test",
    "build",
    "lint",
    "typecheck"
  ].some((needle) => text.includes(needle));
}

function shouldShowTerminalLog(log) {
  const message = String(log?.message || "");
  const rawLine = String(log?.data?.line || "");
  const rawError = String(log?.data?.error || "");
  if (message === "KiraAI engine still running") return false;
  if (/^kiraai (stdout|stderr)$/i.test(message)) {
    if (isNoisyTerminalText(rawLine)) return false;
    if (looksLikeTerminalCodeSnippet(rawLine)) return false;
    return isImportantTerminalText(rawLine);
  }
  if ((isNoisyTerminalText(rawLine) || isNoisyTerminalText(rawError)) && !isImportantTerminalText(message)) return false;
  if (looksLikeTerminalCodeSnippet(rawLine) && !isImportantTerminalText(rawLine)) return false;
  return true;
}

function cleanTerminalText(value) {
  const text = String(value || "");
  if (isNoisyTerminalText(text)) return "Backend database detail hidden from terminal output.";
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]")
    .replace(/\bDATABASE_URL=\S+/gi, "DATABASE_URL=[hidden]")
    .trim();
}

function sumChanged(files, key) {
  return (Array.isArray(files) ? files : []).reduce((sum, file) => sum + Number(file?.[key] || 0), 0);
}

function formatDate(value) {
  if (!value) return "No date";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatDurationMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function formatLogs(logs) {
  const visibleLogs = (Array.isArray(logs) ? logs : []).filter(shouldShowTerminalLog);
  if (!visibleLogs.length) return "Waiting for KiraAI output...";
  return visibleLogs.map((log) => {
    const stamp = log.ts ? new Date(log.ts).toLocaleTimeString() : "";
    const details = [];
    if (log.data?.durationMs) details.push(formatDurationMs(log.data.durationMs));
    if (log.data?.resumeCount) details.push(`resumed x${log.data.resumeCount}`);
    if (typeof log.data?.skills === "number") details.push(`${log.data.skills} skills`);
    if (typeof log.data?.changedFiles === "number") details.push(`${log.data.changedFiles} files`);
    if (typeof log.data?.candidateCount === "number") details.push(`${log.data.candidateCount} candidates`);
    if (typeof log.data?.cacheHit === "boolean") details.push(log.data.cacheHit ? "cache hit" : "cache miss");
    if (log.data?.warning) details.push(cleanTerminalText(log.data.warning));
    if (log.data?.line) details.push(cleanTerminalText(log.data.line));
    if (log.data?.error) details.push(cleanTerminalText(log.data.error));
    if (log.data?.code) details.push(log.data.code);
    return `${stamp} ${cleanTerminalText(log.message || JSON.stringify(log))}${details.filter(Boolean).length ? ` | ${details.filter(Boolean).join(" | ")}` : ""}`.trim();
  }).join("\n");
}

function latestError(logs) {
  const list = Array.isArray(logs) ? logs : [];
  const entry = [...list].reverse().find((log) => isRealTerminalErrorText(log.data?.error || log.data?.line || log.message));
  return cleanTerminalText(entry?.data?.error || entry?.data?.line || entry?.message || "");
}
