import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Small status pill.
 *
 * Deliberately dependency-free (a styled `span` rather than a Radix primitive):
 * it is used for status text — job state, provider, media type — where the
 * accessibility requirements are met by putting the meaning in the text itself.
 * A badge that conveys state by colour alone is unreadable to a screen reader and
 * to roughly one in twelve men.
 */
const VARIANTS = {
  default: "border-transparent bg-brand text-brand-foreground",
  secondary: "border-border bg-panel-strong text-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  outline: "border-border bg-transparent text-muted-foreground",
  /* Tinted status pills — readable on the charcoal panels at 13px. */
  ready: "border-ready/35 bg-ready/10 text-ready",
  processing: "border-processing/35 bg-processing/10 text-processing",
  failed: "border-failed/35 bg-failed/10 text-failed",
  uploading: "border-info/35 bg-info/10 text-info",
  neutral: "border-border bg-panel-strong text-muted-foreground",
} as const;

export type BadgeVariant = keyof typeof VARIANTS;

export function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px] font-medium whitespace-nowrap",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
