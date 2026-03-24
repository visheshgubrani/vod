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
}

function StatCard({ title, icon, children, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-sm border border-border bg-card/65 p-4 md:p-6 backdrop-blur-sm transition-colors hover:bg-card/70",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-muted-foreground">
          {title}
        </span>
        <div className="p-2 rounded-sm bg-accent/20 shadow-lg">{icon}</div>
      </div>
      {children}
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
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {/* Storage */}
      <StatCard
        title="Storage Used"
        icon={<HardDrive className="size-4.5 text-teal-400" />}
      >
        <div className="flex flex-col items-start justify-between gap-6">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl md:text-3xl font-semibold text-foreground">
              {storageUsed.toFixed(2)}
            </span>
            <span className="text-sm text-foreground/80">
              {hasStorageLimit ? `/ ${storageTotal} GB` : "GB billed"}
            </span>
          </div>
          {hasStorageLimit ? (
            <Progress
              value={storageUsed}
              max={storageTotal}
              variant={storageVariant}
            />
          ) : (
            <div className="text-xs font-light text-muted-foreground">
              Based on transcoded output
            </div>
          )}
        </div>
      </StatCard>

      {/* Bandwidth */}
      <StatCard
        title="Bandwidth (Last 30 Days)"
        icon={<Wifi className="size-4.5 text-purple-300" />}
      >
        <div className="flex items-baseline gap-1">
          <span className="text-2xl md:text-3xl font-semibold text-foreground">
            {bandwidth === null ? "—" : bandwidth.toFixed(2)}
          </span>
          {bandwidth !== null && (
            <span className="text-sm text-foreground/80">GB</span>
          )}
        </div>
        <div className="text-xs font-light text-muted-foreground">
          Updated just now
        </div>
      </StatCard>

      {/* Videos */}
      <StatCard
        title="Total Videos"
        icon={<Film className="size-4.5 text-lime-600" />}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-2xl md:text-3xl font-semibold text-foreground">
            {totalVideos}
          </span>
          <span className="text-sm text-foreground/80">Active</span>
        </div>
        {processingVideos > 0 && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-amber-300">
              {processingVideos} processing
            </span>
          </div>
        )}
      </StatCard>
    </div>
  );
}
