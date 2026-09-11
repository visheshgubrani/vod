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
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-white",
  outline: "text-foreground",
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
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
