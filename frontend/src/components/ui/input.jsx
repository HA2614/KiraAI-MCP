import React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm text-foreground ring-offset-background transition-[border-color,background-color,box-shadow] duration-150 ease-[var(--ease-out)] placeholder:text-muted-foreground focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className
      )}
      {...props}
    />
  );
}
