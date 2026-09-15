"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface DashboardPageHeaderProps {
  title: string;
  description: string;
  actions?: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * The standard page header for every dashboard route: a 30–36px title, a
 * 15–16px description capped at a readable measure, and the primary actions
 * aligned to the top on desktop and stacked below on small screens.
 */
export function DashboardPageHeader({
  title,
  description,
  actions,
  className,
  contentClassName,
}: DashboardPageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-8",
        className,
      )}
    >
      <div className={cn("min-w-0 max-w-2xl", contentClassName)}>
        <h1 className="dash-title text-foreground">{title}</h1>
        <p className="dash-body mt-2 text-muted-foreground">{description}</p>
      </div>

      {actions ? (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
