"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface DashboardPageHeaderProps {
  title: string;
  description: string;
  actions?: React.ReactNode;
  eyebrow?: string;
  className?: string;
  contentClassName?: string;
}

export function DashboardPageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  contentClassName,
}: DashboardPageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 md:flex-row md:items-start md:justify-between",
        className
      )}
    >
      <div className={cn("min-w-0", contentClassName)}>
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent/90">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-2.5 font-dashboard-heading text-[2rem] tracking-wide font-medium leading-tight text-foreground">
          {title}
        </h1>
        <p className="mt-1.5 font-dashboard-copy text-sm text-foreground/65 md:text-[17px]">
          {description}
        </p>
      </div>

      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
