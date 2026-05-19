import React from "react";
import { cn } from "@/lib/utils";

export function Alert({ className, ...props }) {
  return <div role="alert" className={cn("relative w-full rounded-lg border border-border/70 bg-card px-4 py-3 text-sm text-foreground", className)} {...props} />;
}

export function AlertTitle({ className, ...props }) {
  return <h5 className={cn("mb-1 font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }) {
  return <div className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
