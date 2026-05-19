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
      <DialogContent className="max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 bg-secondary/20 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Folder className="h-5 w-5 fill-[#f7d774] text-[#c28a20]" />
            Select folder
          </DialogTitle>
        </DialogHeader>
        <div className="bg-card">
          <div className="flex items-center gap-1 border-b border-border/70 bg-background/40 px-3 py-2">
            <WinIconButton title="Back" onClick={goBack} disabled={!backStack.length}><ChevronLeft className="h-4 w-4" /></WinIconButton>
            <WinIconButton title="Forward" onClick={goForward} disabled={!forwardStack.length}><ChevronRight className="h-4 w-4" /></WinIconButton>
            <WinIconButton title="Refresh" onClick={() => fsList(current).then((data) => setItems(data.entries || []))}><RefreshCw className="h-4 w-4" /></WinIconButton>
            <form className="ml-2 flex flex-1 gap-2" onSubmit={submitAddress}>
              <Input className="h-9 font-mono text-xs" value={addressDraft} onChange={(event) => setAddressDraft(event.target.value)} />
              <Button className="h-9" type="submit">Go</Button>
            </form>
          </div>
          <ScrollArea className="h-[380px] bg-card/40">
            <div className="grid p-2">
              {folders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className={`grid grid-cols-[28px_1fr_180px] items-center rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary focus:bg-primary/10 ${
                    selectedFolder?.path === folder.path ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : ""
                  }`}
                  onClick={() => setSelectedFolder(folder)}
                  onDoubleClick={() => navigate(folder.path)}
                  title="Double-click to open"
                >
                  <Folder className="h-4 w-4 fill-[#f7d774] text-[#c28a20]" />
                  <span className="truncate">{folder.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{folder.modifiedAt ? new Date(folder.modifiedAt).toLocaleDateString() : ""}</span>
                </button>
              ))}
              {!folders.length ? <p className="rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">No folders found here.</p> : null}
            </div>
          </ScrollArea>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-secondary/20 px-3 py-3">
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{selectedFolder?.path || current}</p>
            <Button onClick={() => { onSelect(selectedFolder?.path || current); setOpen(false); }}>
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
    <Button variant="ghost" size="sm" className="h-8 w-8 rounded-md border border-transparent px-0 text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground" {...props}>
      {children}
    </Button>
  );
}
