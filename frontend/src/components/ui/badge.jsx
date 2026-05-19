import React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "border-primary/40 bg-primary/20 text-primary",
      secondary: "border-border/70 bg-secondary text-secondary-foreground",
      outline: "border-border/70 bg-background/40 text-muted-foreground"
    }
  },
  defaultVariants: { variant: "default" }
});

export function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
