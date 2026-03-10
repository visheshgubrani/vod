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
import { format, parseISO, subDays } from "date-fns";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Label,
  PolarRadiusAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardAnalyticsSkeleton } from "@/components/dashboard/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

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

type CountryChartRow = {
  country: string;
  viewers: number;
  sessions: number;
  fill: string;
};

const RANGE_OPTIONS: Array<{ label: string; value: DateRangeDays }> = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];
const DEFAULT_COUNTRY_LABELS = [
  "India",
  "US",
  "Canada",
  "Germany",
  "Japan",
  "Unknown",
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

function normalizeCountryLabel(country: string): string {
  const value = country.trim().toLowerCase();

  if (
    value === "" ||
    value === "unknown" ||
    value === "localhost" ||
    value === "local" ||
    value === "127.0.0.1" ||
    value === "::1"
  ) {
    return "Unknown";
  }

  return country.trim();
}

function createFallbackGrowthPoint(date: Date): GrowthPoint {
  return {
    date: date.toISOString(),
    views: 0,
    uniqueViewers: 0,
    watchTimeSeconds: 0,
    watchTimeHours: 0,
  };
}

function createFallbackGrowthTimeline(rangeDays: DateRangeDays): GrowthPoint[] {
  const endDate = new Date();
  const pointCount = Math.min(7, rangeDays);
  const step = Math.max(1, Math.floor((rangeDays - 1) / Math.max(pointCount - 1, 1)));

  return Array.from({ length: pointCount }, (_, index) => {
    const daysBack = Math.max(rangeDays - 1 - index * step, 0);
    return createFallbackGrowthPoint(subDays(endDate, daysBack));
  });
}

export default function AnalyticsPage() {
  const [rangeDays, setRangeDays] = React.useState<DateRangeDays>(30);
  const [hero, setHero] = React.useState<HeroStats | null>(null);
  const [growth, setGrowth] = React.useState<GrowthPoint[]>([]);
  const [countries, setCountries] = React.useState<
    DemographicsResponse["countries"]
  >([]);
  const [devices, setDevices] = React.useState<DemographicsResponse["devices"]>(
    []
  );
  const [topVideos, setTopVideos] = React.useState<TopVideo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchAnalytics = React.useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [heroRes, growthRes, demographicsRes, topVideosRes] =
        await Promise.all([
          fetch(
            `${API_URL}/analytics-stats/organization/hero-stats?days=${rangeDays}`,
            {
              credentials: "include",
            }
          ),
          fetch(
            `${API_URL}/analytics-stats/organization/growth?days=${rangeDays}`,
            {
              credentials: "include",
            }
          ),
          fetch(
            `${API_URL}/analytics-stats/organization/demographics?days=${rangeDays}`,
            {
              credentials: "include",
            }
          ),
          fetch(
            `${API_URL}/analytics-stats/organization/top-videos?limit=8&days=${rangeDays}`,
            {
              credentials: "include",
            }
          ),
        ]);

      if (
        !heroRes.ok ||
        !growthRes.ok ||
        !demographicsRes.ok ||
        !topVideosRes.ok
      ) {
        throw new Error("Failed to fetch organization analytics");
      }

      const [heroData, growthData, demographicsData, topVideosData] =
        await Promise.all([
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
      setError(
        err instanceof Error ? err.message : "Failed to fetch analytics"
      );
    } finally {
      setLoading(false);
    }
  }, [rangeDays]);

  React.useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const growthChartData = React.useMemo(() => {
    if (growth.length === 0) {
      return createFallbackGrowthTimeline(rangeDays).map((point) => ({
        ...point,
        label: safeDateLabel(point.date),
      }));
    }

    if (growth.length === 1) {
      const [singlePoint] = growth;
      const fallbackTimeline = createFallbackGrowthTimeline(rangeDays);
      const mergedTimeline = [...fallbackTimeline.slice(0, -1), singlePoint];

      return mergedTimeline.map((point) => ({
          ...point,
          label: safeDateLabel(point.date),
      }));
    }

    return growth.map((point) => ({
      ...point,
      label: safeDateLabel(point.date),
    }));
  }, [growth, rangeDays]);
  const normalizedCountries = Array.from(
    countries
      .reduce((map, item) => {
        const country = normalizeCountryLabel(item.country);
        const existing = map.get(country);

        map.set(country, {
          country,
          viewers: (existing?.viewers ?? 0) + item.viewers,
          sessions: (existing?.sessions ?? 0) + item.sessions,
        });

        return map;
      }, new Map<string, { country: string; viewers: number; sessions: number }>())
      .values()
  ).sort((a, b) => b.viewers - a.viewers);

  const topCountries = normalizedCountries
    .filter((item) => item.country !== "Unknown")
    .slice(0, 5);
  const countryRows: CountryChartRow[] = DEFAULT_COUNTRY_LABELS.map(
    (country) => {
      const existing =
        country === "Unknown"
          ? normalizedCountries.find((item) => item.country === "Unknown")
          : topCountries.find((item) => item.country === country);
      const viewers = existing?.viewers ?? 0;

      return {
        country,
        viewers,
        sessions: existing?.sessions ?? 0,
        fill: viewers > 0 ? "hsl(var(--accent))" : "hsl(var(--accent) / 0.1)",
      };
    }
  );
  const maxCountryViewers = Math.max(
    ...countryRows.map((item) => item.viewers),
    1
  );
  const desktopViewers = devices.reduce((sum, device) => {
    const label = device.device.toLowerCase();
    return label.includes("desktop") ? sum + device.viewers : sum;
  }, 0);
  const mobileViewers = devices.reduce((sum, device) => {
    const label = device.device.toLowerCase();
    return label.includes("mobile") ||
      label.includes("phone") ||
      label.includes("tablet")
      ? sum + device.viewers
      : sum;
  }, 0);
  const deviceChartData = [
    {
      month: "current",
      desktop: desktopViewers,
      mobile: mobileViewers,
    },
  ];
  const totalDeviceViewers = desktopViewers + mobileViewers;
  const sortedTopVideos = [...topVideos]
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);
  const topVideoPeakViews = sortedTopVideos[0]?.views ?? 0;

  const devicesChartConfig = {
    viewers: {
      label: "Viewers",
    },
    desktop: {
      label: "Desktop",
      color: "hsl(var(--accent))",
    },
    mobile: {
      label: "Mobile",
      color: "hsl(var(--accent) / 0.7)",
    },
  } satisfies ChartConfig;

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
    <div className="space-y-8 w-full">
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
            <p className="text-sm font-semibold text-muted-foreground">
              Total Views
            </p>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <PlayCircle className="size-4.5 text-purple-300" />
            </div>
          </div>
          <p className="mt-3 text-3xl font-semibold text-foreground">
            {formatCompact(hero?.totalViews || 0)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Sessions across all videos
          </p>
        </div>

        <div className="rounded-sm border border-border bg-card/60 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-muted-foreground">
              Watch Time
            </p>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <BarChart3 className="size-4.5 text-cyan-400" />
            </div>
          </div>
          <p className="mt-3 text-3xl font-semibold text-foreground">
            {formatHours(hero?.watchTimeHours || 0)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Total hours consumed
          </p>
        </div>

        <div className="rounded-sm border border-border bg-card/60 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-muted-foreground">
              Unique Viewers
            </p>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <Users className="size-4.5 text-lime-500" />
            </div>
          </div>
          <p className="mt-3 text-3xl font-semibold text-foreground">
            {formatCompact(hero?.uniqueViewers || 0)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Distinct users and sessions
          </p>
        </div>

        <div className="rounded-sm border border-border bg-card/60 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-muted-foreground">
              Error Rate
            </p>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <AlertTriangle className="size-4.5 text-amber-400" />
            </div>
          </div>
          <p className="mt-3 text-3xl font-semibold text-foreground">
            {(hero?.errorRatePercent || 0).toFixed(2)}%
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Playback quality signal
          </p>
        </div>
      </div>

      <div className="rounded-sm border border-border bg-card/60 p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-foreground">
            Views Over Time
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Daily growth trend for the last {rangeDays} days.
          </p>
        </div>

        <div className="relative h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={growthChartData} margin={{ left: 8, right: 8 }}>
              <defs>
                <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="hsl(var(--primary))"
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="95%"
                    stopColor="hsl(var(--primary))"
                    stopOpacity={0.03}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeOpacity={0.8}
                strokeDasharray="4 4"
              />
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
                formatter={(value, name) => {
                  const rawValue = Array.isArray(value) ? value[0] : value;
                  const safeValue =
                    typeof rawValue === "number"
                      ? rawValue
                      : Number(rawValue ?? 0);
                  const safeName = String(name ?? "value");
                  if (safeName === "views")
                    return [safeValue.toLocaleString(), "Views"];
                  if (safeName === "uniqueViewers")
                    return [safeValue.toLocaleString(), "Unique Viewers"];
                  return [safeValue.toLocaleString(), safeName];
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
          {growth.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-2 text-sm text-muted-foreground">
              No analytics events yet for this range.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="rounded-sm border border-border bg-card/60 p-5 xl:min-h-[24rem]">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground">Top Countries</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                Where your audience watches
              </p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <Globe className="size-4.5 text-purple-300" />
            </div>
          </div>
          {countryRows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No country data yet
            </p>
          ) : (
            <div className="space-y-6 pt-2">
              {countryRows.map((country) => {
                const width = `${Math.max(
                  (country.viewers / maxCountryViewers) * 100,
                  0
                )}%`;

                return (
                  <div
                    key={country.country}
                    className="grid grid-cols-[72px_minmax(0,1fr)_56px] items-center gap-4"
                  >
                    <p className="text-xs font-medium text-foreground/80">
                      {country.country}
                    </p>
                    <div className="h-6 overflow-hidden rounded-xs bg-accent/10">
                      <div
                        className="h-full rounded-xs"
                        style={{
                          width,
                          minWidth: country.viewers > 0 ? "0.75rem" : "0",
                          backgroundColor: country.fill,
                        }}
                      />
                    </div>
                    <p className="text-right text-sm text-foreground/80">
                      {formatCompact(country.viewers)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-sm border border-border bg-card/60 p-5 xl:min-h-[25rem]">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground">Device Types</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                Desktop vs mobile split
              </p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <MonitorSmartphone className="size-4.5 text-cyan-500" />
            </div>
          </div>

          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No device data yet
            </p>
          ) : (
            <div className="space-y-5">
              <div className="h-[250px]">
                <ChartContainer
                  config={devicesChartConfig}
                  className="mx-auto h-full w-full max-w-[210px] aspect-square"
                >
                  <RadialBarChart
                    accessibilityLayer
                    data={deviceChartData}
                    endAngle={180}
                    innerRadius={80}
                    outerRadius={130}
                  >
                    <ChartTooltip
                      cursor={false}
                      content={<ChartTooltipContent hideLabel />}
                    />
                    <PolarRadiusAxis
                      tick={false}
                      tickLine={false}
                      axisLine={false}
                    >
                      <Label
                        content={({ viewBox }) => {
                          if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                            return (
                              <text
                                x={viewBox.cx}
                                y={viewBox.cy}
                                textAnchor="middle"
                              >
                                <tspan
                                  x={viewBox.cx}
                                  y={(viewBox.cy || 0) - 16}
                                  className="fill-foreground text-2xl font-bold"
                                >
                                  {formatCompact(totalDeviceViewers)}
                                </tspan>
                                <tspan
                                  x={viewBox.cx}
                                  y={(viewBox.cy || 0) + 4}
                                  className="fill-muted-foreground"
                                >
                                  Views
                                </tspan>
                              </text>
                            );
                          }

                          return null;
                        }}
                      />
                    </PolarRadiusAxis>
                    <RadialBar
                      dataKey="desktop"
                      stackId="a"
                      cornerRadius={4}
                      fill={
                        desktopViewers > 0
                          ? "var(--color-desktop)"
                          : "hsl(var(--accent) / 0.1)"
                      }
                      className="stroke-transparent stroke-2"
                    />
                    <RadialBar
                      dataKey="mobile"
                      stackId="a"
                      cornerRadius={5}
                      fill={
                        mobileViewers > 0
                          ? "var(--color-mobile)"
                          : "hsl(var(--primary) / 0.1)"
                      }
                      className="stroke-transparent stroke-2"
                    />
                  </RadialBarChart>
                </ChartContainer>
              </div>
              <div className="flex -mt-4 items-center justify-center gap-6 md:gap-10 text-sm">
                <div className="flex items-center gap-2 text-foreground">
                  <span className="h-2.5 w-2.5 rounded-full bg-accent" />
                  <span>Desktop</span>
                  <span className="text-muted-foreground">
                    {formatCompact(desktopViewers)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-foreground">
                  <span className="h-2.5 w-2.5 rounded-full bg-primary" />
                  <span>Mobile</span>
                  <span className="text-muted-foreground">
                    {formatCompact(mobileViewers)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-sm border border-border bg-card/60 p-5 xl:min-h-[25rem]">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground">Top Videos</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                Highest view count content
              </p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent/10">
              <Clapperboard className="size-4.5 text-lime-500" />
            </div>
          </div>

          {sortedTopVideos.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No videos ranked yet
            </p>
          ) : (
            <div className="space-y-3">
              {sortedTopVideos.map((video) => {
                const share =
                  topVideoPeakViews > 0
                    ? (video.views / topVideoPeakViews) * 100
                    : 0;
                return (
                  <div
                    key={video.videoId}
                    className="rounded-sm border border-border/60 bg-background/30 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {video.title}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-base font-semibold text-foreground">
                          {formatCompact(video.views)} views
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted/70">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-lime-300/65 to-cyan-300/65"
                        style={{ width: `${Math.max(share, 6)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
