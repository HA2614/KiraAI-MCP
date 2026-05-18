import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PathPickerDialog } from "@/components/path-picker-dialog";

export function StructureView({ settings, setSettings, runStructure, selectedProjectId, structureResult }) {
  return (
    <Card>
      <CardHeader><CardTitle>Advanced Structure Generator</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          This legacy generator writes or previews scaffolds directly. For reviewable full-stack proposals, use KiraAI Code and start the Full-stack Structure Workflow.
        </div>
        <div className="flex gap-2">
          <Input value={settings.targetPath} onChange={(e) => setSettings({ ...settings, targetPath: e.target.value })} placeholder="Target path" />
          <PathPickerDialog value={settings.targetPath} onSelect={(p) => setSettings({ ...settings, targetPath: p })} />
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          <Select value={settings.profile} onValueChange={(v) => setSettings({ ...settings, profile: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{["web+api", "web", "api", "docs-only"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={settings.overwriteStrategy} onValueChange={(v) => setSettings({ ...settings, overwriteStrategy: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{["skip_existing", "overwrite_all", "prompt_conflicts"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
          </Select>
          <label className="flex items-center gap-2 rounded-md border bg-card px-3 text-sm"><input type="checkbox" checked={settings.dryRun} onChange={(e) => setSettings({ ...settings, dryRun: e.target.checked })} /> Dry run</label>
        </div>
        <Textarea
          placeholder="Optional prompt for scaffold style, architecture, or constraints..."
          value={settings.structurePrompt || ""}
          onChange={(e) => setSettings({ ...settings, structurePrompt: e.target.value })}
          className="min-h-[110px]"
        />
        <Button onClick={runStructure} disabled={!selectedProjectId}>Generate</Button>
        {structureResult ? <pre className="rounded-md border bg-secondary/20 p-3 text-xs">{JSON.stringify(structureResult, null, 2)}</pre> : null}
      </CardContent>
    </Card>
  );
}
