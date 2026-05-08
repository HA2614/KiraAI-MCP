import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

export function PlansView(props) {
  const {
    selectedProjectId, selectedLatestJson, selectedLatestPlan, sortedMilestones, settings, refreshSelectedProject, loadHistory,
    updateFeedback, promoteBaseline, historyFilter, setHistoryFilter, historyRows, compareVersion, setCompareVersion, runCompare, compareResult, generatePlan
  } = props;
  if (!selectedProjectId) return <Card><CardContent className="p-6 text-muted-foreground">Select a project first in the Projects tab.</CardContent></Card>;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Plan Workspace</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => generatePlan(selectedProjectId, settings.provider, refreshSelectedProject, loadHistory)}>Generate New Version</Button>
          <Button variant="outline" onClick={() => loadHistory()}>Load History</Button>
        </CardContent>
      </Card>

      {selectedLatestJson ? (
        <Card>
          <CardHeader>
            <CardTitle>Latest Plan v{selectedLatestPlan?.version}</CardTitle>
            <CardDescription>{selectedLatestJson.summary}</CardDescription>
            {selectedLatestPlan?.is_baseline ? <Badge>Baseline</Badge> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sortedMilestones.map((m, i) => (
                <Card key={i} className="bg-secondary/30">
                  <CardHeader className="p-4">
                    <CardTitle className="text-base">Week {m.week}: {m.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{(m.deliverables || []).map((d, j) => <li key={j}>{d}</li>)}</ul>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => updateFeedback(selectedLatestPlan.id, "accept")}>Accept</Button>
              <Button variant="outline" onClick={() => updateFeedback(selectedLatestPlan.id, "reject")}>Reject</Button>
              <Button variant="outline" onClick={() => updateFeedback(selectedLatestPlan.id, "needs_review")}>Needs Review</Button>
              <Button onClick={() => promoteBaseline(selectedLatestPlan.id)}>Mark Baseline</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>History and Compare</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3">
            <Input placeholder="status" value={historyFilter.status} onChange={(e) => setHistoryFilter({ ...historyFilter, status: e.target.value })} />
            <Input placeholder="provider" value={historyFilter.provider} onChange={(e) => setHistoryFilter({ ...historyFilter, provider: e.target.value })} />
            <Button onClick={() => loadHistory()}>Apply Filters</Button>
          </div>
          <ScrollArea className="h-[220px] rounded-md border p-2">
            <div className="grid gap-2">
              {historyRows.map((r) => (
                <div key={r.id} className="rounded-md border bg-secondary/20 p-2 text-sm">
                  v{r.version} | status={r.status} | provider={r.provider || "-"} {r.is_baseline ? "| baseline" : ""}
                </div>
              ))}
            </div>
          </ScrollArea>
          <Separator />
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Against version" value={compareVersion} onChange={(e) => setCompareVersion(e.target.value)} />
            <Button onClick={runCompare}>Compare</Button>
          </div>
          {compareResult ? <pre className="rounded-md border bg-secondary/20 p-3 text-xs">{JSON.stringify(compareResult, null, 2)}</pre> : null}
        </CardContent>
      </Card>
    </div>
  );
}
