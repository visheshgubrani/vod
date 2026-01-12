"use client";

import * as React from "react";
import { HardDrive, Wifi, Film } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface StatsCardsProps {
    storageUsed: number; // in GB
    storageTotal: number; // in GB
    bandwidth: number; // in GB
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
                "flex flex-col gap-3 p-5 rounded-2xl bg-card/50 border border-border backdrop-blur-sm hover:bg-card/70 transition-colors",
                className
            )}
        >
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">{title}</span>
                <div className="p-2 rounded-lg bg-muted/50">{icon}</div>
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
    const storagePercentage = (storageUsed / storageTotal) * 100;
    const storageVariant =
        storagePercentage > 90 ? "danger" : storagePercentage > 70 ? "warning" : "default";

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Storage */}
            <StatCard
                title="Storage Used"
                icon={<HardDrive className="w-4 h-4 text-primary" />}
            >
                <div className="space-y-2">
                    <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-bold text-foreground">
                            {storageUsed.toFixed(1)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                            / {storageTotal} GB
                        </span>
                    </div>
                    <Progress value={storageUsed} max={storageTotal} variant={storageVariant} />
                </div>
            </StatCard>

            {/* Bandwidth */}
            <StatCard
                title="Bandwidth (This Month)"
                icon={<Wifi className="w-4 h-4 text-accent" />}
            >
                <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-bold text-foreground">{bandwidth}</span>
                    <span className="text-sm text-muted-foreground">GB</span>
                </div>
                <div className="text-xs text-muted-foreground">
                    Updated just now
                </div>
            </StatCard>

            {/* Videos */}
            <StatCard
                title="Total Videos"
                icon={<Film className="w-4 h-4 text-emerald-400" />}
            >
                <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-foreground">{totalVideos}</span>
                    <span className="text-sm text-muted-foreground">Active</span>
                </div>
                {processingVideos > 0 && (
                    <div className="flex items-center gap-1.5 text-xs">
                        <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                        <span className="text-amber-400">{processingVideos} processing</span>
                    </div>
                )}
            </StatCard>
        </div>
    );
}
