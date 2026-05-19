import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

export function AnalyzerView({ projects, selectedProjectId, setSelectedProjectId, runCodebaseSummary, analysisBusy, analysisJob, analysisResult, projectSummaries, loadProjectSummaries, setAnalysisResult, setError, getSummaryById }) {
  const parsed = parseReport(analysisResult);
  const selectedProject = projects.find((project) => Number(project.id) === Number(selectedProjectId)) || null;
  const checks = Array.isArray(analysisResult?.improvementChecks) ? analysisResult.improvementChecks : [];
  const styleProfile = analysisResult?.styleProfile || {};
  const events = Array.isArray(analysisResult?.learningEvents) ? analysisResult.learningEvents : [];
  const styleItems = styleProfile.observations || parsed?.codeStyleObservations || [];
  const summaryId = analysisResult?.summaryId || analysisResult?.id;
  const analysisVersion = analysisResult?.analysisVersion || analysisResult?.analysis_version || 1;
  const linkedProjectId = analysisResult?.projectId || analysisResult?.project_id;
  const linkedProjectName = analysisResult?.projectName || analysisResult?.project_name;
  const terminalText = formatLogs(analysisJob?.logs);
  const jobStatus = analysisJob?.status || (analysisBusy ? "running" : "idle");
  const jobProgress = Number(analysisJob?.progress || 0);
  const jobDuration = formatDuration(analysisJob?.durationMs || analysisJob?.duration_ms || analysisJob?.elapsedMs);

  async function openSummary(summaryIdToOpen) {
    try {
      const data = await getSummaryById(summaryIdToOpen);
      setAnalysisResult(data);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>KiraAI Analyzer</CardTitle>
            <CardDescription>Select a project, run KiraAI analysis, and review progress live.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <select
                className="min-h-10 min-w-[260px] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={selectedProjectId || ""}
                onChange={(e) => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select imported project...</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    #{project.id} {project.name} {project.root_path ? `- ${project.root_path}` : "- no root"}
                  </option>
                ))}
              </select>
              <Button onClick={() => runCodebaseSummary().catch((e) => { setError(e.message); })} disabled={analysisBusy || !selectedProject?.root_path}>
                {analysisBusy ? "Analyzing..." : "Run KiraAI Analyzer"}
              </Button>
            </div>
            {selectedProject ? (
              <div className="rounded-md border bg-secondary/20 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-medium">{selectedProject.name}</div>
                  {selectedProject.source_analysis_version ? <Badge variant="secondary">latest v{selectedProject.source_analysis_version}</Badge> : <Badge variant="outline">not analyzed</Badge>}
                </div>
                <div className="mt-1 break-all text-muted-foreground">{selectedProject.root_path || "No root path set"}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Summaries, style learning, and improvement checks are saved under this project for KiraAI.
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-secondary/20 p-3 text-sm text-muted-foreground">
                Import or select a project first. KiraAI Analyzer no longer runs from a loose path.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>KiraAI Progress</CardTitle>
                <CardDescription>{analysisJob?.stage || "Idle"}{analysisJob?.message ? ` - ${analysisJob.message}` : ""}</CardDescription>
              </div>
              <Badge
                variant={jobStatus === "done" ? "secondary" : "outline"}
                className={jobStatus === "failed" ? "border-red-500/30 bg-red-500/10 text-red-200" : ""}
              >
                {jobStatus}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span>{analysisJob?.stage || "Waiting for KiraAI run"}</span>
              <span>{jobDuration ? `${jobProgress}% | ${jobDuration}` : `${jobProgress}%`}</span>
            </div>
            <Progress value={jobProgress} />
            <p className="min-h-5 text-sm text-muted-foreground">
              {analysisJob?.message || (selectedProject ? "Start KiraAI Analyzer to stream output here." : "Select a project to enable analysis.")}
            </p>
            {analysisJob?.error ? (
              <div className="state-danger rounded-md border p-3 text-sm">
                <div className="font-medium">{analysisJob.error.message || "KiraAI analysis failed"}</div>
                {analysisJob.error.code ? <div className="text-xs opacity-80">{analysisJob.error.code}</div> : null}
              </div>
            ) : null}
            <div className="terminal-panel">
              <div className="flex items-center justify-between border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
                <span>Live KiraAI Terminal</span>
                <span>{terminalText ? `${terminalText.split("\n").length} lines` : "idle"}</span>
              </div>
              <ScrollArea className="h-[260px] p-3">
                <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-neutral-100">
                  {terminalText || "Terminal idle. Run KiraAI Analyzer to see real-time progress logs."}
                </pre>
              </ScrollArea>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="xl:sticky xl:top-4 xl:h-fit">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Previous Summarizations</CardTitle>
              <CardDescription>{selectedProject ? selectedProject.name : "Project history"}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => loadProjectSummaries(selectedProjectId).catch((e) => setError(e.message))} disabled={!selectedProjectId}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!selectedProject ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Select a project to load its summary history.</div>
          ) : !projectSummaries.length ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No summaries yet. Run KiraAI Analyzer.</div>
          ) : (
            <div className="grid gap-2">
              {projectSummaries.map((s) => {
                const version = s.analysisVersion || s.analysis_version || 1;
                const active = Number(summaryId) === Number(s.id);
                return (
                  <button
                    key={s.id}
                    className={`rounded-lg border p-3 text-left text-sm transition hover:border-primary/50 hover:bg-secondary/30 ${active ? "border-primary bg-primary/5" : ""}`}
                    onClick={() => openSummary(s.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{s.title || `Summary #${s.id}`}</div>
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description || "No description"}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{s.rootPath || s.root_path}</div>
                      </div>
                      <Badge>v{version}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatDate(s.createdAt || s.created_at)}</span>
                      {s.model ? <span>{s.model}</span> : null}
                      {formatDuration(s.durationMs || s.duration_ms) ? <span>{formatDuration(s.durationMs || s.duration_ms)}</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {analysisResult ? (
        <div className="space-y-3 xl:col-span-2">
          <Card className="bg-secondary/20">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{parsed?.title || analysisResult.title || "Analysis"}</CardTitle>
                  <CardDescription>{parsed?.projectDescription || analysisResult.description}</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge>Analysis v{analysisVersion}</Badge>
                  {summaryId ? <Badge variant="secondary">Summary #{summaryId}</Badge> : null}
                  {formatDuration(analysisResult.durationMs || analysisResult.duration_ms) ? <Badge variant="secondary">{formatDuration(analysisResult.durationMs || analysisResult.duration_ms)}</Badge> : null}
                  <Badge variant="outline">{linkedProjectName || selectedProject?.name || (linkedProjectId ? `Project #${linkedProjectId}` : "Project history")}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <div><strong>Root:</strong> {analysisResult.root}</div>
              <div><strong>Project:</strong> {linkedProjectName || selectedProject?.name || (linkedProjectId ? `#${linkedProjectId}` : "Current selected project")}</div>
              <div><strong>Architecture:</strong> {(parsed?.architectureOverview || []).slice(0, 4).join(" | ") || "-"}</div>
              <div className="text-xs text-muted-foreground">This summary is stored in the selected project history automatically.</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Function Improvements</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(parsed?.improvementSuggestions || []).length ? parsed.improvementSuggestions.slice(0, 12).map((s, i) => (
                <div key={`${s.file}-${s.function}-${i}`} className="rounded border p-2 text-sm">
                  <div><strong>{s.priority?.toUpperCase() || "INFO"}</strong> | {s.file} | {s.function}</div>
                  <div className="text-muted-foreground">Issue: {s.issue}</div>
                  <div>Suggestion: {s.suggestion}</div>
                  {s.followUpCriteria ? <div className="text-muted-foreground">Check: {s.followUpCriteria}</div> : null}
                </div>
              )) : <div className="text-sm text-muted-foreground">No suggestions returned.</div>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Previous Improvements</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {checks.length ? checks.slice(0, 10).map((check) => (
                <div key={check.id} className="rounded border p-2 text-sm">
                  <div className="font-medium">{check.status}</div>
                  <div className="text-muted-foreground">{check.explanation}</div>
                </div>
              )) : <div className="text-sm text-muted-foreground">No previous checks yet.</div>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Style Profile</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {styleItems.length ? styleItems.slice(0, 8).map((item, i) => <div key={i} className="rounded border p-2">{item}</div>) : <div className="text-muted-foreground">No style profile yet.</div>}
              {events.length ? <div className="text-muted-foreground">Latest learning event: {events[0].event_type}</div> : null}
            </CardContent>
          </Card>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Raw JSON</summary>
            <pre className="mt-2 rounded-md border bg-secondary/20 p-3 text-xs">{analysisResult.fullReport || "No report returned."}</pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}

function parseReport(analysisResult) {
  if (!analysisResult) return null;
  if (analysisResult.analysisJson && typeof analysisResult.analysisJson === "object") return analysisResult.analysisJson;
  try {
    return JSON.parse(analysisResult.fullReport || "{}");
  } catch {
    return null;
  }
}

function isNoisyAnalyzerLog(value) {
  const text = String(value || "").toLowerCase();
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
    "migration"
  ].some((needle) => text.includes(needle));
}

function isImportantAnalyzerLog(value) {
  const text = String(value || "").toLowerCase();
  return [
    "error",
    "failed",
    "fatal",
    "timed out",
    "timeout",
    "not found",
    "permission",
    "denied",
    "completed",
    "succeeded"
  ].some((needle) => text.includes(needle));
}

function cleanAnalyzerLog(value) {
  return String(value || "")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]")
    .replace(/\bDATABASE_URL=\S+/gi, "DATABASE_URL=[hidden]")
    .trim();
}

function formatLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) return "";
  const visibleLogs = logs.filter((entry) => {
    const line = typeof entry === "string" ? entry : entry?.line || entry?.message || "";
    return !isNoisyAnalyzerLog(line) && isImportantAnalyzerLog(line);
  });
  if (!visibleLogs.length) return "";
  return visibleLogs.map((entry) => {
    if (typeof entry === "string") return cleanAnalyzerLog(entry);
    const time = entry.ts ? `[${entry.ts}] ` : "";
    const source = entry.source ? `(${entry.source}) ` : "";
    return cleanAnalyzerLog(`${time}${source}${entry.line || entry.message || ""}`);
  }).join("\n");
}

function formatDate(value) {
  if (!value) return "No date";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
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
