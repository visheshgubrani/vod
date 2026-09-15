"use client";

import * as React from "react";
import { HardDrive, Wifi, Film } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface StatsCardsProps {
  storageUsed: number; // in GB
  storageTotal?: number; // in GB
  bandwidth: number | null; // in GB
  totalVideos: number;
  processingVideos?: number;
}

interface StatCardProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  footnote?: React.ReactNode;
}

function StatCard({
  title,
  icon,
  children,
  className,
  footnote,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "dash-panel flex flex-col gap-4 p-5 md:p-6",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="dash-label">{title}</span>
        <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
          {icon}
        </span>
      </div>
      {children}
      {footnote ? <div className="dash-meta">{footnote}</div> : null}
    </div>
  );
}

export function StatsCards({
  storageUsed,
  storageTotal,
  bandwidth,
  totalVideos,
  processingVideos = 0,
}: StatsCardsProps) {
  const hasStorageLimit = typeof storageTotal === "number" && storageTotal > 0;
  const storagePercentage = hasStorageLimit
    ? (storageUsed / storageTotal) * 100
    : 0;
  const storageVariant =
    storagePercentage > 90
      ? "danger"
      : storagePercentage > 70
        ? "warning"
        : "default";

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <StatCard
        title="Storage billed"
        icon={<HardDrive className="size-4.5" />}
        footnote={
          hasStorageLimit ? undefined : "Measured from transcoded output"
        }
      >
        <div className="flex flex-col gap-4">
          <p className="flex items-baseline gap-1.5">
            <span className="font-mono text-3xl font-semibold tracking-tight text-foreground">
              {storageUsed.toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground">
              {hasStorageLimit ? `/ ${storageTotal} GB` : "GB"}
            </span>
          </p>
          {hasStorageLimit ? (
            <Progress
              value={storageUsed}
              max={storageTotal}
              variant={storageVariant}
            />
          ) : null}
        </div>
      </StatCard>

      <StatCard
        title="Bandwidth, last 30 days"
        icon={<Wifi className="size-4.5" />}
        footnote="Delivery worker egress"
      >
        <p className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tracking-tight text-foreground">
            {bandwidth === null ? "—" : bandwidth.toFixed(2)}
          </span>
          {bandwidth !== null && (
            <span className="text-sm text-muted-foreground">GB</span>
          )}
        </p>
      </StatCard>

      <StatCard
        title="Ready videos"
        icon={<Film className="size-4.5" />}
        footnote={
          processingVideos > 0 ? (
            <span className="inline-flex items-center gap-2">
              <span className="dash-dot status-processing" aria-hidden="true" />
              <span className="text-processing">
                {processingVideos} still processing
              </span>
            </span>
          ) : (
            "Nothing in the queue"
          )
        }
      >
        <p className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tracking-tight text-foreground">
            {totalVideos}
          </span>
          <span className="text-sm text-muted-foreground">assets</span>
        </p>
      </StatCard>
    </div>
  );
}
