"use client";

import * as React from "react";
import {
    HardDrive,
    Database,
    Clock,
    Film,
    TrendingUp,
    Loader2,
    RefreshCw,
    Server,
    Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

interface UsageData {
    organizationId: string;
    storage: {
        billedBytes: number;
        billedMB: number;
        billedGB: number;
        uploadedBytes: number;
        uploadedMB: number;
        compressionRatio: number;
    };
    content: {
        totalVideos: number;
        totalDurationSeconds: number;
        totalDurationMinutes: number;
        totalDurationHours: number;
    };
}

interface VideoBreakdown {
    id: string;
    title: string;
    status: string;
    duration: number | null;
    transcodedBytes: number;
    transcodedMB: number;
    rawBytes: number;
    rawMB: number;
    compressionRatio: number;
    createdAt: string;
}

interface BreakdownData {
    organizationId: string;
    summary: {
        totalVideos: number;
        totalTranscodedBytes: number;
        totalTranscodedMB: number;
        totalRawBytes: number;
        totalRawMB: number;
    };
    videos: VideoBreakdown[];
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDuration(seconds: number): string {
    if (!seconds) return "0m";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

export default function UsagePage() {
    const [usage, setUsage] = React.useState<UsageData | null>(null);
    const [breakdown, setBreakdown] = React.useState<BreakdownData | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const fetchUsage = async () => {
        setLoading(true);
        setError(null);
        try {
            const [usageRes, breakdownRes] = await Promise.all([
                fetch(`${API_URL}/usage`, { credentials: "include" }),
                fetch(`${API_URL}/usage/breakdown`, { credentials: "include" }),
            ]);

            if (!usageRes.ok || !breakdownRes.ok) {
                throw new Error("Failed to fetch usage data");
            }

            const usageData = await usageRes.json();
            const breakdownData = await breakdownRes.json();

            setUsage(usageData);
            setBreakdown(breakdownData);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    React.useEffect(() => {
        fetchUsage();
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-96 gap-4">
                <p className="text-red-400">{error}</p>
                <Button onClick={fetchUsage} variant="outline">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Usage & Storage</h1>
                    <p className="text-muted-foreground mt-1">
                        Monitor your storage consumption and billing metrics
                    </p>
                </div>
                <Button onClick={fetchUsage} variant="outline" size="sm">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                </Button>
            </div>

            {/* Storage Overview Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Billed Storage */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-primary/20">
                            <HardDrive className="w-5 h-5 text-primary" />
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">
                            Billed Storage
                        </span>
                    </div>
                    <p className="text-3xl font-bold text-foreground">
                        {usage?.storage.billedGB.toFixed(2)} <span className="text-lg text-muted-foreground">GB</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                        Transcoded files (what you're charged for)
                    </p>
                </div>

                {/* Total Videos */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-emerald-500/20">
                            <Film className="w-5 h-5 text-emerald-400" />
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">
                            Total Videos
                        </span>
                    </div>
                    <p className="text-3xl font-bold text-foreground">
                        {usage?.content.totalVideos || 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                        Active videos in your library
                    </p>
                </div>

                {/* Total Duration */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-amber-500/20">
                            <Clock className="w-5 h-5 text-amber-400" />
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">
                            Total Duration
                        </span>
                    </div>
                    <p className="text-3xl font-bold text-foreground">
                        {usage?.content.totalDurationHours.toFixed(1)} <span className="text-lg text-muted-foreground">hrs</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                        {formatDuration(usage?.content.totalDurationSeconds || 0)} of video content
                    </p>
                </div>

                {/* Compression Savings */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-cyan-500/5 border border-cyan-500/20">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-cyan-500/20">
                            <Zap className="w-5 h-5 text-cyan-400" />
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">
                            Space Saved
                        </span>
                    </div>
                    <p className="text-3xl font-bold text-foreground">
                        {usage?.storage.compressionRatio || 0}<span className="text-lg text-muted-foreground">%</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                        Compression efficiency vs raw uploads
                    </p>
                </div>
            </div>

            {/* Billing Breakdown */}
            <div className="p-6 rounded-2xl bg-card/50 border border-border">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                            <Database className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-foreground">Storage Breakdown</h2>
                            <p className="text-sm text-muted-foreground">Per-video storage usage</p>
                        </div>
                    </div>
                </div>

                {breakdown?.videos.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <Film className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p>No videos yet. Upload your first video to see usage stats.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-border">
                                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Video</th>
                                    <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">Duration</th>
                                    <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                                        Storage <span className="text-xs font-normal">(transcoded)</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {breakdown?.videos.map((video) => (
                                    <tr key={video.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                                        <td className="py-4 px-4">
                                            <div className="flex items-center gap-3">
                                                <div className={cn(
                                                    "w-2 h-2 rounded-full",
                                                    video.status === "ready" ? "bg-emerald-500" :
                                                    video.status === "processing" ? "bg-amber-500 animate-pulse" :
                                                    "bg-red-500"
                                                )} />
                                                <div>
                                                    <p className="font-medium text-foreground truncate max-w-[300px]">
                                                        {video.title}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground font-mono">
                                                        {video.id.slice(0, 8)}...
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="py-4 px-4 text-right text-sm text-muted-foreground">
                                            {video.duration ? formatDuration(video.duration) : "-"}
                                        </td>
                                        <td className="py-4 px-4 text-right">
                                            <span className="text-sm font-medium text-foreground">
                                                {formatBytes(video.transcodedBytes)}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Billing Info */}
            <div className="p-6 rounded-2xl bg-gradient-to-r from-primary/5 to-accent/5 border border-primary/10">
                <div className="flex items-start gap-4">
                    <div className="p-3 rounded-xl bg-primary/10">
                        <Server className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                        <h3 className="font-semibold text-foreground mb-2">Transparent Billing</h3>
                        <p className="text-sm text-muted-foreground">
                            You are billed based on <span className="text-foreground font-medium">transcoded storage</span> — 
                            the actual HLS segments, thumbnails, and subtitles we store and deliver. 
                            Raw uploads are temporary and not counted toward your bill.
                        </p>
                        <div className="mt-4 flex items-center gap-6 text-sm">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-primary/50" />
                                <span className="text-muted-foreground">Transcoded (Billed)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-muted" />
                                <span className="text-muted-foreground">Raw Upload (Not Billed)</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
