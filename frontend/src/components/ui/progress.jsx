import React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export function Progress({ className, value, ...props }) {
  return (
    <ProgressPrimitive.Root className={cn("relative h-2 w-full overflow-hidden rounded-full border border-border/70 bg-background/70", className)} value={value} {...props}>
      <ProgressPrimitive.Indicator className="h-full w-full bg-primary transition-transform duration-200 ease-[var(--ease-out)]" style={{ transform: `translateX(-${100 - (value || 0)}%)` }} />
    </ProgressPrimitive.Root>
  );
}
