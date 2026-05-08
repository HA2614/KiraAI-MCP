import React from "react";
import {
  BarChart2,
  Bot,
  Code2,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
  Settings2,
  Wifi,
  WifiOff
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_TABS = [
  ["projects", "Projects", FolderOpen],
  ["plans", "Plans", FileText],
  ["structure", "Structure", GitBranch],
  ["explorer", "Explorer", Files],
  ["analyzer", "KiraAI Analyzer", BarChart2],
  ["code", "KiraAI Code", Code2],
  ["settings", "KiraAI Settings", Settings2]
];

export function AppShell({ tab, setTab, title, connectionStatus, onRetryConnection, children }) {
  const status = connectionStatus?.status || "checking";
  const isOnline = status === "online";
  const isChecking = status === "checking";

  return (
    <div className="flex min-h-screen w-full">
      <aside className="sticky top-0 z-30 flex h-screen w-[260px] shrink-0 flex-col overflow-hidden border-r border-neutral-800 bg-neutral-950">
        <div className="flex items-center gap-3 px-4 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight text-white">KiraAI</p>
            <p className="text-[11px] leading-tight text-neutral-500">Local workspace</p>
          </div>
        </div>

        <div className="mx-4 mb-3 h-px bg-neutral-800" />

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
          {NAV_TABS.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-150",
                tab === value
                  ? "bg-neutral-800 font-medium text-white"
                  : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-200"
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors",
                  tab === value ? "text-primary" : "text-neutral-600 group-hover:text-neutral-400"
                )}
              />
              <span className="flex-1 truncate text-left">{label}</span>
              {tab === value ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /> : null}
            </button>
          ))}
        </nav>

        <div className="border-t border-neutral-800 px-4 py-3">
          <div className="flex items-center gap-2.5">
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            ) : isChecking ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 shrink-0 text-red-400" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                isOnline ? "text-emerald-400" : isChecking ? "text-amber-400" : "text-red-400"
              )}
            >
              {isOnline
                ? `Backend online${connectionStatus?.latencyMs ? ` - ${connectionStatus.latencyMs}ms` : ""}`
                : isChecking
                  ? "Checking backend..."
                  : connectionStatus?.message || "Backend offline"}
            </span>
            <button
              type="button"
              onClick={onRetryConnection}
              title="Retry connection"
              className="shrink-0 rounded p-0.5 text-neutral-600 transition-colors hover:text-neutral-300"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-border/60 bg-background/80 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="w-full space-y-5 p-3 sm:p-4">{children}</div>
        </main>
      </div>
    </div>
  );
}
