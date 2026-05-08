import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Undo2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";

export function ExplorerView({
  currentPath, parentPath, entries, tree, loadExplorer, navigateExplorer, goBack, goForward, canGoBack, canGoForward,
  openEntry, selectedPaths, toggleSelect, openFilePath, setOpenFilePath, openFileContent, setOpenFileContent,
  dirtyFile, setDirtyFile, saveFile, fsConnected, createFolder, createFile, renameSelected, deleteSelected,
  copySelected, moveSelected, filter, setFilter
}) {
  const [addressDraft, setAddressDraft] = useState(currentPath || "");
  const filtered = useMemo(() => entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase())), [entries, filter]);
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);

  useEffect(() => {
    setAddressDraft(currentPath || "");
  }, [currentPath]);

  function submitAddress(event) {
    event?.preventDefault();
    if (addressDraft.trim()) navigateExplorer(addressDraft.trim());
  }

  return (
    <Card className="overflow-hidden border-slate-300 bg-[#f3f3f3] shadow-sm">
      <CardHeader className="border-b border-slate-300 bg-[#fafafa] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
            <Folder className="h-5 w-5 fill-[#f7d774] text-[#c28a20]" />
            File Explorer
          </CardTitle>
          <span className="rounded-sm border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600">
            {fsConnected ? "Live filesystem" : "Polling fallback"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-0 p-0">
        <div className="border-b border-slate-300 bg-[#f7f7f7] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <WinIconButton title="Back" onClick={goBack} disabled={!canGoBack}><ChevronLeft className="h-4 w-4" /></WinIconButton>
            <WinIconButton title="Forward" onClick={goForward} disabled={!canGoForward}><ChevronRight className="h-4 w-4" /></WinIconButton>
            <WinIconButton title="Refresh" onClick={() => loadExplorer(currentPath)}><RefreshCw className="h-4 w-4" /></WinIconButton>
            <div className="ml-2 h-6 w-px bg-slate-300" />
            <WinCommandButton onClick={createFolder}><FolderPlus className="h-4 w-4" />New folder</WinCommandButton>
            <WinCommandButton onClick={createFile}><FilePlus2 className="h-4 w-4" />New file</WinCommandButton>
            <WinCommandButton onClick={renameSelected} disabled={selectedPaths.length !== 1}><Pencil className="h-4 w-4" />Rename</WinCommandButton>
            <WinCommandButton onClick={copySelected} disabled={!selectedPaths.length}><Copy className="h-4 w-4" />Copy</WinCommandButton>
            <WinCommandButton onClick={moveSelected} disabled={!selectedPaths.length}><Undo2 className="h-4 w-4 rotate-180" />Move</WinCommandButton>
            <WinCommandButton danger onClick={deleteSelected} disabled={!selectedPaths.length}><Trash2 className="h-4 w-4" />Delete</WinCommandButton>
          </div>
        </div>

        <div className="border-b border-slate-300 bg-white px-3 py-2">
          <form className="flex flex-col gap-2 lg:flex-row lg:items-center" onSubmit={submitAddress}>
            <div className="flex min-h-10 flex-1 items-center overflow-hidden rounded-sm border border-slate-300 bg-white">
              <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-2">
                {breadcrumbs.map((crumb, index) => (
                  <React.Fragment key={`${crumb.path}-${index}`}>
                    {index > 0 ? <ChevronRight className="mx-1 h-3.5 w-3.5 shrink-0 text-slate-400" /> : null}
                    <button
                      type="button"
                      className="shrink-0 rounded-sm px-1.5 py-1 text-sm text-slate-700 hover:bg-[#dbeafe]"
                      onClick={() => navigateExplorer(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <Input
              className="h-10 rounded-sm border-slate-300 bg-white font-mono text-xs lg:w-[34rem]"
              value={addressDraft}
              onChange={(event) => setAddressDraft(event.target.value)}
              aria-label="Address"
            />
            <Button className="rounded-sm bg-[#0078d4] hover:bg-[#106ebe]" type="submit">Go</Button>
          </form>
        </div>

        <div className="grid min-h-[520px] lg:grid-cols-[280px_1fr]">
          <aside className="border-r border-slate-300 bg-[#f8f8f8] p-2">
            <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Navigation pane</p>
            <ScrollArea className="h-[470px]">
              <TreeNode node={tree} onOpen={navigateExplorer} />
            </ScrollArea>
          </aside>

          <main className="bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 bg-[#fafafa] px-3 py-2">
              <div className="text-xs text-slate-600">
                {selectedPaths.length ? `${selectedPaths.length} selected` : `${filtered.length} item(s)`}
              </div>
              <div className="relative w-full max-w-sm">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  className="h-9 rounded-sm border-slate-300 pl-8"
                  placeholder="Search this folder..."
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-[34px_minmax(220px,1fr)_130px_190px_150px] border-b border-slate-300 bg-[#f3f3f3] px-3 py-1.5 text-xs font-semibold text-slate-700">
              <div />
              <div>Name</div>
              <div>Size</div>
              <div>Date modified</div>
              <div>Type</div>
            </div>
            <ScrollArea className="h-[430px]">
              <div role="listbox" aria-label="Folder contents">
                {filtered.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onDoubleClick={() => openEntry(entry)}
                    onClick={(event) => toggleSelect(entry.path, event.ctrlKey || event.metaKey)}
                    className={`grid w-full grid-cols-[34px_minmax(220px,1fr)_130px_190px_150px] items-center px-3 py-1.5 text-left text-sm outline-none hover:bg-[#e5f3ff] focus:bg-[#cce8ff] ${
                      selectedPaths.includes(entry.path) ? "bg-[#cce8ff] ring-1 ring-inset ring-[#99d1ff]" : ""
                    }`}
                    title="Double-click to open"
                  >
                    <div>{entry.kind === "directory" ? <WindowsFolderIcon /> : <WindowsFileIcon />}</div>
                    <div className="truncate text-slate-900">{entry.name}</div>
                    <div className="truncate text-xs text-slate-600">{entry.inaccessible ? "Unavailable" : entry.sizeLabel}</div>
                    <div className="truncate text-xs text-slate-600">{formatDate(entry.modifiedAt)}</div>
                    <div className="truncate text-xs text-slate-600">{entry.typeLabel || (entry.kind === "directory" ? "File folder" : "File")}</div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </main>
        </div>

        <div className="border-t border-slate-300 bg-[#f7f7f7] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-slate-800">Editor {dirtyFile ? "(unsaved changes)" : ""}</p>
            <Button className="rounded-sm bg-[#0078d4] hover:bg-[#106ebe]" size="sm" onClick={saveFile} disabled={!openFilePath}>
              <Save className="mr-2 h-4 w-4" />Save file
            </Button>
          </div>
          <Input className="mb-2 rounded-sm border-slate-300 font-mono text-xs" value={openFilePath} onChange={(event) => setOpenFilePath(event.target.value)} placeholder="File path" />
          <Textarea className="min-h-[260px] rounded-sm border-slate-300 bg-white font-mono text-xs" value={openFileContent} onChange={(event) => { setOpenFileContent(event.target.value); setDirtyFile(true); }} />
        </div>
      </CardContent>
    </Card>
  );
}

function WinIconButton({ children, ...props }) {
  return (
    <Button variant="ghost" size="sm" className="h-8 w-8 rounded-sm border border-transparent px-0 text-slate-700 hover:border-slate-300 hover:bg-white" {...props}>
      {children}
    </Button>
  );
}

function WinCommandButton({ children, danger = false, className = "", ...props }) {
  const parts = React.Children.toArray(children);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-8 rounded-sm border border-transparent px-2 text-xs hover:border-slate-300 hover:bg-white ${danger ? "text-red-700" : "text-slate-700"} ${className}`}
      {...props}
    >
      <span className="mr-1.5 inline-flex">{parts[0]}</span>{parts.slice(1)}
    </Button>
  );
}

function WindowsFolderIcon() {
  return <Folder className="h-4 w-4 fill-[#f7d774] text-[#c28a20]" />;
}

function WindowsFileIcon() {
  return <FileText className="h-4 w-4 fill-white text-[#4b83c3]" />;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function buildBreadcrumbs(value) {
  const pathValue = value || "";
  if (/^[a-zA-Z]:[\\/]/.test(pathValue)) {
    const drive = pathValue.slice(0, 3);
    const parts = pathValue.slice(3).split(/[\\/]+/).filter(Boolean);
    return [
      { label: drive, path: drive },
      ...parts.map((part, index) => ({
        label: part,
        path: drive + parts.slice(0, index + 1).join("\\")
      }))
    ];
  }

  const parts = pathValue.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.map((part, index) => ({
    label: part,
    path: `/${parts.slice(0, index + 1).join("/")}`
  }));
}

function TreeNode({ node, onOpen, level = 0 }) {
  if (!node || node.kind !== "directory") return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm text-slate-700 hover:bg-[#e5f3ff]"
        style={{ paddingLeft: `${8 + level * 14}px` }}
      >
        <WindowsFolderIcon />
        <span className="truncate">{node.name || node.path}</span>
      </button>
      {Array.isArray(node.children) ? node.children.map((child) => <TreeNode key={child.path} node={child} onOpen={onOpen} level={level + 1} />) : null}
      {node.truncated ? <p className="px-2 py-1 text-xs text-slate-400" style={{ paddingLeft: `${24 + level * 14}px` }}>More folders hidden...</p> : null}
    </div>
  );
}
