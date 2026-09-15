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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";
const VIDEOS_PER_PAGE = 10;
const BANDWIDTH_PERIOD_DAYS = 30;

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

const bandwidthChartConfig = {
  gigabytes: {
    label: "Bandwidth served",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const countNumber = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return countNumber.format(value || 0);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (Array.isArray(value)) return toNumber(value[0] as unknown);
  return 0;
}

function safeDateLabel(value: string): string {
  try {
    return format(parseISO(value), "MMM d");
  } catch {
    return value;
  }
}

function safeLongDateLabel(value: string): string {
  try {
    return format(parseISO(value), "MMM d, yyyy");
  } catch {
    return value;
  }
}

/** Status pills follow the shared ready / processing / failed palette. */
function statusBadgeVariant(
  status: string
): "ready" | "processing" | "failed" {
  if (status === "ready") return "ready";
  if (status === "processing") return "processing";
  return "failed";
}

function statusDotClass(status: string): string {
  if (status === "ready") return "bg-ready";
  if (status === "processing") return "bg-processing animate-pulse";
  return "bg-failed";
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex w-full items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium tabular-nums text-foreground">
        {value}
      </span>
    </span>
  );
}

function EmptyState({
  icon,
  title,
  description,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-panel-quiet px-6 py-10 text-center",
        className
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full border border-border bg-panel-strong text-muted-foreground">
        {icon}
      </span>
      <p className="mt-4 text-[15px] font-semibold text-foreground">{title}</p>
      <p className="dash-body mt-1.5 max-w-md text-muted-foreground">
        {description}
      </p>
    </div>
  );
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
  // Only real daily buckets are plotted — no synthetic zero-filled days.
  const bandwidthChartData = React.useMemo(
    () => dailyBandwidth?.daily ?? [],
    [dailyBandwidth]
  );
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

  const hasDailyBandwidth = bandwidthChartData.length > 0;
  const hasSparkline = sparklineData.length > 0;

  if (loading) {
    return <DashboardUsageSkeleton />;
  }

  if (error) {
    return (
      <div className="w-full space-y-8">
        <DashboardPageHeader
          title="Usage"
          description="Storage and bandwidth consumed by this organization."
        />
        <div
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-failed/35 bg-failed/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-danger">{error}</p>
          <Button onClick={fetchUsage} variant="outline" size="sm">
            <RefreshCw className="size-4" aria-hidden="true" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-8">
      <DashboardPageHeader
        title="Usage"
        description="Storage and bandwidth consumed by this organization, measured from transcoded output and delivery-worker egress."
        actions={
          <Button onClick={fetchUsage} variant="outline">
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {/* Headline figures */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="dash-panel flex flex-col gap-4 p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <span className="dash-label">Storage used</span>
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
              <HardDrive className="size-4.5" aria-hidden="true" />
            </span>
          </div>
          <p className="flex items-baseline gap-2">
            <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-foreground">
              {(usage?.storage.billedGB ?? 0).toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground">GB stored</span>
          </p>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Raw uploads</dt>
              <dd className="font-mono font-medium tabular-nums text-foreground">
                {formatBytes(usage?.storage.uploadedBytes ?? 0)}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Saved by transcoding</dt>
              <dd className="font-mono font-medium tabular-nums text-foreground">
                {usage?.storage.compressionRatio ?? 0}%
              </dd>
            </div>
          </dl>
          <p className="dash-meta">
            Transcoded HLS output currently stored. This is a running total, not
            a monthly figure.
          </p>
        </div>

        <div className="dash-panel flex flex-col gap-4 p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <span className="dash-label">
              Bandwidth served, last {BANDWIDTH_PERIOD_DAYS} days
            </span>
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
              <TrendingUp className="size-4.5" aria-hidden="true" />
            </span>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <p className="flex items-baseline gap-2">
              <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-foreground">
                {bandwidth ? bandwidth.bandwidth.totalGB.toFixed(2) : "—"}
              </span>
              {bandwidth ? (
                <span className="text-sm text-muted-foreground">GB served</span>
              ) : null}
            </p>
            {hasSparkline ? (
              <div className="shrink-0">
                <div className="h-12 w-full sm:w-32" aria-hidden="true">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sparklineData}>
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="var(--chart-1)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="dash-meta mt-1 text-right">
                  Daily GB, last 7 days
                </p>
              </div>
            ) : null}
          </div>
          <p className="dash-meta">
            {bandwidth
              ? `${formatCount(
                  bandwidth.bandwidth.totalRequests
                )} delivery requests in the last ${BANDWIDTH_PERIOD_DAYS} days.`
              : "Bandwidth analytics is not configured in this deployment."}
          </p>
        </div>
      </div>

      {/* Daily Bandwidth Chart */}
      {dailyBandwidth && (
        <section className="dash-panel p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="dash-section-title text-foreground">
                Bandwidth usage by day
              </h2>
              <p className="dash-meta mt-1.5">
                Gigabytes served per day over the last{" "}
                {dailyBandwidth.period.days} days.
              </p>
            </div>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
              <Database className="size-4.5" aria-hidden="true" />
            </span>
          </div>

          <div className="mt-6">
            {hasDailyBandwidth ? (
              <ChartContainer
                config={bandwidthChartConfig}
                className="h-80 w-full sm:h-96"
              >
                <BarChart
                  accessibilityLayer
                  data={bandwidthChartData}
                  margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
                >
                  <CartesianGrid
                    strokeDasharray="4 4"
                    stroke="var(--border-soft)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                    tickMargin={10}
                    tick={{ fontSize: 13, fill: "var(--muted-foreground)" }}
                    tickFormatter={(value: string) => safeDateLabel(value)}
                  />
                  <YAxis
                    width={72}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 13, fill: "var(--muted-foreground)" }}
                    tickFormatter={(value: number) => `${value.toFixed(1)} GB`}
                  />
                  <ChartTooltip
                    cursor={{ fill: "var(--panel-strong)", opacity: 0.4 }}
                    content={
                      <ChartTooltipContent
                        className="text-[13px]"
                        labelFormatter={(label) =>
                          safeLongDateLabel(String(label))
                        }
                        formatter={(value) => (
                          <TooltipRow
                            label="Bandwidth served"
                            value={`${toNumber(value).toFixed(2)} GB`}
                          />
                        )}
                      />
                    }
                  />
                  <Bar
                    dataKey="gigabytes"
                    fill="var(--chart-1)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={28}
                  />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyState
                className="h-72"
                icon={<Database className="size-5" aria-hidden="true" />}
                title="No bandwidth recorded yet"
                description="Daily egress appears here after the delivery worker serves its first segment. Play a video through its delivery URL to generate traffic."
              />
            )}
          </div>
        </section>
      )}

      {/* Video Breakdown Table */}
      <section className="dash-panel p-5 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="dash-section-title text-foreground">
              Storage breakdown
            </h2>
            <p className="dash-meta mt-1.5">
              Transcoded storage per asset. Totals are current, not per period.
            </p>
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
            <Film className="size-4.5" aria-hidden="true" />
          </span>
        </div>

        {totalVideos === 0 ? (
          <EmptyState
            className="mt-6 py-12"
            icon={<Film className="size-5" aria-hidden="true" />}
            title="No videos yet"
            description="Upload your first video to see how much storage each asset takes. Per-asset rows appear once transcoding finishes."
          />
        ) : (
          <>
            <div className="mt-6 hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-[13px] font-semibold text-muted-foreground">
                    <th className="px-5 py-3 text-left font-semibold">Video</th>
                    <th className="px-5 py-3 text-center font-semibold">
                      Status
                    </th>
                    <th className="px-5 py-3 text-right font-semibold">
                      Storage
                    </th>
                    <th className="px-5 py-3 text-right font-semibold">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedVideos.map((video) => (
                    <tr
                      key={video.id}
                      className="border-b border-border-soft transition-colors last:border-b-0 hover:bg-panel-strong/40"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              "dash-dot",
                              statusDotClass(video.status)
                            )}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="max-w-[320px] truncate text-[15px] font-medium text-foreground">
                              {video.title}
                            </p>
                            <p className="mt-0.5 font-mono text-[13px] text-muted-foreground">
                              {video.id.slice(0, 8)}…
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-center">
                        <Badge variant={statusBadgeVariant(video.status)}>
                          {video.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-4 text-right">
                        <span className="font-mono text-[15px] font-medium tabular-nums text-foreground">
                          {formatBytes(video.transcodedBytes)}
                        </span>
                        <p className="dash-meta mt-0.5">
                          from {formatBytes(video.rawBytes)} raw
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-right text-[15px] text-muted-foreground">
                        {format(new Date(video.createdAt), "MMM d, yyyy")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="mt-6 divide-y divide-border-soft md:hidden">
              {paginatedVideos.map((video) => (
                <li key={video.id} className="space-y-3 py-4">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "dash-dot mt-2",
                        statusDotClass(video.status)
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-medium text-foreground">
                        {video.title}
                      </p>
                      <p className="mt-0.5 font-mono text-[13px] text-muted-foreground">
                        {video.id.slice(0, 8)}…
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 rounded-xl border border-border-soft bg-panel-quiet p-4 text-[13px]">
                    <div>
                      <p className="text-muted-foreground">Status</p>
                      <p className="mt-1.5">
                        <Badge variant={statusBadgeVariant(video.status)}>
                          {video.status}
                        </Badge>
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Storage</p>
                      <p className="mt-1.5 font-mono text-[15px] tabular-nums text-foreground">
                        {formatBytes(video.transcodedBytes)}
                      </p>
                      <p className="dash-meta mt-0.5">
                        from {formatBytes(video.rawBytes)} raw
                      </p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-muted-foreground">Created</p>
                      <p className="mt-1.5 text-[15px] text-foreground">
                        {format(new Date(video.createdAt), "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {totalVideos > 0 && (
              <nav
                aria-label="Storage breakdown pagination"
                className="mt-6 flex flex-col gap-4 border-t border-border-soft pt-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <p className="dash-meta">
                  Showing{" "}
                  <span className="font-mono text-foreground">
                    {rangeStart}–{rangeEnd}
                  </span>{" "}
                  of{" "}
                  <span className="font-mono text-foreground">
                    {totalVideos}
                  </span>{" "}
                  assets
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCurrentPage((page) => Math.max(1, page - 1))
                    }
                    disabled={currentPage === 1}
                    className="flex-1 sm:flex-none"
                  >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                    Previous
                  </Button>
                  <span className="dash-meta whitespace-nowrap px-2">
                    Page{" "}
                    <span className="font-mono text-foreground">
                      {currentPage}
                    </span>{" "}
                    of{" "}
                    <span className="font-mono text-foreground">
                      {totalPages}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCurrentPage((page) => Math.min(totalPages, page + 1))
                    }
                    disabled={currentPage === totalPages}
                    className="flex-1 sm:flex-none"
                  >
                    Next
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </nav>
            )}
          </>
        )}
      </section>

      {/* Usage metering note */}
      <section className="dash-panel-quiet p-5 md:p-6">
        <div className="flex items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-panel-strong text-muted-foreground">
            <Server className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">
              Usage metering
            </h3>
            <p className="dash-body mt-1.5 max-w-2xl text-muted-foreground">
              These numbers measure{" "}
              <span className="font-medium text-foreground">storage</span>{" "}
              (transcoded HLS segments on your R2 bucket) and{" "}
              <span className="font-medium text-foreground">bandwidth</span>{" "}
              (bytes your delivery worker served). They are operational metrics
              for your own infrastructure costs — ClipMux does not bill you.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
