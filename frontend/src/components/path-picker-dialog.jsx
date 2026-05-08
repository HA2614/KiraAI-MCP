import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Folder, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fsList } from "@/api";

export function PathPickerDialog({ value, onSelect, triggerLabel = "Browse" }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(value || "");
  const [addressDraft, setAddressDraft] = useState(value || "");
  const [items, setItems] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [backStack, setBackStack] = useState([]);
  const [forwardStack, setForwardStack] = useState([]);
  const folders = useMemo(() => items.filter((item) => item.kind === "directory"), [items]);

  useEffect(() => {
    if (!open) return;
    const next = value || current;
    setCurrent(next);
    setAddressDraft(next);
    setSelectedFolder(null);
  }, [open]);

  useEffect(() => {
    if (!open || !current) return;
    setAddressDraft(current);
    setSelectedFolder(null);
    fsList(current).then((data) => setItems(data.entries || [])).catch(() => setItems([]));
  }, [open, current]);

  function navigate(path, pushHistory = true) {
    if (!path || path === current) return;
    if (pushHistory) {
      setBackStack((prev) => [...prev, current].filter(Boolean).slice(-40));
      setForwardStack([]);
    }
    setCurrent(path);
  }

  function goBack() {
    const previous = backStack[backStack.length - 1];
    if (!previous) return;
    setBackStack((prev) => prev.slice(0, -1));
    setForwardStack((prev) => [current, ...prev].filter(Boolean).slice(0, 40));
    setCurrent(previous);
  }

  function goForward() {
    const next = forwardStack[0];
    if (!next) return;
    setForwardStack((prev) => prev.slice(1));
    setBackStack((prev) => [...prev, current].filter(Boolean).slice(-40));
    setCurrent(next);
  }

  function submitAddress(event) {
    event.preventDefault();
    navigate(addressDraft.trim());
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline">{triggerLabel}</Button></DialogTrigger>
      <DialogContent className="max-w-4xl overflow-hidden border-slate-300 p-0">
        <DialogHeader className="border-b border-slate-300 bg-[#fafafa] px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Folder className="h-5 w-5 fill-[#f7d774] text-[#c28a20]" />
            Select folder
          </DialogTitle>
        </DialogHeader>
        <div className="bg-[#f3f3f3]">
          <div className="flex items-center gap-1 border-b border-slate-300 px-3 py-2">
            <WinIconButton title="Back" onClick={goBack} disabled={!backStack.length}><ChevronLeft className="h-4 w-4" /></WinIconButton>
            <WinIconButton title="Forward" onClick={goForward} disabled={!forwardStack.length}><ChevronRight className="h-4 w-4" /></WinIconButton>
            <WinIconButton title="Refresh" onClick={() => fsList(current).then((data) => setItems(data.entries || []))}><RefreshCw className="h-4 w-4" /></WinIconButton>
            <form className="ml-2 flex flex-1 gap-2" onSubmit={submitAddress}>
              <Input className="h-9 rounded-sm border-slate-300 bg-white font-mono text-xs" value={addressDraft} onChange={(event) => setAddressDraft(event.target.value)} />
              <Button className="h-9 rounded-sm bg-[#0078d4] hover:bg-[#106ebe]" type="submit">Go</Button>
            </form>
          </div>
          <ScrollArea className="h-[380px] bg-white">
            <div className="grid p-2">
              {folders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className={`grid grid-cols-[28px_1fr_180px] items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-[#e5f3ff] focus:bg-[#cce8ff] ${
                    selectedFolder?.path === folder.path ? "bg-[#cce8ff] ring-1 ring-inset ring-[#99d1ff]" : ""
                  }`}
                  onClick={() => setSelectedFolder(folder)}
                  onDoubleClick={() => navigate(folder.path)}
                  title="Double-click to open"
                >
                  <Folder className="h-4 w-4 fill-[#f7d774] text-[#c28a20]" />
                  <span className="truncate">{folder.name}</span>
                  <span className="truncate text-xs text-slate-500">{folder.modifiedAt ? new Date(folder.modifiedAt).toLocaleDateString() : ""}</span>
                </button>
              ))}
              {!folders.length ? <p className="rounded-sm border border-dashed p-4 text-sm text-slate-500">No folders found here.</p> : null}
            </div>
          </ScrollArea>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-300 bg-[#f7f7f7] px-3 py-3">
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600">{selectedFolder?.path || current}</p>
            <Button className="rounded-sm bg-[#0078d4] hover:bg-[#106ebe]" onClick={() => { onSelect(selectedFolder?.path || current); setOpen(false); }}>
              Use this folder
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WinIconButton({ children, ...props }) {
  return (
    <Button variant="ghost" size="sm" className="h-8 w-8 rounded-sm border border-transparent px-0 text-slate-700 hover:border-slate-300 hover:bg-white" {...props}>
      {children}
    </Button>
  );
}
