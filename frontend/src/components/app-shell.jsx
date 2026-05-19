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
  LogOut,
  RefreshCw,
  Settings2,
  Wifi,
  WifiOff
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_TABS = [
  ["projects", "Projects", FolderOpen],
  ["plans", "Plans", FileText],
  ["structure", "Advanced Structure", GitBranch],
  ["explorer", "Explorer", Files],
  ["analyzer", "KiraAI Analyzer", BarChart2],
  ["code", "KiraAI Code", Code2],
  ["settings", "KiraAI Settings", Settings2]
];

export function AppShell({ tab, setTab, title, connectionStatus, onRetryConnection, authState, onLogout, children }) {
  const status = connectionStatus?.status || "checking";
  const isOnline = status === "online";
  const isChecking = status === "checking";

  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row">
      <aside className="z-30 flex w-full shrink-0 flex-col overflow-hidden border-b border-border/70 bg-[#0f0d0a] lg:sticky lg:top-0 lg:h-screen lg:w-[268px] lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 px-4 py-4 lg:py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/20 text-primary shadow-sm shadow-black/30">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">KiraAI</p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">AI workbench</p>
          </div>
        </div>

        <div className="mx-4 hidden h-px bg-border/70 lg:block" />

        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 lg:flex-1 lg:flex-col lg:space-y-1 lg:overflow-y-auto lg:py-3">
          {NAV_TABS.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "group flex min-w-max items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-[background-color,color,border-color,transform] duration-150 lg:w-full lg:min-w-0 lg:gap-3",
                tab === value
                  ? "border border-primary/25 bg-primary/10 font-medium text-foreground"
                  : "border border-transparent text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors",
                  tab === value ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                )}
              />
              <span className="flex-1 truncate text-left">{label}</span>
              {tab === value ? <span className="hidden h-1.5 w-1.5 shrink-0 rounded-full bg-primary lg:block" /> : null}
            </button>
          ))}
        </nav>

        <div className="border-t border-border/70 px-4 py-3">
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
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex min-h-14 items-center gap-4 border-b border-border/70 bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">Focused workspace for projects, code, learning, and review.</p>
          </div>
          {authState?.enabled ? (
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span className="hidden max-w-[220px] truncate text-xs text-muted-foreground sm:inline">
                {authState.user?.displayName || authState.user?.email || "Signed in"}
              </span>
              <button
                type="button"
                onClick={onLogout}
                title="Sign out"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border/70 bg-card/70 px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          ) : null}
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="w-full space-y-4 p-3 sm:p-4 lg:p-5">{children}</div>
        </main>
      </div>
    </div>
  );
}
