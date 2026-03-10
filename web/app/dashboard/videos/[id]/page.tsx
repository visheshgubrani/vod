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
  Clock,
  Calendar,
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
import { cn } from "@/lib/utils";
import { ClipMuxPlayer } from "@/components/ui/clipmux-player";
import {
  DashboardSectionSkeleton,
  DashboardVideoDetailSkeleton,
} from "@/components/dashboard/page-skeletons";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

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
  peakConcurrents: number;
  durationSeconds: number;
}

interface VideoRetentionCurve {
  totalSessions: number;
  curve: Array<{
    progressPercent: number;
    viewersPercent: number;
    viewers: number;
  }>;
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
    "public"
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [analytics, setAnalytics] = React.useState<VideoAnalyticsData | null>(
    null
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
              }
            ),
            fetch(
              `${API_URL}/analytics-stats/video/retention-curve?videoId=${videoId}`,
              {
                credentials: "include",
              }
            ),
            fetch(
              `${API_URL}/analytics-stats/video/tech-health?videoId=${videoId}`,
              {
                credentials: "include",
              }
            ),
          ]);

        if (!contentScoreRes.ok || !retentionRes.ok || !techHealthRes.ok) {
          throw new Error("Failed to fetch video analytics");
        }

        const [contentScore, retention, techHealth] = await Promise.all([
          contentScoreRes.json() as Promise<VideoContentScore>,
          retentionRes.json() as Promise<VideoRetentionCurve>,
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
        prev ? { ...prev, title: editTitle, playbackPolicy: editPolicy } : null
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
        err instanceof Error ? err.message : "Failed to delete video"
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "--:--";
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
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  };

  const truncateTitle = (title: string, maxLen: number = 32) => {
    if (title.length <= maxLen) return title;
    return title.slice(0, maxLen) + "...";
  };

  const getEmbedCode = () => {
    if (!video?.playbackUrl) return "";
    const autoplayAttr = embedAutoplay ? " autoplay" : "";
    const mutedAttr = embedMuted ? " muted" : "";
    return `<iframe
    src="${video.playbackUrl}${
      video.playbackPolicy === "signed" ? `?token=${video.token}` : ""
    }"
    width="100%"
    height="100%"
    frameborder="0"
    allowfullscreen${autoplayAttr}${mutedAttr}
></iframe>`;
  };

  if (loading) {
    return <DashboardVideoDetailSkeleton />;
  }

  if (!video) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <AlertTriangle className="w-12 h-12 text-red-400 mb-4" />
        <h2 className="text-xl font-semibold text-foreground mb-2">
          Video not found
        </h2>
        <Button onClick={() => router.push("/dashboard")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const statusConfig = {
    ready: {
      color: "bg-lime-500",
      text: "Ready",
      textColor: "text-lime-600",
    },
    processing: {
      color: "bg-amber-500",
      text: "Processing",
      textColor: "text-amber-400",
    },
    uploading: {
      color: "bg-blue-500",
      text: "Uploading",
      textColor: "text-blue-400",
    },
    pending: {
      color: "bg-slate-500",
      text: "Pending",
      textColor: "text-slate-400",
    },
    error: { color: "bg-red-500", text: "Error", textColor: "text-red-400" },
    failed: { color: "bg-red-500", text: "Failed", textColor: "text-red-400" },
  }[video.status];

  return (
    <div className="animate-fade-in">
      {/* ═══════════════════════════════════════════════════════════
                HEADER BAR
            ═══════════════════════════════════════════════════════════ */}
      <header className="mb-6 flex w-full flex-wrap items-center justify-between gap-4 rounded-sm border border-border bg-card/30 px-4 py-4">
        {/* Left: Breadcrumbs */}
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Videos
          </button>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
          <span className="text-foreground font-medium truncate max-w-[200px]">
            {truncateTitle(video.title)}
          </span>
        </div>

        {/* Center: Title (Editable) */}
        <div className="flex-1 flex items-center justify-center min-w-0 px-4">
          {isEditing ? (
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="max-w-md rounded-sm border-border bg-muted/30 text-center text-xl font-semibold"
              placeholder="Video title"
              autoFocus
            />
          ) : (
            <h1 className="text-xl font-semibold text-foreground truncate max-w-lg">
              {video.title}
            </h1>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsEditing(false);
                  setEditTitle(video.title);
                  setEditPolicy(video.playbackPolicy || "public");
                }}
                className="rounded-sm"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving}
                className="rounded-sm"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Check className="w-4 h-4 mr-1" />
                    Save
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditing(true)}
                className="rounded-sm border-border text-muted-foreground hover:text-foreground"
              >
                <Pencil className="w-4 h-4 mr-1" />
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDeleteError(null);
                  setShowDeleteConfirm(true);
                }}
                className="rounded-sm border-red-400/30 text-red-400 hover:text-red-400 hover:bg-red-500/10"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </header>

      {/* ═══════════════════════════════════════════════════════════
                2-COLUMN HERO LAYOUT
            ═══════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-8">
        {/* LEFT: Video Player (3/5 = 60%) */}
        <div className="lg:col-span-3">
          <div className="overflow-hidden rounded-sm bg-black shadow-2xl">
            {video.status === "ready" && video.playbackUrl ? (
              <ClipMuxPlayer
                src={video.playbackUrl}
                videoId={video.id}
                title={video.title}
                subtitles={video.subtitleUrl || undefined}
                chapters={video.chapters || undefined}
              />
            ) : (
              <div className="aspect-video flex flex-col items-center justify-center bg-muted/20">
                {video.status === "processing" ||
                video.status === "uploading" ? (
                  <>
                    <Loader2 className="w-10 h-10 text-amber-400 animate-spin mb-3" />
                    <p className="text-sm text-muted-foreground">
                      Processing video...
                    </p>
                  </>
                ) : video.status === "error" || video.status === "failed" ? (
                  <>
                    <AlertTriangle className="w-10 h-10 text-red-400 mb-3" />
                    <p className="text-sm text-muted-foreground">
                      Processing failed
                    </p>
                  </>
                ) : (
                  <>
                    <Play className="w-10 h-10 text-muted-foreground mb-3" />
                    <p className="text-sm text-muted-foreground">
                      Waiting to process
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Info Cards (2/5 = 40%) */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* ─────────────────────────────────────────────────
                        CARD A: Asset Details
                    ───────────────────────────────────────────────── */}
          <div className="glass rounded-sm p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Asset Details
              </h3>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium",
                    statusConfig.textColor,
                    "bg-current/10"
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      statusConfig.color
                    )}
                  />
                  {statusConfig.text}
                </span>
                {video.resolutions && (
                  <span className="rounded-sm bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                    {video.resolutions}
                  </span>
                )}
              </div>
            </div>

            {/* Video ID */}
            <div className="mb-4">
              <label className="text-xs text-muted-foreground block mb-1.5">
                Video ID
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-sm bg-muted-foreground/30 px-3 py-2 font-mono text-xs text-foreground">
                  {video.id}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleCopy(video.id, "id")}
                  className="shrink-0"
                >
                  {copied === "id" ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Specs Row */}
            <div className="pt-4 flex items-center gap-4 font-medium text-sm text-foreground/75">
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                {formatDuration(video.duration)}
              </span>
              <span className="text-muted-foreground/30">•</span>
              <span className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                {formatDate(video.createdAt)}
              </span>
              {video.fileSize && (
                <>
                  <span className="text-muted-foreground/30">•</span>
                  <span className="flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5" />
                    {formatFileSize(video.fileSize)}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────
                        CARD B: Delivery
                    ───────────────────────────────────────────────── */}
          <div className="glass flex-1 rounded-sm p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Delivery
              </h3>
              <div className="flex items-center gap-2">
                {video.playbackPolicy === "signed" ? (
                  <>
                    <Lock className="h-4 w-4 text-amber-400" />
                    <span className="text-sm font-medium text-amber-400">
                      Signed URL Required
                    </span>
                  </>
                ) : (
                  <>
                    <Globe className="h-4 w-4 text-lime-500/80" />
                    <span className="text-sm font-medium text-lime-500/80">
                      Public Access
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Playback URL */}
            {video.playbackUrl && (
              <div className="mb-4">
                <label className="text-xs text-muted-foreground block mb-1.5 flex items-center gap-2">
                  <Link2 className="size-4" />
                  Playback URL
                  {video.playbackPolicy === "signed" && (
                    <span className="text-[10px] text-amber-400">
                      (Token expires in 1h)
                    </span>
                  )}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={video.playbackUrl}
                    className="flex-1 px-3 py-2 rounded-sm bg-muted-foreground/25 border border-border text-xs text-foreground font-mono truncate"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCopy(video.playbackUrl!, "url")}
                    className="shrink-0"
                  >
                    {copied === "url" ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Thumbnail */}
            {video.thumbnailUrl ? (
              <div className="pt-4">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <label className="block text-xs text-muted-foreground">
                    Thumbnail
                  </label>
                  <a
                    href={video.thumbnailUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download Poster
                  </a>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                Thumbnail available after processing
              </div>
            )}
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="glass mx-4 w-full max-w-md rounded-sm p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-destructive/20">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <h2 className="text-xl font-bold text-foreground">
                Delete Video
              </h2>
            </div>
            <p className="mb-3 text-muted-foreground">
              Are you sure you want to delete &quot;{video.title}&quot;? This
              action cannot be undone.
            </p>
            {deleteError && (
              <p className="mb-6 rounded-sm border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deleteError}
              </p>
            )}
            {!deleteError && <div className="mb-6" />}
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteError(null);
                }}
                className="flex-1 rounded-sm"
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1 rounded-sm bg-destructive hover:bg-destructive/90"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
                TABS SECTION
            ═══════════════════════════════════════════════════════════ */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3 gap-3 rounded-sm border border-border bg-card/30 p-2">
          <TabsTrigger
            value="analytics"
            className="gap-1.5 rounded-sm px-4 py-3 font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <BarChart3 className="w-4 h-4" />
            Analytics
          </TabsTrigger>
          <TabsTrigger
            value="embed"
            className="gap-1.5 rounded-sm px-4 py-3 font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Code className="w-4 h-4" />
            Embed
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="gap-1.5 rounded-sm px-4 py-3 font-semibold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Settings className="w-4 h-4" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Analytics Tab */}
        <TabsContent value="analytics" className="mt-6">
          {analyticsLoading ? (
            <div className="space-y-4 py-2">
              <DashboardSectionSkeleton className="h-36" />
              <DashboardSectionSkeleton className="h-72" />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DashboardSectionSkeleton className="h-44" />
                <DashboardSectionSkeleton className="h-44" />
              </div>
            </div>
          ) : analytics ? (
            <div className="space-y-8">
              {/* Row 1: Content Score */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Content Score
                </h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="rounded-sm border border-border bg-card/40 p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Avg. Watch Time
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {formatWatchSeconds(
                        analytics.contentScore.avgWatchSeconds
                      )}
                    </p>
                  </div>
                  <div className="rounded-sm border border-border bg-card/40 p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Completion Rate
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {analytics.contentScore.completionRatePercent.toFixed(1)}%
                    </p>
                  </div>
                  <div className="rounded-sm border border-border bg-card/40 p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Peak Concurrents
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {analytics.contentScore.peakConcurrents.toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>

              {/* Row 2: Audience Retention */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Audience Retention
                </h3>
                <div className="rounded-sm border border-border bg-card/40 p-4">
                  {analytics.retention.curve.length > 0 ? (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={analytics.retention.curve}>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="hsl(var(--border))"
                          />
                          <XAxis
                            dataKey="progressPercent"
                            stroke="hsl(var(--muted-foreground))"
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => `${value}%`}
                          />
                          <YAxis
                            stroke="hsl(var(--muted-foreground))"
                            tick={{ fontSize: 12 }}
                            domain={[0, 100]}
                            tickFormatter={(value) => `${value}%`}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "12px",
                            }}
                            formatter={(
                              value: number | string | (number | string)[] | undefined,
                              name: string | undefined
                            ) => {
                              const numericValue =
                                typeof value === "number"
                                  ? value
                                  : Number(
                                      Array.isArray(value) ? value[0] : value
                                    ) || 0;
                              const seriesName = String(name ?? "value");

                              if (seriesName === "viewersPercent")
                                return [
                                  `${numericValue.toFixed(2)}%`,
                                  "Viewers still watching",
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
                            stroke="hsl(var(--primary))"
                            strokeWidth={2.5}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground py-10 text-center">
                      No retention points available yet
                    </div>
                  )}
                </div>
              </div>

              {/* Row 3: Tech Health */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Tech Health
                </h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-sm border border-border bg-card/40 p-5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Buffering Signals
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {analytics.techHealth.bufferingSessionRatePercent.toFixed(
                        1
                      )}
                      %
                    </p>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      Sessions with seek events:{" "}
                      {analytics.techHealth.sessionsWithSeek.toLocaleString()} /{" "}
                      {analytics.techHealth.totalSessions.toLocaleString()}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      Seek events logged:{" "}
                      {analytics.techHealth.seekEvents.toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-sm border border-border bg-card/40 p-5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      Errors
                    </p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      {analytics.techHealth.sessionErrorRatePercent.toFixed(2)}%
                    </p>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      Sessions with errors:{" "}
                      {analytics.techHealth.sessionsWithErrors.toLocaleString()}{" "}
                      / {analytics.techHealth.totalSessions.toLocaleString()}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      Total error events:{" "}
                      {analytics.techHealth.totalErrors.toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="rounded-sm border border-border bg-card/40 p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                    Top Error Codes
                  </p>
                  {analytics.techHealth.topErrors.length > 0 ? (
                    <div className="space-y-2">
                      {analytics.techHealth.topErrors.map((errorRow) => (
                        <div
                          key={errorRow.code}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="font-mono text-foreground">
                            {errorRow.code}
                          </span>
                          <span className="text-muted-foreground">
                            {errorRow.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No error events recorded.
                    </p>
                  )}
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                Completion is counted when a session reaches at least 95% of the
                video duration.
              </div>
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              <BarChart3 className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No analytics data yet</p>
              <p className="text-xs mt-1 opacity-60">
                Data will appear once viewers watch your video
              </p>
            </div>
          )}
        </TabsContent>

        {/* Embed Tab */}
        <TabsContent value="embed" className="mt-6">
          {video.status === "ready" && video.playbackUrl ? (
            <div className="w-full space-y-6">
              {/* Options */}
              <div className="flex gap-6">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={embedAutoplay}
                    onChange={(e) => setEmbedAutoplay(e.target.checked)}
                    className="rounded border border-accent size-4"
                  />
                  <span className="text-sm">Autoplay</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={embedMuted}
                    onChange={(e) => setEmbedMuted(e.target.checked)}
                    className="rounded border border-accent size-4 "
                  />
                  <span className="text-sm">Muted</span>
                </label>
              </div>

              {/* Code */}
              <div className="relative">
                <pre className="p-4 rounded-sm bg-muted/90 font-mono text-xs overflow-x-auto">
                  <code>{getEmbedCode()}</code>
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleCopy(getEmbedCode(), "embed")}
                  className="absolute top-2 right-2"
                >
                  {copied === "embed" ? (
                    <Check className="w-4 h-4 text-lime-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>

              {/* API Note */}
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <ExternalLink className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <p>
                  For API access, use{" "}
                  <code className="ml-1 text-xs bg-muted-foreground/35 py-1 px-2 font-medium text-foreground/90 rounded">
                    GET /v1/video/{video.id}
                  </code>
                </p>
              </div>
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              <Code className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Embed code available after processing</p>
            </div>
          )}
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="mt-6">
          <div className="w-full space-y-8">
            {/* Title */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              {isEditing ? (
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Video title"
                  className="rounded-sm border-border bg-muted/30"
                />
              ) : (
                <p className="text-foreground">{video.title}</p>
              )}
            </div>

            {/* Playback Policy */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Access</label>
              {isEditing ? (
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => setEditPolicy("public")}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-sm border text-sm transition-colors",
                      editPolicy === "public"
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    )}
                  >
                    <Globe className="w-4 h-4" />
                    Public
                  </button>
                  <button
                    onClick={() => setEditPolicy("signed")}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-sm border text-sm transition-colors",
                      editPolicy === "signed"
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    )}
                  >
                    <Lock className="w-4 h-4" />
                    Signed URL
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {video.playbackPolicy === "signed" ? (
                    <>
                      <Lock className="w-4 h-4 text-amber-400" />
                      <span>Requires signed URL</span>
                    </>
                  ) : (
                    <>
                      <Globe className="w-4 h-4 text-lime-400" />
                      <span>Public access</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Signed Video Notice */}
            {video.playbackPolicy === "signed" && (
              <div className="rounded-sm border border-amber-500/20 bg-amber-500/10 p-4">
                <div className="flex items-start gap-3">
                  <Lock className="w-5 h-5 text-amber-400 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-400 mb-1">
                      Signed Video
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Use{" "}
                      <code className="text-xs bg-muted/50 px-1 rounded">
                        POST /v1/video/:id/playback-token
                      </code>{" "}
                      to generate playback URLs for your users.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
