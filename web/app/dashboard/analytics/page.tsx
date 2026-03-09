"use client";

import * as React from "react";
import {
    AlertTriangle,
    BarChart3,
    Clapperboard,
    Globe,
    MonitorSmartphone,
    PlayCircle,
    RefreshCw,
    Users,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardAnalyticsSkeleton } from "@/components/dashboard/page-skeletons";
import { Button } from "@/components/ui/button";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

type DateRangeDays = 7 | 30 | 90;

interface HeroStats {
    totalViews: number;
    watchTimeHours: number;
    watchTimeSeconds: number;
    uniqueViewers: number;
    errorRate: number;
    errorRatePercent: number;
}

interface GrowthPoint {
    date: string;
    views: number;
    uniqueViewers: number;
    watchTimeSeconds: number;
    watchTimeHours: number;
}

interface GrowthResponse {
    days: number;
    timeline: GrowthPoint[];
}

interface DemographicsResponse {
    days: number;
    countries: Array<{
        country: string;
        viewers: number;
        sessions: number;
    }>;
    devices: Array<{
        device: string;
        viewers: number;
        sessions: number;
    }>;
}

interface TopVideo {
    videoId: string;
    title: string;
    views: number;
    uniqueViewers: number;
    totalWatchSeconds: number;
    totalWatchHours: number;
    errorRate: number;
    errorRatePercent: number;
}

const RANGE_OPTIONS: Array<{ label: string; value: DateRangeDays }> = [
    { label: "7d", value: 7 },
    { label: "30d", value: 30 },
    { label: "90d", value: 90 },
];

const compactNumber = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
});

function formatCompact(value: number): string {
    return compactNumber.format(value || 0);
}

function formatHours(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return "0h";
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function safeDateLabel(value: string): string {
    try {
        return format(parseISO(value), "MMM d");
    } catch {
        return value;
    }
}

export default function AnalyticsPage() {
    const [rangeDays, setRangeDays] = React.useState<DateRangeDays>(30);
    const [hero, setHero] = React.useState<HeroStats | null>(null);
    const [growth, setGrowth] = React.useState<GrowthPoint[]>([]);
    const [countries, setCountries] = React.useState<DemographicsResponse["countries"]>([]);
    const [devices, setDevices] = React.useState<DemographicsResponse["devices"]>([]);
    const [topVideos, setTopVideos] = React.useState<TopVideo[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const fetchAnalytics = React.useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const [heroRes, growthRes, demographicsRes, topVideosRes] = await Promise.all([
                fetch(`${API_URL}/analytics-stats/organization/hero-stats?days=${rangeDays}`, {
                    credentials: "include",
                }),
                fetch(`${API_URL}/analytics-stats/organization/growth?days=${rangeDays}`, {
                    credentials: "include",
                }),
                fetch(`${API_URL}/analytics-stats/organization/demographics?days=${rangeDays}`, {
                    credentials: "include",
                }),
                fetch(`${API_URL}/analytics-stats/organization/top-videos?limit=8&days=${rangeDays}`, {
                    credentials: "include",
                }),
            ]);

            if (!heroRes.ok || !growthRes.ok || !demographicsRes.ok || !topVideosRes.ok) {
                throw new Error("Failed to fetch organization analytics");
            }

            const [heroData, growthData, demographicsData, topVideosData] = await Promise.all([
                heroRes.json() as Promise<HeroStats>,
                growthRes.json() as Promise<GrowthResponse>,
                demographicsRes.json() as Promise<DemographicsResponse>,
                topVideosRes.json() as Promise<TopVideo[]>,
            ]);

            setHero(heroData);
            setGrowth(growthData.timeline || []);
            setCountries(demographicsData.countries || []);
            setDevices(demographicsData.devices || []);
            setTopVideos(topVideosData || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to fetch analytics");
        } finally {
            setLoading(false);
        }
    }, [rangeDays]);

    React.useEffect(() => {
        fetchAnalytics();
    }, [fetchAnalytics]);

    const countryTotal = countries.reduce((sum, country) => sum + country.viewers, 0);
    const deviceTotal = devices.reduce((sum, device) => sum + device.viewers, 0);

    const growthChartData = growth.map((point) => ({
        ...point,
        label: safeDateLabel(point.date),
    }));

    if (loading) {
        return <DashboardAnalyticsSkeleton />;
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
                <div className="flex items-center gap-2 text-red-400">
                    <AlertTriangle className="w-5 h-5" />
                    <span>{error}</span>
                </div>
                <Button onClick={fetchAnalytics} variant="outline" size="sm">
                    <RefreshCw className="size-4.5 mr-2" />
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-8 max-w-7xl">
            <div className="relative overflow-hidden rounded-sm border border-border bg-card/70 px-6 py-6">
                <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_20%_10%,hsl(var(--primary)/0.22),transparent_48%),radial-gradient(circle_at_88%_30%,hsl(var(--accent)/0.20),transparent_42%)]" />
                <DashboardPageHeader
                    title="Analytics"
                    description="Real-time health view across your entire video catalog."
                    eyebrow="Organization Pulse"
                    className="relative"
                    actions={
                        <>
                            {RANGE_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    onClick={() => setRangeDays(option.value)}
                                    className={cn(
                                        "rounded-full border px-6 py-1.5 text-sm font-medium transition-all",
                                        rangeDays === option.value
                                            ? "border-primary/60 bg-primary/20 text-purple-200"
                                            : "border-muted-foreground/30 border bg-background/30 text-muted-foreground hover:text-foreground hover:border-primary/30"
                                    )}
                                >
                                    Last {option.label}
                                </button>
                            ))}
                        </>
                    }
                />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-muted-foreground">Total Views</p>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <PlayCircle className="size-4.5 text-purple-300" />
                        </div>
                    </div>
                    <p className="mt-3 text-3xl font-semibold text-foreground">
                        {formatCompact(hero?.totalViews || 0)}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">Sessions across all videos</p>
                </div>

                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-muted-foreground">Watch Time</p>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <BarChart3 className="size-4.5 text-cyan-400" />
                        </div>
                    </div>
                    <p className="mt-3 text-3xl font-semibold text-foreground">
                        {formatHours(hero?.watchTimeHours || 0)}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">Total hours consumed</p>
                </div>

                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-muted-foreground">Unique Viewers</p>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <Users className="size-4.5 text-lime-500" />
                        </div>
                    </div>
                    <p className="mt-3 text-3xl font-semibold text-foreground">
                        {formatCompact(hero?.uniqueViewers || 0)}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">Distinct users and sessions</p>
                </div>

                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-muted-foreground">Error Rate</p>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <AlertTriangle className="size-4.5 text-amber-400" />
                        </div>
                    </div>
                    <p className="mt-3 text-3xl font-semibold text-foreground">
                        {(hero?.errorRatePercent || 0).toFixed(2)}%
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">Playback quality signal</p>
                </div>
            </div>

            <div className="rounded-sm border border-border bg-card/60 p-6">
                <div className="mb-6">
                    <h2 className="text-lg font-semibold text-foreground">Views Over Time</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Daily growth trend for the last {rangeDays} days.
                    </p>
                </div>

                {growthChartData.length === 0 ? (
                    <div className="h-72 grid place-items-center text-sm text-muted-foreground">
                        No analytics events yet for this range.
                    </div>
                ) : (
                    <div className="h-72">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={growthChartData} margin={{ left: 8, right: 8 }}>
                                <defs>
                                    <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                                <XAxis
                                    dataKey="label"
                                    stroke="hsl(var(--muted-foreground))"
                                    style={{ fontSize: "12px" }}
                                />
                                <YAxis
                                    stroke="hsl(var(--muted-foreground))"
                                    style={{ fontSize: "12px" }}
                                    allowDecimals={false}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "12px",
                                    }}
                                    formatter={(value: number | undefined, name: string | undefined) => {
                                        const safeValue = value ?? 0;
                                        const safeName = name ?? "value";
                                        if (safeName === "views") return [safeValue.toLocaleString(), "Views"];
                                        if (safeName === "uniqueViewers") return [safeValue.toLocaleString(), "Unique Viewers"];
                                        return [safeValue, safeName];
                                    }}
                                    labelFormatter={(label) => `Date: ${label}`}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="views"
                                    stroke="hsl(var(--primary))"
                                    fill="url(#viewsFill)"
                                    strokeWidth={2.5}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <div>
                            <h3 className="font-semibold text-foreground">Top Countries</h3>
                            <p className="mt-2 text-xs text-muted-foreground">Where your audience watches</p>
                        </div>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <Globe className="size-4.5 text-purple-300" />
                        </div>
                    </div>
                    {countries.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">No country data yet</p>
                    ) : (
                        <div className="space-y-3">
                            {countries.map((country) => {
                                const share = countryTotal > 0 ? (country.viewers / countryTotal) * 100 : 0;
                                return (
                                    <div key={country.country}>
                                        <div className="mb-1 flex items-center justify-between text-sm">
                                            <span className="text-foreground">{country.country}</span>
                                            <span className="text-muted-foreground">{formatCompact(country.viewers)}</span>
                                        </div>
                                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                                            <div
                                                className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
                                                style={{ width: `${Math.max(share, 4)}%` }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <div>
                            <h3 className="font-semibold text-foreground">Device Types</h3>
                            <p className="mt-2 text-xs text-muted-foreground">Desktop vs mobile split</p>
                        </div>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <MonitorSmartphone className="size-4.5 text-cyan-500" />
                        </div>
                    </div>

                    {devices.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">No device data yet</p>
                    ) : (
                        <div className="h-52">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={devices} layout="vertical" margin={{ top: 6, right: 12, left: 12, bottom: 6 }}>
                                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                                    <XAxis type="number" hide />
                                    <YAxis
                                        type="category"
                                        dataKey="device"
                                        width={64}
                                        stroke="hsl(var(--muted-foreground))"
                                        style={{ fontSize: "12px" }}
                                    />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: "hsl(var(--card))",
                                            border: "1px solid hsl(var(--border))",
                                            borderRadius: "12px",
                                        }}
                                        formatter={(value: number | undefined) => [(value ?? 0).toLocaleString(), "Viewers"]}
                                    />
                                    <Bar dataKey="viewers" fill="hsl(var(--accent))" radius={[0, 8, 8, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                            <p className="mt-2 text-xs text-muted-foreground">
                                Total viewers: {formatCompact(deviceTotal)}
                            </p>
                        </div>
                    )}
                </div>

                <div className="rounded-sm border border-border bg-card/60 p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <div>
                            <h3 className="font-semibold text-foreground">Top Videos</h3>
                            <p className="mt-2 text-xs text-muted-foreground">Highest view count content</p>
                        </div>
                        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
                            <Clapperboard className="size-4.5 text-lime-500" />
                        </div>
                    </div>

                    {topVideos.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">No videos ranked yet</p>
                    ) : (
                        <div className="space-y-3">
                            {topVideos.slice(0, 6).map((video, index) => (
                                <div
                                    key={video.videoId}
                                    className="flex items-start justify-between gap-3 rounded-sm border border-border/60 bg-background/30 px-3 py-2"
                                >
                                    <div className="min-w-0">
                                        <p className="text-xs text-muted-foreground">#{index + 1}</p>
                                        <p className="text-sm font-medium text-foreground truncate">
                                            {video.title}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {formatCompact(video.uniqueViewers)} unique viewers
                                        </p>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <p className="text-sm font-semibold text-foreground">
                                            {formatCompact(video.views)}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {video.errorRatePercent.toFixed(2)}% errors
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
