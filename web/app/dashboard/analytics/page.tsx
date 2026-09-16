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
  CartesianGrid,
  ComposedChart,
  Label,
  Line,
  PolarRadiusAxis,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardAnalyticsSkeleton } from "@/components/dashboard/page-skeletons";
import { PlaybackAnalyticsNotice } from "@/components/dashboard/playback-analytics-notice";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { API_BASE_URL } from "@/lib/api-base";

const API_URL = API_BASE_URL;

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
};

type GrowthChartPoint = GrowthPoint & { label: string };

const RANGE_OPTIONS: Array<{ label: string; value: DateRangeDays }> = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const countNumber = new Intl.NumberFormat("en-US");

function formatCompact(value: number): string {
  return compactNumber.format(value || 0);
}

function formatCount(value: number): string {
  return countNumber.format(value || 0);
}

/** Coerce a recharts value (number, string or tuple) to a finite number. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (Array.isArray(value)) return toNumber(value[0] as unknown);
  return 0;
}

/** Split watch time into a numeral and an explicit unit. */
function formatWatchTime(hours: number): { value: string; unit: string } {
  if (!Number.isFinite(hours) || hours <= 0) {
    return { value: "0", unit: "minutes" };
  }
  if (hours < 1) {
    return { value: String(Math.round(hours * 60)), unit: "minutes" };
  }
  return {
    value: hours >= 10 ? hours.toFixed(0) : hours.toFixed(1),
    unit: "hours",
  };
}

/** The same value and unit as a single inline label. */
function formatWatchTimeLabel(hours: number): string {
  const watchTime = formatWatchTime(hours);
  return `${watchTime.value} ${watchTime.unit}`;
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

const growthChartConfig = {
  views: {
    label: "Views",
    color: "var(--chart-1)",
  },
  uniqueViewers: {
    label: "Unique viewers",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const devicesChartConfig = {
  desktop: {
    label: "Desktop",
    color: "var(--chart-2)",
  },
  mobile: {
    label: "Mobile",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

/** One tooltip row: series name on the left, numbered value with unit right. */
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

function StatPanel({
  label,
  icon,
  value,
  unit,
  footnote,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  unit: string;
  footnote: string;
}) {
  return (
    <div className="dash-panel flex flex-col gap-4 p-5 md:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="dash-label">{label}</span>
        <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
          {icon}
        </span>
      </div>
      <p className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          {value}
        </span>
        <span className="text-sm text-muted-foreground">{unit}</span>
      </p>
      <p className="dash-meta">{footnote}</p>
    </div>
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

  // Only real timeline points are plotted — no synthetic zero-filled days.
  const growthChartData: GrowthChartPoint[] = React.useMemo(
    () =>
      growth.map((point) => ({
        ...point,
        label: safeDateLabel(point.date),
      })),
    [growth]
  );
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

  const countryRows: CountryChartRow[] = normalizedCountries
    .filter((item) => item.viewers > 0)
    .slice(0, 5);
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
  const desktopShare =
    totalDeviceViewers > 0
      ? Math.round((desktopViewers / totalDeviceViewers) * 100)
      : 0;
  const mobileShare =
    totalDeviceViewers > 0
      ? Math.round((mobileViewers / totalDeviceViewers) * 100)
      : 0;
  const sortedTopVideos = [...topVideos]
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);
  const topVideoPeakViews = sortedTopVideos[0]?.views ?? 0;

  const watchTime = formatWatchTime(hero?.watchTimeHours || 0);
  const isGrowthChartEmpty = growthChartData.length === 0;
  const hasCountryData = countryRows.length > 0;
  const hasDeviceData = devices.length > 0;
  const hasTopVideos = sortedTopVideos.length > 0;

  if (loading) {
    return <DashboardAnalyticsSkeleton />;
  }

  if (error) {
    return (
      <div className="w-full space-y-8">
        <DashboardPageHeader
          title="Analytics"
          description={`Views, watch time and audience breakdown for the last ${rangeDays} days.`}
        />
        <div
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-failed/35 bg-failed/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="flex items-start gap-2 text-sm text-danger">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {error}
          </p>
          <Button onClick={fetchAnalytics} variant="outline" size="sm">
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
        title="Analytics"
        description={`Views, watch time and audience breakdown for the last ${rangeDays} days.`}
        actions={
          <div
            role="group"
            aria-label="Analytics period"
            className="flex w-full gap-1 rounded-xl border border-border bg-panel p-1 sm:w-auto"
          >
            {RANGE_OPTIONS.map((option) => {
              const isActive = rangeDays === option.value;

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRangeDays(option.value)}
                  aria-pressed={isActive}
                  className={cn(
                    "inline-flex h-11 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors sm:flex-none",
                    isActive
                      ? "bg-brand text-brand-foreground"
                      : "text-muted-foreground hover:bg-panel-strong hover:text-foreground"
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        }
      />

      <PlaybackAnalyticsNotice />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatPanel
          label="Total views"
          icon={<PlayCircle className="size-4.5" aria-hidden="true" />}
          value={formatCount(hero?.totalViews || 0)}
          unit="views"
          footnote={`Playback sessions recorded in the last ${rangeDays} days.`}
        />
        <StatPanel
          label="Watch time"
          icon={<BarChart3 className="size-4.5" aria-hidden="true" />}
          value={watchTime.value}
          unit={watchTime.unit}
          footnote={`Total playback time in the last ${rangeDays} days.`}
        />
        <StatPanel
          label="Unique viewers"
          icon={<Users className="size-4.5" aria-hidden="true" />}
          value={formatCount(hero?.uniqueViewers || 0)}
          unit="viewers"
          footnote={`Distinct viewers seen in the last ${rangeDays} days.`}
        />
        <StatPanel
          label="Playback error rate"
          icon={<AlertTriangle className="size-4.5" aria-hidden="true" />}
          value={(hero?.errorRatePercent || 0).toFixed(2)}
          unit="% of events"
          footnote={`Share of playback events that failed in the last ${rangeDays} days.`}
        />
      </div>

      <section className="dash-panel p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="dash-section-title text-foreground">
              Views over time
            </h2>
            <p className="dash-meta mt-1.5">
              Daily view counts and unique viewers for the last {rangeDays}{" "}
              days.
            </p>
          </div>
        </div>

        <div className="mt-6">
          {isGrowthChartEmpty ? (
            <EmptyState
              className="h-80 sm:h-96"
              icon={<BarChart3 className="size-5" aria-hidden="true" />}
              title="No views recorded yet"
              description="Views and unique viewers appear here once your videos are played. Publish a video and open its playback link to start collecting events."
            />
          ) : (
            <ChartContainer
              config={growthChartConfig}
              className="h-80 w-full sm:h-96"
            >
              <ComposedChart
                accessibilityLayer
                data={growthChartData}
                margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
              >
                <defs>
                  <linearGradient
                    id="analyticsViewsFill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="5%"
                      stopColor="var(--chart-1)"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="95%"
                      stopColor="var(--chart-1)"
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="var(--border-soft)"
                  strokeDasharray="4 4"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tickMargin={10}
                  tick={{ fontSize: 13, fill: "var(--muted-foreground)" }}
                />
                <YAxis
                  allowDecimals={false}
                  width={56}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tick={{ fontSize: 13, fill: "var(--muted-foreground)" }}
                  tickFormatter={(value: number) => formatCompact(value)}
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
                  content={
                    <ChartTooltipContent
                      className="text-[13px]"
                      labelFormatter={(label, payload) => {
                        const first = payload?.[0] as
                          | { payload?: { date?: unknown } }
                          | undefined;
                        const rawDate = first?.payload?.date;

                        return typeof rawDate === "string"
                          ? safeLongDateLabel(rawDate)
                          : String(label);
                      }}
                      formatter={(value, name) => {
                        const isUniqueViewers =
                          String(name) === "uniqueViewers";

                        return (
                          <TooltipRow
                            label={
                              isUniqueViewers ? "Unique viewers" : "Views"
                            }
                            value={`${formatCount(toNumber(value))} ${
                              isUniqueViewers ? "viewers" : "views"
                            }`}
                          />
                        );
                      }}
                    />
                  }
                />
                <Area
                  type="monotone"
                  dataKey="views"
                  stroke="var(--chart-1)"
                  strokeWidth={2.5}
                  fill="url(#analyticsViewsFill)"
                  dot={
                    growthChartData.length <= 2
                      ? { r: 4, fill: "var(--chart-1)", strokeWidth: 0 }
                      : false
                  }
                  activeDot={{ r: 5, strokeWidth: 0 }}
                />
                <Line
                  type="monotone"
                  dataKey="uniqueViewers"
                  stroke="var(--chart-2)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, strokeWidth: 0 }}
                />
                <ChartLegend
                  content={<ChartLegendContent className="text-[13px]" />}
                />
              </ComposedChart>
            </ChartContainer>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="dash-panel p-5 md:p-6 xl:min-h-[24rem]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="dash-section-title text-foreground">
                Top countries
              </h3>
              <p className="dash-meta mt-1.5">
                Viewers by country, last {rangeDays} days.
              </p>
            </div>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
              <Globe className="size-4.5" aria-hidden="true" />
            </span>
          </div>

          {hasCountryData ? (
            <ul className="mt-6 space-y-5">
              {countryRows.map((country) => {
                const width = `${Math.max(
                  (country.viewers / maxCountryViewers) * 100,
                  0
                )}%`;

                return (
                  <li
                    key={country.country}
                    className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {country.country}
                      </p>
                      <p className="dash-meta truncate">
                        {formatCount(country.sessions)} sessions
                      </p>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-panel-strong">
                      <div
                        className="h-full rounded-full bg-chart-2"
                        style={{
                          width,
                          minWidth: country.viewers > 0 ? "0.75rem" : "0",
                        }}
                      />
                    </div>
                    <p className="text-right">
                      <span className="font-mono text-sm font-medium tabular-nums text-foreground">
                        {formatCount(country.viewers)}
                      </span>
                      <span className="ml-1.5 text-[13px] text-muted-foreground">
                        viewers
                      </span>
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              className="mt-6 py-12"
              icon={<Globe className="size-5" aria-hidden="true" />}
              title="No country data yet"
              description="Country comes from the viewer's request. It appears here after the first playback event from a public network."
            />
          )}
        </section>

        <section className="dash-panel p-5 md:p-6 xl:min-h-[24rem]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="dash-section-title text-foreground">
                Device types
              </h3>
              <p className="dash-meta mt-1.5">
                Desktop and mobile viewers, last {rangeDays} days.
              </p>
            </div>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
              <MonitorSmartphone className="size-4.5" aria-hidden="true" />
            </span>
          </div>

          {hasDeviceData ? (
            <div className="mt-4">
              <ChartContainer
                config={devicesChartConfig}
                className="mx-auto h-[260px] w-full max-w-[230px]"
              >
                <RadialBarChart
                  accessibilityLayer
                  data={deviceChartData}
                  endAngle={180}
                  innerRadius="58%"
                  outerRadius="96%"
                >
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        className="text-[13px]"
                        hideLabel
                        formatter={(value, name) => {
                          const isDesktop = String(name) === "desktop";

                          return (
                            <TooltipRow
                              label={isDesktop ? "Desktop" : "Mobile"}
                              value={`${formatCount(toNumber(value))} viewers`}
                            />
                          );
                        }}
                      />
                    }
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
                                y={(viewBox.cy || 0) - 14}
                                className="fill-foreground font-mono text-2xl font-semibold"
                              >
                                {formatCount(totalDeviceViewers)}
                              </tspan>
                              <tspan
                                x={viewBox.cx}
                                y={(viewBox.cy || 0) + 8}
                                className="fill-muted-foreground text-[13px]"
                              >
                                viewers
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
                        : "var(--panel-strong)"
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
                        : "var(--panel-strong)"
                    }
                    className="stroke-transparent stroke-2"
                  />
                </RadialBarChart>
              </ChartContainer>
              <ul className="-mt-24 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px]">
                <li className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full bg-chart-2"
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">Desktop</span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {formatCount(desktopViewers)}
                  </span>
                  <span className="text-faint-foreground">
                    ({desktopShare}%)
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full bg-chart-1"
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">Mobile</span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {formatCount(mobileViewers)}
                  </span>
                  <span className="text-muted-foreground">({mobileShare}%)</span>
                </li>
              </ul>
            </div>
          ) : (
            <EmptyState
              className="mt-6 py-12"
              icon={<MonitorSmartphone className="size-5" aria-hidden="true" />}
              title="No device data yet"
              description="Device type arrives with the first playback event, split into desktop and mobile viewers."
            />
          )}
        </section>

        <section className="dash-panel p-5 md:p-6 xl:min-h-[24rem]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="dash-section-title text-foreground">
                Top videos
              </h3>
              <p className="dash-meta mt-1.5">
                Most viewed assets, last {rangeDays} days.
              </p>
            </div>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-strong text-muted-foreground">
              <Clapperboard className="size-4.5" aria-hidden="true" />
            </span>
          </div>

          {hasTopVideos ? (
            <div className="mt-6">
              <ul className="space-y-3">
                {sortedTopVideos.map((video) => {
                  const share =
                    topVideoPeakViews > 0
                      ? (video.views / topVideoPeakViews) * 100
                      : 0;

                  return (
                    <li
                      key={video.videoId}
                      className="rounded-xl border border-border-soft bg-panel-quiet p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <p className="min-w-0 break-words text-[15px] font-semibold text-foreground">
                          {video.title}
                        </p>
                        <p className="shrink-0 text-right">
                          <span className="font-mono text-[15px] font-semibold tabular-nums text-foreground">
                            {formatCount(video.views)}
                          </span>
                          <span className="ml-1.5 text-[13px] text-muted-foreground">
                            views
                          </span>
                        </p>
                      </div>
                      <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
                        <div className="flex items-center gap-1.5">
                          <dt className="text-muted-foreground">
                            Unique viewers
                          </dt>
                          <dd className="font-mono font-medium tabular-nums text-foreground">
                            {formatCount(video.uniqueViewers)}
                          </dd>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <dt className="text-muted-foreground">Watch time</dt>
                          <dd className="font-mono font-medium tabular-nums text-foreground">
                            {formatWatchTimeLabel(video.totalWatchHours)}
                          </dd>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <dt className="text-muted-foreground">Error rate</dt>
                          <dd className="font-mono font-medium tabular-nums text-foreground">
                            {(video.errorRatePercent || 0).toFixed(2)}%
                          </dd>
                        </div>
                      </dl>
                      <Progress
                        className="mt-4"
                        value={share}
                        aria-hidden="true"
                      />
                    </li>
                  );
                })}
              </ul>
              <p className="dash-meta mt-4">
                Bars show each video&apos;s views relative to the most viewed
                asset in this period.
              </p>
            </div>
          ) : (
            <EmptyState
              className="mt-6 py-12"
              icon={<Clapperboard className="size-5" aria-hidden="true" />}
              title="No ranked videos yet"
              description="Videos are ranked by views. Once an asset has been played in this period it appears here."
            />
          )}
        </section>
      </div>
    </div>
  );
}
