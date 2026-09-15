"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Copy,
  Check,
  Play,
  Lock,
  Globe,
  Loader2,
  Trash2,
  BarChart3,
  Code,
  Settings,
  ExternalLink,
  AlertTriangle,
  Download,
  Link2,
  HardDrive,
  Pencil,
  Clock,
  Calendar,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { ClipMuxPlayer } from "@clipmux/player";
import {
  DashboardSectionSkeleton,
  DashboardVideoDetailSkeleton,
} from "@/components/dashboard/page-skeletons";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";

interface VideoDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

interface VideoDetail {
  id: string;
  title: string;
  status: "ready" | "processing" | "error" | "uploading" | "pending" | "failed";
  playbackPolicy?: "public" | "signed";
  thumbnailUrl?: string;
  duration?: number;
  createdAt: Date | string;
  playbackUrl?: string | null;
  token?: string | null;
  subtitleUrl?: string | null;
  chapters?: Array<{
    startTime: number;
    endTime: number;
    title: string;
  }> | null;
  chaptersStatus?: string | null;
  resolutions?: string;
  fileSize?: number;
}

interface VideoContentScore {
  totalSessions: number;
  uniqueViewers: number;
  avgWatchSeconds: number;
  completionRate: number;
  completionRatePercent: number;
  completionRateAvailable?: boolean;
  peakConcurrents: number;
  peakConcurrentsAvailable?: boolean;
  durationSeconds: number;
}

interface VideoRetentionCurve {
  totalSessions: number;
  curve: Array<{
    progressPercent: number;
    viewersPercent: number;
    viewers: number;
  }>;
  comingSoon?: boolean;
  message?: string;
}

interface VideoTechHealth {
  totalSessions: number;
  totalEvents: number;
  totalErrors: number;
  sessionsWithErrors: number;
  errorEventRate: number;
  errorEventRatePercent: number;
  sessionErrorRate: number;
  sessionErrorRatePercent: number;
  seekEvents: number;
  sessionsWithSeek: number;
  bufferingSessionRate: number;
  bufferingSessionRatePercent: number;
  topErrors: Array<{
    code: string;
    count: number;
  }>;
}

interface VideoAnalyticsData {
  contentScore: VideoContentScore;
  retention: VideoRetentionCurve;
  techHealth: VideoTechHealth;
}

const STATUS_BADGE = {
  ready: { label: "Ready", variant: "ready" as const, dot: "status-ready" },
  processing: {
    label: "Processing",
    variant: "processing" as const,
    dot: "status-processing",
  },
  uploading: {
    label: "Uploading",
    variant: "uploading" as const,
    dot: "status-uploading",
  },
  pending: { label: "Pending", variant: "neutral" as const, dot: "status-idle" },
  error: { label: "Failed", variant: "failed" as const, dot: "status-failed" },
  failed: { label: "Failed", variant: "failed" as const, dot: "status-failed" },
};

/** A labelled panel used for every metadata group on this screen. */
function DetailSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("dash-panel p-5 md:p-6", className)}>
      <h2 className="dash-section-title text-foreground">{title}</h2>
      {description ? (
        <p className="dash-meta mt-1.5 max-w-prose">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A read-only mono value with its own copy control. */
function CopyableValue({
  label,
  value,
  copied,
  onCopy,
  copyKey,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  copyKey: string;
}) {
  return (
    <div>
      <p className="dash-label">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-[13px] text-foreground md:text-sm">
          {value}
        </code>
        <button
          type="button"
          onClick={() => onCopy(value, copyKey)}
          aria-label={copied === copyKey ? `${label} copied` : `Copy ${label}`}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-panel-strong hover:text-foreground"
        >
          {copied === copyKey ? (
            <Check className="size-4 text-ready" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

export default function VideoDetailPage({ params }: VideoDetailPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [videoId, setVideoId] = React.useState<string>("");
  const [video, setVideo] = React.useState<VideoDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [activeTab, setActiveTab] = React.useState(() => {
    const tab = searchParams.get("tab");
    return tab === "embed" || tab === "settings" ? tab : "analytics";
  });
  const [copied, setCopied] = React.useState<string | null>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState("");
  const [editPolicy, setEditPolicy] = React.useState<"public" | "signed">(
    "public",
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [analytics, setAnalytics] = React.useState<VideoAnalyticsData | null>(
    null,
  );
  const [analyticsLoading, setAnalyticsLoading] = React.useState(false);
  const [embedAutoplay, setEmbedAutoplay] = React.useState(false);
  const [embedMuted, setEmbedMuted] = React.useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  // Unwrap params
  React.useEffect(() => {
    params.then((p) => setVideoId(p.id));
  }, [params]);

  // Fetch video details
  React.useEffect(() => {
    if (!videoId) return;

    const fetchDetail = async () => {
      try {
        const res = await fetch(`${API_URL}/video/${videoId}`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to fetch video details");
        const data = await res.json();
        setVideo(data);
        setEditTitle(data.title);
        setEditPolicy(data.playbackPolicy || "public");
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetail();
  }, [videoId]);

  // Fetch analytics when tab is active
  React.useEffect(() => {
    if (!videoId || activeTab !== "analytics") return;

    const fetchAnalytics = async () => {
      setAnalyticsLoading(true);
      try {
        const [contentScoreRes, retentionRes, techHealthRes] =
          await Promise.all([
            fetch(
              `${API_URL}/analytics-stats/video/content-score?videoId=${videoId}`,
              {
                credentials: "include",
              },
            ),
            fetch(
              `${API_URL}/analytics-stats/video/retention-curve?videoId=${videoId}`,
              {
                credentials: "include",
              },
            ),
            fetch(
              `${API_URL}/analytics-stats/video/tech-health?videoId=${videoId}`,
              {
                credentials: "include",
              },
            ),
          ]);

        if (!contentScoreRes.ok || !techHealthRes.ok) {
          throw new Error("Failed to fetch video analytics");
        }

        const [contentScore, retention, techHealth] = await Promise.all([
          contentScoreRes.json() as Promise<VideoContentScore>,
          retentionRes.ok
            ? (retentionRes.json() as Promise<VideoRetentionCurve>)
            : Promise.resolve({
                totalSessions: 0,
                curve: [],
                comingSoon: true,
              }),
          techHealthRes.json() as Promise<VideoTechHealth>,
        ]);

        setAnalytics({
          contentScore,
          retention,
          techHealth,
        });
      } catch (err) {
        console.error("Failed to fetch analytics:", err);
        setAnalytics(null);
      } finally {
        setAnalyticsLoading(false);
      }
    };
    fetchAnalytics();
  }, [videoId, activeTab]);

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleSave = async () => {
    if (!video) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${API_URL}/video/${video.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle,
          playbackPolicy: editPolicy,
        }),
      });
      if (!res.ok) throw new Error("Failed to update video");
      setVideo((prev) =>
        prev ? { ...prev, title: editTitle, playbackPolicy: editPolicy } : null,
      );
      setIsEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update video");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!video) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`${API_URL}/video/${video.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete video");
      router.push("/dashboard");
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete video",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "—";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  const formatWatchSeconds = (seconds?: number) => {
    if (!seconds || seconds <= 0) return "0s";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  };

  const formatDate = (date?: Date | string) => {
    if (!date) return "Unknown";
    const d = typeof date === "string" ? new Date(date) : date;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return "—";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const truncateTitle = (title: string, maxLen: number = 32) => {
    if (title.length <= maxLen) return title;
    return title.slice(0, maxLen) + "…";
  };

  // The previous snippet pointed an <iframe> straight at the HLS manifest and
  // appended a second `?token=` to a URL that already carried one — no browser
  // renders a raw manifest, so the embed never played. This is the actual
  // integration: the player component, with a token your backend mints.
  const getEmbedCode = () => {
    if (!video?.playbackUrl) return "";
    return [
      'import { ClipMuxPlayer } from "@clipmux/player";',
      "",
      "<ClipMuxPlayer",
      `  playbackId="${video.id}"`,
      `  src="${video.playbackUrl}"`,
      video.playbackPolicy === "signed"
        ? "  token={playbackToken} // mint server-side, refresh before it expires"
        : null,
      '  tokenRefreshEndpoint="/api/play-token"',
      embedAutoplay ? "  autoPlay" : null,
      embedMuted ? "  muted" : null,
      "/>",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  };

  if (loading) {
    return <DashboardVideoDetailSkeleton />;
  }

  if (!video) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <AlertTriangle className="size-10 text-danger" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold text-foreground">
          Video not found
        </h1>
        <p className="dash-body mt-2 max-w-prose text-muted-foreground">
          This video does not exist in the active organization, or it was
          deleted.
        </p>
        <Button className="mt-6" onClick={() => router.push("/dashboard")}>
          Back to library
        </Button>
      </div>
    );
  }

  const status = STATUS_BADGE[video.status];
  const isSigned = video.playbackPolicy === "signed";

  return (
    <div className="w-full">
      {/* ── Header: title, status, policy, actions ─────────────────── */}
      <header className="flex flex-col gap-5">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5 text-sm">
            <li>
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                Library
              </button>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="size-4 text-faint-foreground" />
            </li>
            <li className="truncate font-medium text-foreground">
              {truncateTitle(video.title, 48)}
            </li>
          </ol>
        </nav>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-8">
          <div className="min-w-0 max-w-3xl">
            {isEditing ? (
              <>
                <label htmlFor="video-title" className="dash-label">
                  Title
                </label>
                <Input
                  id="video-title"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="mt-2 text-lg font-semibold"
                  placeholder="Video title"
                  autoFocus
                />
              </>
            ) : (
              <h1 className="dash-title text-foreground">{video.title}</h1>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant={status.variant}>
                <span
                  className={cn("dash-dot", status.dot)}
                  aria-hidden="true"
                />
                {status.label}
              </Badge>
              <Badge variant="neutral">
                {isSigned ? (
                  <Lock className="size-3.5" aria-hidden="true" />
                ) : (
                  <Globe className="size-3.5" aria-hidden="true" />
                )}
                {isSigned ? "Signed playback" : "Public playback"}
              </Badge>
              {video.resolutions ? (
                <Badge variant="neutral">{video.resolutions}</Badge>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isEditing ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsEditing(false);
                    setEditTitle(video.title);
                    setEditPolicy(video.playbackPolicy || "public");
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                      Saving…
                    </>
                  ) : (
                    <>
                      <Check className="size-4" aria-hidden="true" />
                      Save changes
                    </>
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setIsEditing(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  Edit details
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeleteError(null);
                    setShowDeleteConfirm(true);
                  }}
                  className="border-failed/40 text-danger hover:border-failed/60"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Playback: the primary visual ───────────────────────────── */}
      <div className="mt-8">
        <div className="overflow-hidden rounded-2xl border border-border bg-black">
          {video.status === "ready" && video.playbackUrl ? (
            <ClipMuxPlayer
              playbackId={video.id}
              src={video.playbackUrl}
              token={video.token || undefined}
              // The dashboard's own session-authenticated refresher. Signed
              // tokens last an hour; a lesson is usually watched for longer.
              tokenRefreshEndpoint={
                video.playbackPolicy === "signed"
                  ? `${API_URL}/video/${video.id}/token`
                  : undefined
              }
              title={video.title}
              subtitles={video.subtitleUrl || undefined}
              chapters={video.chapters || undefined}
              // Analytics are opt-in in @clipmux/player; the dashboard opts in.
              analyticsEndpoint={`${API_URL}/playback/journal`}
            />
          ) : (
            <div className="flex aspect-video flex-col items-center justify-center gap-3 bg-panel-quiet text-muted-foreground">
              {video.status === "ready" ? (
                <>
                  <AlertTriangle
                    className="size-8 text-processing"
                    aria-hidden="true"
                  />
                  <p className="text-[15px] font-medium text-foreground">
                    No playback URL on this asset
                  </p>
                  <p className="dash-meta max-w-prose px-6 text-center">
                    The video finished processing but has no stream attached.
                    Re-run the transcode from the API, or check the delivery
                    Worker configuration.
                  </p>
                </>
              ) : video.status === "processing" || video.status === "uploading" ? (
                <>
                  <Loader2
                    className="size-8 animate-spin text-processing"
                    aria-hidden="true"
                  />
                  <p className="text-[15px] font-medium text-foreground">
                    {video.status === "uploading"
                      ? "Upload in progress"
                      : "Transcoding in progress"}
                  </p>
                  <p className="dash-meta">
                    Playback appears here as soon as the renditions are ready.
                  </p>
                </>
              ) : video.status === "error" || video.status === "failed" ? (
                <>
                  <AlertTriangle
                    className="size-8 text-failed"
                    aria-hidden="true"
                  />
                  <p className="text-[15px] font-medium text-foreground">
                    Transcoding failed
                  </p>
                  <p className="dash-meta">
                    Check the transcoder logs or retry the job from the API.
                  </p>
                </>
              ) : (
                <>
                  <Play className="size-8" aria-hidden="true" />
                  <p className="text-[15px] font-medium text-foreground">
                    Waiting to process
                  </p>
                  <p className="dash-meta">
                    This asset has not been picked up by a transcoder yet.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Readable metadata sections ─────────────────────────────── */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DetailSection
          title="Asset"
          description="What this video is and when it entered the platform."
        >
          <div className="space-y-5">
            <CopyableValue
              label="Video ID"
              value={video.id}
              copied={copied}
              onCopy={handleCopy}
              copyKey="id"
            />

            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <dt className="dash-label flex items-center gap-1.5">
                  <Clock className="size-3.5" aria-hidden="true" />
                  Duration
                </dt>
                <dd className="mt-1.5 font-mono text-sm text-foreground">
                  {formatDuration(video.duration)}
                </dd>
              </div>
              <div>
                <dt className="dash-label flex items-center gap-1.5">
                  <Calendar className="size-3.5" aria-hidden="true" />
                  Added
                </dt>
                <dd className="mt-1.5 text-sm text-foreground">
                  {formatDate(video.createdAt)}
                </dd>
              </div>
              <div>
                <dt className="dash-label flex items-center gap-1.5">
                  <HardDrive className="size-3.5" aria-hidden="true" />
                  Source size
                </dt>
                <dd className="mt-1.5 font-mono text-sm text-foreground">
                  {formatFileSize(video.fileSize)}
                </dd>
              </div>
            </dl>
          </div>
        </DetailSection>

        <DetailSection
          title="Delivery"
          description="Where this video is served from, and who can request it."
        >
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-3.5">
              {isSigned ? (
                <Lock className="size-4 text-processing" aria-hidden="true" />
              ) : (
                <Globe className="size-4 text-ready" aria-hidden="true" />
              )}
              <span className="text-sm font-medium text-foreground">
                {isSigned ? "Signed playback" : "Public playback"}
              </span>
              <span className="dash-meta">
                {isSigned
                  ? "Every request needs a playback token."
                  : "Anyone with the URL can watch."}
              </span>
            </div>

            {video.playbackUrl ? (
              <CopyableValue
                label="Playback URL"
                value={video.playbackUrl}
                copied={copied}
                onCopy={handleCopy}
                copyKey="url"
              />
            ) : (
              <p className="dash-meta">
                A playback URL appears once transcoding finishes.
              </p>
            )}

            {video.thumbnailUrl ? (
              <a
                href={video.thumbnailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:border-muted-foreground/40 hover:bg-panel-strong/60"
              >
                <Download className="size-4" aria-hidden="true" />
                Download poster
              </a>
            ) : (
              <p className="dash-meta">
                A poster image is generated during transcoding.
              </p>
            )}

            {isSigned ? (
              <p className="dash-meta">
                Mint tokens with{" "}
                <code className="rounded bg-panel-strong px-1.5 py-0.5 font-mono text-[13px] text-foreground">
                  POST /v1/video/:id/playback-token
                </code>
                . Tokens expire after one hour.
              </p>
            ) : null}
          </div>
        </DetailSection>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete this video?"
        description={
          <>
            <span className="font-medium text-foreground">{video.title}</span>{" "}
            and its transcoded outputs will be removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete video"
        busyLabel="Deleting…"
        busy={isDeleting}
        error={deleteError}
        onConfirm={handleDelete}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setDeleteError(null);
        }}
      />

      {/* ── Analytics / embed / settings ───────────────────────────── */}
      <div className="mt-10">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="analytics" className="w-full">
              <BarChart3 className="size-4" aria-hidden="true" />
              Analytics
            </TabsTrigger>
            <TabsTrigger value="embed" className="w-full">
              <Code className="size-4" aria-hidden="true" />
              Embed
            </TabsTrigger>
            <TabsTrigger value="settings" className="w-full">
              <Settings className="size-4" aria-hidden="true" />
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="analytics">
            {analyticsLoading ? (
              <div className="space-y-4">
                <DashboardSectionSkeleton className="h-36" />
                <DashboardSectionSkeleton className="h-72" />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <DashboardSectionSkeleton className="h-44" />
                  <DashboardSectionSkeleton className="h-44" />
                </div>
              </div>
            ) : analytics ? (
              <div className="space-y-8">
                <section>
                  <h2 className="dash-section-title text-foreground">
                    Watch behaviour
                  </h2>
                  <p className="dash-meta mt-1.5">
                    Across{" "}
                    <span className="font-mono text-foreground">
                      {analytics.contentScore.totalSessions.toLocaleString()}
                    </span>{" "}
                    playback sessions.
                  </p>
                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="dash-panel p-5">
                      <p className="dash-label">Average watch time</p>
                      <p className="mt-2 font-mono text-2xl font-semibold text-foreground">
                        {formatWatchSeconds(
                          analytics.contentScore.avgWatchSeconds,
                        )}
                      </p>
                    </div>
                    <div className="dash-panel p-5">
                      <p className="dash-label">Completion rate</p>
                      <p className="mt-2 font-mono text-2xl font-semibold text-foreground">
                        {analytics.contentScore.completionRateAvailable === false
                          ? "—"
                          : `${analytics.contentScore.completionRatePercent.toFixed(1)}%`}
                      </p>
                      {analytics.contentScore.completionRateAvailable ===
                        false && (
                        <p className="dash-meta mt-2">
                          Requires advanced analytics.
                        </p>
                      )}
                    </div>
                    <div className="dash-panel p-5">
                      <p className="dash-label">Peak concurrents</p>
                      <p className="mt-2 font-mono text-2xl font-semibold text-foreground">
                        {analytics.contentScore.peakConcurrentsAvailable === false
                          ? "—"
                          : analytics.contentScore.peakConcurrents.toLocaleString()}
                      </p>
                      {analytics.contentScore.peakConcurrentsAvailable ===
                        false && (
                        <p className="dash-meta mt-2">
                          Requires advanced analytics.
                        </p>
                      )}
                    </div>
                  </div>
                </section>

                <section>
                  <h2 className="dash-section-title text-foreground">
                    Audience retention
                  </h2>
                  <p className="dash-meta mt-1.5">
                    Share of viewers still watching at each point of the video.
                  </p>
                  <div className="dash-panel mt-4 p-5">
                    {analytics.retention.comingSoon ? (
                      <div className="py-12 text-center">
                        <p className="dash-body text-muted-foreground">
                          Retention curves are not available yet.
                        </p>
                        {analytics.retention.message && (
                          <p className="dash-meta mt-2">
                            {analytics.retention.message}
                          </p>
                        )}
                      </div>
                    ) : analytics.retention.curve.length > 0 ? (
                      <div className="h-72">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={analytics.retention.curve}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="var(--border-soft)"
                            />
                            <XAxis
                              dataKey="progressPercent"
                              stroke="var(--muted-foreground)"
                              tick={{ fontSize: 13 }}
                              tickFormatter={(value) => `${value}%`}
                            />
                            <YAxis
                              stroke="var(--muted-foreground)"
                              tick={{ fontSize: 13 }}
                              domain={[0, 100]}
                              tickFormatter={(value) => `${value}%`}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "var(--popover)",
                                border: "1px solid var(--border)",
                                borderRadius: "12px",
                                fontSize: 14,
                                color: "var(--foreground)",
                              }}
                              formatter={(
                                value:
                                  | number
                                  | string
                                  | (number | string)[]
                                  | undefined,
                                name: string | undefined,
                              ) => {
                                const numericValue =
                                  typeof value === "number"
                                    ? value
                                    : Number(
                                        Array.isArray(value) ? value[0] : value,
                                      ) || 0;
                                const seriesName = String(name ?? "value");

                                if (seriesName === "viewersPercent")
                                  return [
                                    `${numericValue.toFixed(2)}%`,
                                    "Still watching",
                                  ];
                                if (seriesName === "viewers")
                                  return [
                                    numericValue.toLocaleString(),
                                    "Viewers",
                                  ];
                                return [numericValue, seriesName];
                              }}
                              labelFormatter={(value) => `${value}% watched`}
                            />
                            <Line
                              type="monotone"
                              dataKey="viewersPercent"
                              stroke="var(--chart-1)"
                              strokeWidth={2.5}
                              dot={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <p className="dash-body py-12 text-center text-muted-foreground">
                        No retention points recorded yet.
                      </p>
                    )}
                  </div>
                </section>

                <section>
                  <h2 className="dash-section-title text-foreground">
                    Playback health
                  </h2>
                  <p className="dash-meta mt-1.5">
                    Seek and error events reported by the player.
                  </p>
                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="dash-panel p-5 md:p-6">
                      <p className="dash-label">Seek rate</p>
                      <p className="mt-2 font-mono text-2xl font-semibold text-foreground">
                        {analytics.techHealth.bufferingSessionRatePercent.toFixed(
                          1,
                        )}
                        %
                      </p>
                      <p className="dash-meta mt-3">
                        Sessions with a seek:{" "}
                        <span className="font-mono text-foreground">
                          {analytics.techHealth.sessionsWithSeek.toLocaleString()}
                        </span>{" "}
                        of{" "}
                        <span className="font-mono text-foreground">
                          {analytics.techHealth.totalSessions.toLocaleString()}
                        </span>
                      </p>
                      <p className="dash-meta mt-1.5">
                        Seek events logged:{" "}
                        <span className="font-mono text-foreground">
                          {analytics.techHealth.seekEvents.toLocaleString()}
                        </span>
                      </p>
                    </div>
                    <div className="dash-panel p-5 md:p-6">
                      <p className="dash-label">Error rate</p>
                      <p className="mt-2 font-mono text-2xl font-semibold text-foreground">
                        {analytics.techHealth.sessionErrorRatePercent.toFixed(2)}%
                      </p>
                      <p className="dash-meta mt-3">
                        Sessions with an error:{" "}
                        <span className="font-mono text-foreground">
                          {analytics.techHealth.sessionsWithErrors.toLocaleString()}
                        </span>{" "}
                        of{" "}
                        <span className="font-mono text-foreground">
                          {analytics.techHealth.totalSessions.toLocaleString()}
                        </span>
                      </p>
                      <p className="dash-meta mt-1.5">
                        Total error events:{" "}
                        <span className="font-mono text-foreground">
                          {analytics.techHealth.totalErrors.toLocaleString()}
                        </span>
                      </p>
                    </div>
                  </div>
                </section>

                <section className="dash-panel p-5 md:p-6">
                  <h2 className="dash-section-title text-foreground">
                    Top error codes
                  </h2>
                  {analytics.techHealth.topErrors.length > 0 ? (
                    <ul className="mt-4 divide-y divide-border-soft">
                      {analytics.techHealth.topErrors.map((errorRow) => (
                        <li
                          key={errorRow.code}
                          className="flex items-center justify-between gap-4 py-3"
                        >
                          <span className="font-mono text-sm text-foreground">
                            {errorRow.code}
                          </span>
                          <span className="font-mono text-sm text-muted-foreground">
                            {errorRow.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="dash-body mt-3 text-muted-foreground">
                      No error events recorded for this video.
                    </p>
                  )}
                </section>

                {analytics.contentScore.completionRateAvailable !== false && (
                  <p className="dash-meta">
                    A session counts as complete at 95% of the video duration.
                  </p>
                )}
              </div>
            ) : (
              <div className="dash-panel px-6 py-16 text-center">
                <BarChart3
                  className="mx-auto size-7 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="dash-body mt-4 font-medium text-foreground">
                  No analytics yet
                </p>
                <p className="dash-meta mx-auto mt-2 max-w-prose">
                  Metrics appear here once viewers start watching this video
                  through the player.
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="embed">
            {video.status === "ready" && video.playbackUrl ? (
              <div className="w-full space-y-6">
                <fieldset className="flex flex-wrap gap-6">
                  <legend className="dash-label mb-2">Player options</legend>
                  <label className="flex h-11 cursor-pointer items-center gap-2.5 text-[15px] text-foreground">
                    <input
                      type="checkbox"
                      checked={embedAutoplay}
                      onChange={(e) => setEmbedAutoplay(e.target.checked)}
                      className="size-4 rounded border-border accent-[var(--brand)]"
                    />
                    Autoplay
                  </label>
                  <label className="flex h-11 cursor-pointer items-center gap-2.5 text-[15px] text-foreground">
                    <input
                      type="checkbox"
                      checked={embedMuted}
                      onChange={(e) => setEmbedMuted(e.target.checked)}
                      className="size-4 rounded border-border accent-[var(--brand)]"
                    />
                    Start muted
                  </label>
                </fieldset>

                <div className="relative">
                  <pre className="dash-code-block overflow-x-auto p-5 pr-16">
                    <code>{getEmbedCode()}</code>
                  </pre>
                  <button
                    type="button"
                    onClick={() => handleCopy(getEmbedCode(), "embed")}
                    aria-label={
                      copied === "embed" ? "Embed code copied" : "Copy embed code"
                    }
                    className="absolute top-3.5 right-3.5 inline-flex size-11 items-center justify-center rounded-lg border border-border bg-panel text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {copied === "embed" ? (
                      <Check className="size-4 text-ready" aria-hidden="true" />
                    ) : (
                      <Copy className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>

                <p className="dash-body flex items-start gap-2.5 text-muted-foreground">
                  <ExternalLink
                    className="mt-1 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    Fetch the same record over the API with{" "}
                    <code className="rounded bg-panel-strong px-1.5 py-0.5 font-mono text-[13px] text-foreground">
                      GET /v1/video/{video.id}
                    </code>
                    .
                  </span>
                </p>
              </div>
            ) : (
              <div className="dash-panel px-6 py-16 text-center">
                <Code
                  className="mx-auto size-7 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="dash-body mt-4 font-medium text-foreground">
                  Embed code appears after transcoding
                </p>
                <p className="dash-meta mx-auto mt-2 max-w-prose">
                  The player snippet needs a playback URL, which only exists once
                  the renditions are ready.
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="settings">
            <div className="w-full space-y-6">
              <DetailSection
                title="Title"
                description="Shown in the library, in the player chrome, and in webhook payloads."
              >
                {isEditing ? (
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Video title"
                  />
                ) : (
                  <p className="dash-body text-foreground">{video.title}</p>
                )}
              </DetailSection>

              <DetailSection
                title="Playback access"
                description="Public videos play from an open URL. Signed videos need a token your backend mints per viewer."
              >
                {isEditing ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      aria-pressed={editPolicy === "public"}
                      onClick={() => setEditPolicy("public")}
                      className={cn(
                        "flex items-center gap-2.5 rounded-xl border p-3.5 text-left text-[15px] font-medium transition-colors",
                        editPolicy === "public"
                          ? "border-brand bg-brand/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-muted-foreground/40",
                      )}
                    >
                      <Globe className="size-4" aria-hidden="true" />
                      Public
                    </button>
                    <button
                      type="button"
                      aria-pressed={editPolicy === "signed"}
                      onClick={() => setEditPolicy("signed")}
                      className={cn(
                        "flex items-center gap-2.5 rounded-xl border p-3.5 text-left text-[15px] font-medium transition-colors",
                        editPolicy === "signed"
                          ? "border-brand bg-brand/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-muted-foreground/40",
                      )}
                    >
                      <Lock className="size-4" aria-hidden="true" />
                      Signed
                    </button>
                  </div>
                ) : (
                  <p className="dash-body flex items-center gap-2.5 text-foreground">
                    {isSigned ? (
                      <Lock className="size-4 text-processing" aria-hidden="true" />
                    ) : (
                      <Globe className="size-4 text-ready" aria-hidden="true" />
                    )}
                    {isSigned
                      ? "Signed — every request needs a playback token"
                      : "Public — anyone with the URL can watch"}
                  </p>
                )}

                {isSigned ? (
                  <p className="dash-meta mt-4">
                    Mint tokens with{" "}
                    <code className="rounded bg-panel-strong px-1.5 py-0.5 font-mono text-[13px] text-foreground">
                      POST /v1/video/:id/playback-token
                    </code>
                    . Refresh them before they expire so playback is not
                    interrupted.
                  </p>
                ) : null}
              </DetailSection>

              {!isEditing ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setIsEditing(true)}>
                    <Pencil className="size-4" aria-hidden="true" />
                    Edit details
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleSave} disabled={isSaving}>
                    {isSaving ? (
                      <>
                        <Loader2
                          className="size-4 animate-spin"
                          aria-hidden="true"
                        />
                        Saving…
                      </>
                    ) : (
                      <>
                        <Check className="size-4" aria-hidden="true" />
                        Save changes
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsEditing(false);
                      setEditTitle(video.title);
                      setEditPolicy(video.playbackPolicy || "public");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
