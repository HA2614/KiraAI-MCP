import React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }) {
  return <TabsPrimitive.List className={cn("inline-flex min-h-10 items-center justify-center rounded-lg border border-border/70 bg-background/50 p-1", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger
      className={cn("inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-[background-color,color,box-shadow] duration-150 ease-[var(--ease-out)] hover:text-foreground data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:shadow-black/20", className)}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }) {
  return <TabsPrimitive.Content className={cn("mt-4", className)} {...props} />;
}
