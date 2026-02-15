"use client";

import * as React from "react";
import {
    HardDrive,
    Database,
    Film,
    Loader2,
    RefreshCw,
    Server,
    TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    BarChart,
    Bar,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";

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

interface BandwidthData {
    organizationId: string;
    period: { days: number };
    bandwidth: {
        totalBytes: number;
        totalMB: number;
        totalGB: number;
        totalRequests: number;
    };
    byFileType: Array<{
        type: string;
        bytes: number;
        megabytes: number;
        requests: number;
        percentage: number;
    }>;
}

interface DailyBandwidth {
    organizationId: string;
    period: { days: number };
    daily: Array<{
        date: string;
        bytes: number;
        megabytes: number;
        gigabytes: number;
        requests: number;
    }>;
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

export default function UsagePage() {
    const [usage, setUsage] = React.useState<UsageData | null>(null);
    const [bandwidth, setBandwidth] = React.useState<BandwidthData | null>(null);
    const [dailyBandwidth, setDailyBandwidth] = React.useState<DailyBandwidth | null>(null);
    const [breakdown, setBreakdown] = React.useState<BreakdownData | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const fetchUsage = async () => {
        setLoading(true);
        setError(null);
        try {
            const [usageRes, bandwidthRes, dailyRes, breakdownRes] = await Promise.all([
                fetch(`${API_URL}/usage`, { credentials: "include" }),
                fetch(`${API_URL}/usage/bandwidth?days=30`, { credentials: "include" }),
                fetch(`${API_URL}/usage/bandwidth/daily?days=30`, { credentials: "include" }),
                fetch(`${API_URL}/usage/breakdown`, { credentials: "include" }),
            ]);

            if (!usageRes.ok) throw new Error("Failed to fetch usage data");
            if (!breakdownRes.ok) throw new Error("Failed to fetch breakdown data");

            const usageData = await usageRes.json();
            const breakdownData = await breakdownRes.json();

            setUsage(usageData);
            setBreakdown(breakdownData);

            // Bandwidth may not be configured, handle gracefully
            if (bandwidthRes.ok) {
                const bandwidthData = await bandwidthRes.json();
                setBandwidth(bandwidthData);
            }
            if (dailyRes.ok) {
                const dailyData = await dailyRes.json();
                setDailyBandwidth(dailyData);
            }
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

    // Prepare sparkline data (last 7 days for compact view)
    const sparklineData = dailyBandwidth?.daily.slice(-7).map((d) => ({
        value: d.gigabytes,
    })) || [];

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Usage & Billing</h1>
                    <p className="text-muted-foreground mt-1">
                        Monitor your infrastructure consumption
                    </p>
                </div>
                <Button onClick={fetchUsage} variant="outline" size="sm">
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                </Button>
            </div>

            {/* Billing Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Storage Card */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-primary/20">
                            <HardDrive className="w-5 h-5 text-primary" />
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">
                            Storage Used
                        </span>
                    </div>
                    <p className="text-4xl font-bold text-foreground mb-2">
                        {usage?.storage.billedGB.toFixed(2)}{" "}
                        <span className="text-xl text-muted-foreground">GB</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Transcoded assets
                    </p>
                </div>

                {/* Bandwidth Card */}
                <div className="p-6 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-emerald-500/20">
                            <TrendingUp className="w-5 h-5 text-emerald-400" />
                        </div>
                        <span className="text-sm font-medium text-muted-foreground">
                            Bandwidth (Last 30 Days)
                        </span>
                    </div>
                    <div className="flex items-end justify-between mb-2">
                        <p className="text-4xl font-bold text-foreground">
                            {bandwidth?.bandwidth.totalGB.toFixed(2) || "—"}{" "}
                            <span className="text-xl text-muted-foreground">GB</span>
                        </p>
                        {sparklineData.length > 0 && (
                            <div className="w-32 h-12">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={sparklineData}>
                                        <Line
                                            type="monotone"
                                            dataKey="value"
                                            stroke="#10b981"
                                            strokeWidth={2}
                                            dot={false}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {bandwidth ? `${bandwidth.bandwidth.totalRequests.toLocaleString()} requests` : "Not configured"}
                    </p>
                </div>
            </div>

            {/* Daily Bandwidth Chart */}
            {dailyBandwidth && dailyBandwidth.daily.length > 0 && (
                <div className="p-6 rounded-2xl bg-card/50 border border-border">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-2 rounded-lg bg-primary/10">
                            <Database className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-foreground">
                                Bandwidth Usage (Daily)
                            </h2>
                            <p className="text-sm text-muted-foreground">Last 30 days</p>
                        </div>
                    </div>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={dailyBandwidth.daily}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                <XAxis
                                    dataKey="date"
                                    tickFormatter={(value: string) => {
                                        try {
                                            return format(parseISO(value), "MMM d");
                                        } catch {
                                            return value;
                                        }
                                    }}
                                    stroke="#888"
                                    style={{ fontSize: "12px" }}
                                />
                                <YAxis
                                    stroke="#888"
                                    style={{ fontSize: "12px" }}
                                    tickFormatter={(value: number) => `${value.toFixed(1)} GB`}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "#1a1a1a",
                                        border: "1px solid #333",
                                        borderRadius: "8px",
                                    }}
                                    labelFormatter={(label) => {
                                        if (typeof label === 'string') {
                                            try {
                                                return format(parseISO(label), "MMM d, yyyy");
                                            } catch {
                                                return label;
                                            }
                                        }
                                        return label;
                                    }}
                                    formatter={(value) => [
                                        `${(value as number).toFixed(2)} GB`,
                                        "Bandwidth",
                                    ]}
                                />
                                <Bar dataKey="gigabytes" fill="#10b981" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            {/* Video Breakdown Table */}
            <div className="p-6 rounded-2xl bg-card/50 border border-border">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10">
                            <Film className="w-5 h-5 text-primary" />
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
                                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">
                                        Video
                                    </th>
                                    <th className="text-center py-3 px-4 text-sm font-medium text-muted-foreground">
                                        Status
                                    </th>
                                    <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                                        Storage
                                    </th>
                                    <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">
                                        Created
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {breakdown?.videos.map((video) => (
                                    <tr
                                        key={video.id}
                                        className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                                    >
                                        <td className="py-4 px-4">
                                            <div className="flex items-center gap-3">
                                                <div
                                                    className={cn(
                                                        "w-2 h-2 rounded-full",
                                                        video.status === "ready"
                                                            ? "bg-emerald-500"
                                                            : video.status === "processing"
                                                            ? "bg-amber-500 animate-pulse"
                                                            : "bg-red-500"
                                                    )}
                                                />
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
                                        <td className="py-4 px-4 text-center">
                                            <span
                                                className={cn(
                                                    "inline-flex items-center px-2 py-1 rounded text-xs font-medium",
                                                    video.status === "ready"
                                                        ? "bg-emerald-500/20 text-emerald-400"
                                                        : video.status === "processing"
                                                        ? "bg-amber-500/20 text-amber-400"
                                                        : "bg-red-500/20 text-red-400"
                                                )}
                                            >
                                                {video.status}
                                            </span>
                                        </td>
                                        <td className="py-4 px-4 text-right">
                                            <span className="text-sm font-medium text-foreground">
                                                {formatBytes(video.transcodedBytes)}
                                            </span>
                                        </td>
                                        <td className="py-4 px-4 text-right text-sm text-muted-foreground">
                                            {format(new Date(video.createdAt), "MMM d, yyyy")}
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
                            You are billed based on{" "}
                            <span className="text-foreground font-medium">storage</span> (transcoded HLS
                            segments) and{" "}
                            <span className="text-foreground font-medium">bandwidth</span> (data delivered
                            to viewers).
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
