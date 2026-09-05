"use client";

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Database,
  Film,
  RefreshCw,
  Server,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardUsageSkeleton } from "@/components/dashboard/page-skeletons";
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
import { format, parseISO, subDays } from "date-fns";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";
const VIDEOS_PER_PAGE = 10;

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

function createFallbackBandwidthPoint(date: Date) {
  return {
    date: date.toISOString(),
    bytes: 0,
    megabytes: 0,
    gigabytes: 0,
    requests: 0,
  };
}

export default function UsagePage() {
  const [usage, setUsage] = React.useState<UsageData | null>(null);
  const [bandwidth, setBandwidth] = React.useState<BandwidthData | null>(null);
  const [dailyBandwidth, setDailyBandwidth] =
    React.useState<DailyBandwidth | null>(null);
  const [breakdown, setBreakdown] = React.useState<BreakdownData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [currentPage, setCurrentPage] = React.useState(1);

  const fetchUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const [usageRes, bandwidthRes, dailyRes, breakdownRes] =
        await Promise.all([
          fetch(`${API_URL}/usage`, { credentials: "include" }),
          fetch(`${API_URL}/usage/bandwidth?days=30`, {
            credentials: "include",
          }),
          fetch(`${API_URL}/usage/bandwidth/daily?days=30`, {
            credentials: "include",
          }),
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

  // Prepare sparkline data (last 7 days for compact view)
  const sparklineData =
    dailyBandwidth?.daily.slice(-7).map((d) => ({
      value: d.gigabytes,
    })) || [];
  const bandwidthChartData = React.useMemo(() => {
    const daily = dailyBandwidth?.daily ?? [];

    if (daily.length >= 5) return daily;

    const fallbackCount = 5;
    const fallbackDays = Array.from({ length: fallbackCount }, (_, index) =>
      createFallbackBandwidthPoint(
        subDays(new Date(), fallbackCount - 1 - index)
      )
    );

    if (daily.length === 0) return fallbackDays;

    return [...fallbackDays.slice(0, fallbackCount - daily.length), ...daily];
  }, [dailyBandwidth]);

  const bandwidthTicks = React.useMemo(
    () => bandwidthChartData.map((item) => item.date),
    [bandwidthChartData]
  );
  const bandwidthBarSize = bandwidthChartData.length > 10 ? 18 : 32;
  const paginatedVideos = React.useMemo(() => {
    const videos = breakdown?.videos ?? [];
    return videos.slice(
      (currentPage - 1) * VIDEOS_PER_PAGE,
      currentPage * VIDEOS_PER_PAGE
    );
  }, [breakdown?.videos, currentPage]);
  const totalVideos = breakdown?.videos.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalVideos / VIDEOS_PER_PAGE));
  const rangeStart =
    totalVideos === 0 ? 0 : (currentPage - 1) * VIDEOS_PER_PAGE + 1;
  const rangeEnd = Math.min(currentPage * VIDEOS_PER_PAGE, totalVideos);

  React.useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  if (loading) {
    return <DashboardUsageSkeleton />;
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
      <DashboardPageHeader
        title="Usage"
        description="Monitor your infrastructure consumption"
        actions={
          <Button
            onClick={fetchUsage}
            variant="outline"
            size="sm"
            className="mt-4"
          >
            <RefreshCw className="w-4 h-4 mr-0.5" />
            Refresh
          </Button>
        }
      />

      {/* Usage cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Storage Card */}
        <div className="rounded-sm border border-primary/20 bg-card/60 p-4 md:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="rounded-sm bg-accent/15 p-2">
              <HardDrive className="w-5 h-5 text-purple-200" />
            </div>
            <span className="text-sm font-medium text-muted-foreground">
              Storage Used
            </span>
          </div>
          <p className="text-4xl font-bold text-foreground mb-2">
            {usage?.storage.billedGB.toFixed(2)}{" "}
            <span className="text-xl text-muted-foreground">GB</span>
          </p>
          <p className="text-xs text-muted-foreground">Transcoded assets</p>
        </div>

        {/* Bandwidth Card */}
        <div className="rounded-sm border border-lime-500/20 bg-lime-500/10 p-4 md:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="rounded-sm bg-lime-100/20 p-2">
              <TrendingUp className="w-5 h-5 text-lime-500" />
            </div>
            <span className="text-sm font-medium text-muted-foreground">
              Bandwidth (Last 30 Days)
            </span>
          </div>
          <div className="mb-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <p className="text-4xl font-bold text-foreground">
              {bandwidth?.bandwidth.totalGB.toFixed(2) || "—"}{" "}
              <span className="text-xl text-muted-foreground">GB</span>
            </p>
            {sparklineData.length > 0 && (
              <div className="h-12 w-full sm:w-32">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparklineData}>
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#84cc16"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {bandwidth
              ? `${bandwidth.bandwidth.totalRequests.toLocaleString()} requests`
              : "Not configured"}
          </p>
        </div>
      </div>

      {/* Daily Bandwidth Chart */}
      {dailyBandwidth && (
        <div className="rounded-sm border border-border bg-card/60 p-4 md:p-6">
          <div className="flex items-start gap-3 mb-6">
            <div className="rounded-sm bg-accent/10 p-3">
              <Database className="size-6 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Bandwidth Usage (Daily)
              </h2>
              <p className="text-sm text-muted-foreground">Last 30 days</p>
            </div>
          </div>
          <div className="h-64 sm:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={bandwidthChartData}
                barCategoryGap={bandwidthChartData.length > 10 ? "12%" : "24%"}
                margin={{ top: 8, right: 8, bottom: 8, left: -18 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  strokeOpacity={0.75}
                />
                <XAxis
                  dataKey="date"
                  ticks={bandwidthTicks}
                  interval="preserveStartEnd"
                  minTickGap={20}
                  tickMargin={10}
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
                  width={75}
                  tickMargin={8}
                  tickFormatter={(value: number) => `${value.toFixed(1)} GB`}
                />
                <Tooltip
                  cursor={false}
                  contentStyle={{
                    backgroundColor: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: "8px",
                  }}
                  labelFormatter={(label) => {
                    if (typeof label === "string") {
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
                <Bar
                  dataKey="gigabytes"
                  fill="hsl(var(--accent))"
                  radius={[4, 4, 0, 0]}
                  barSize={Math.min(bandwidthBarSize, 24)}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Video Breakdown Table */}
      <div className="rounded-sm border border-border bg-card/60 p-4 md:p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="rounded-sm bg-accent/15 p-3">
              <Film className="size-5.5 text-cyan-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Storage Breakdown
              </h2>
              <p className="text-sm text-muted-foreground">
                Per-video storage usage
              </p>
            </div>
          </div>
        </div>

        {breakdown?.videos.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Film className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No videos yet. Upload your first video to see usage stats.</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 text-left text-sm font-semibold text-muted-foreground">
                      Video
                    </th>
                    <th className="px-4 py-3 text-center text-sm font-semibold text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-muted-foreground">
                      Storage
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-muted-foreground">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedVideos.map((video) => (
                    <tr
                      key={video.id}
                      className="border-b border-border/90 transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "h-2 w-2 rounded-full",
                              video.status === "ready"
                                ? "bg-lime-500"
                                : video.status === "processing"
                                ? "bg-amber-400 animate-pulse"
                                : "bg-red-500"
                            )}
                          />
                          <div>
                            <p className="max-w-[300px] truncate font-medium text-foreground">
                              {video.title}
                            </p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {video.id.slice(0, 8)}...
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-center">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium",
                            video.status === "ready"
                              ? "bg-lime-500/20 text-lime-400"
                              : video.status === "processing"
                              ? "bg-amber-500/20 text-amber-400"
                              : "bg-red-500/20 text-red-400"
                          )}
                        >
                          {video.status}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right">
                        <span className="text-sm font-medium text-foreground">
                          {formatBytes(video.transcodedBytes)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right text-sm text-muted-foreground">
                        {format(new Date(video.createdAt), "MMM d, yyyy")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-border md:hidden">
              {paginatedVideos.map((video) => (
                <div key={video.id} className="space-y-3 py-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-1 h-2.5 w-2.5 rounded-full",
                        video.status === "ready"
                          ? "bg-lime-500"
                          : video.status === "processing"
                          ? "bg-amber-500 animate-pulse"
                          : "bg-red-500"
                      )}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {video.title}
                      </p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {video.id.slice(0, 8)}...
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 rounded-sm bg-muted/20 p-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Status</p>
                      <span
                        className={cn(
                          "mt-1 inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium",
                          video.status === "ready"
                            ? "bg-lime-500/20 text-lime-400"
                            : video.status === "processing"
                            ? "bg-amber-500/20 text-amber-400"
                            : "bg-red-500/20 text-red-400"
                        )}
                      >
                        {video.status}
                      </span>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Storage</p>
                      <p className="mt-1 text-sm text-foreground">
                        {formatBytes(video.transcodedBytes)}
                      </p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-muted-foreground">Created</p>
                      <p className="mt-1 text-sm text-foreground">
                        {format(new Date(video.createdAt), "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {totalVideos > 0 && (
              <div className="flex flex-col gap-5 rounded-sm px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <p className="text-sm font-medium text-muted-foreground">
                  Showing {rangeStart}-{rangeEnd} of {totalVideos} videos
                </p>
                <div className="min-w-[88px] rounded-sm bg-muted/30 px-3 py-1 text-center text-xs font-medium text-foreground/50">
                  Page {currentPage} of {totalPages}
                </div>
                <div className="flex md:flex-row flex-col w-full items-center gap-2 self-end sm:w-fit sm:self-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCurrentPage((page) => Math.max(1, page - 1))
                    }
                    disabled={currentPage === 1}
                    className="w-full rounded-sm border border-mauve-300/60 hover:border-mauve-300/40 hover:bg-muted sm:w-fit"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCurrentPage((page) => Math.min(totalPages, page + 1))
                    }
                    disabled={currentPage === totalPages}
                    className="w-full rounded-sm bg-accent/50 hover:bg-accent/60 sm:w-fit"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Usage metering note */}
      <div className="rounded-sm border border-primary/10 bg-card/60 p-4 md:p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-sm bg-accent/15 p-3">
            <Server className="w-6 h-6 text-purple-200" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground mb-1">
              Usage metering
            </h3>
            <p className="text-sm text-muted-foreground">
              These numbers measure{" "}
              <span className="text-foreground font-medium">storage</span>{" "}
              (transcoded HLS segments on your R2 bucket) and{" "}
              <span className="text-foreground font-medium">bandwidth</span>{" "}
              (bytes your delivery worker served). They are operational
              metrics for your own infrastructure costs — OpenVOD does not
              bill you.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
