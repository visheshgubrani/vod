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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ClipMuxPlayer } from "@/components/ui/clipmux-player";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

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
    chapters?: Array<{ startTime: number; endTime: number; title: string }> | null;
    chaptersStatus?: string | null;
    resolutions?: string;
    fileSize?: number;
}

interface AnalyticsData {
    totalViews: number;
    uniqueViewers: number;
    totalWatchTime: number;
    avgWatchTime: number;
    dailyViews: Array<{ date: string; views: number }>;
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
    const [editPolicy, setEditPolicy] = React.useState<"public" | "signed">("public");
    const [isSaving, setIsSaving] = React.useState(false);
    const [isDeleting, setIsDeleting] = React.useState(false);
    const [analytics, setAnalytics] = React.useState<AnalyticsData | null>(null);
    const [analyticsLoading, setAnalyticsLoading] = React.useState(false);
    const [embedAutoplay, setEmbedAutoplay] = React.useState(false);
    const [embedMuted, setEmbedMuted] = React.useState(true);
    const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

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
                const res = await fetch(`${API_URL}/analytics-stats/${videoId}`, {
                    credentials: "include",
                });
                if (res.ok) {
                    const data = await res.json();
                    setAnalytics(data);
                }
            } catch (err) {
                console.error("Failed to fetch analytics:", err);
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
            setVideo((prev) => prev ? { ...prev, title: editTitle, playbackPolicy: editPolicy } : null);
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
        try {
            const res = await fetch(`${API_URL}/video/${video.id}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!res.ok) throw new Error("Failed to delete video");
            router.push("/dashboard");
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to delete video");
            setIsDeleting(false);
        }
    };

    const formatDuration = (seconds?: number) => {
        if (!seconds) return "--:--";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
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
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
    };

    const truncateTitle = (title: string, maxLen: number = 32) => {
        if (title.length <= maxLen) return title;
        return title.slice(0, maxLen) + "...";
    };

    const getEmbedCode = () => {
        if (!video?.playbackUrl) return "";
        const autoplayAttr = embedAutoplay ? ' autoplay' : '';
        const mutedAttr = embedMuted ? ' muted' : '';
        return `<iframe
    src="${video.playbackUrl}${video.playbackPolicy === 'signed' ? `?token=${video.token}` : ''}"
    width="100%"
    height="100%"
    frameborder="0"
    allowfullscreen${autoplayAttr}${mutedAttr}
></iframe>`;
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Loading video...</p>
                </div>
            </div>
        );
    }

    if (!video) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
                <AlertTriangle className="w-12 h-12 text-red-400 mb-4" />
                <h2 className="text-xl font-semibold text-foreground mb-2">Video not found</h2>
                <Button onClick={() => router.push("/dashboard")}>
                    Back to Dashboard
                </Button>
            </div>
        );
    }

    const statusConfig = {
        ready: { color: "bg-emerald-500", text: "Ready", textColor: "text-emerald-400" },
        processing: { color: "bg-amber-500", text: "Processing", textColor: "text-amber-400" },
        uploading: { color: "bg-blue-500", text: "Uploading", textColor: "text-blue-400" },
        pending: { color: "bg-slate-500", text: "Pending", textColor: "text-slate-400" },
        error: { color: "bg-red-500", text: "Error", textColor: "text-red-400" },
        failed: { color: "bg-red-500", text: "Failed", textColor: "text-red-400" },
    }[video.status];

    return (
        <div className="animate-fade-in">
            {/* ═══════════════════════════════════════════════════════════
                HEADER BAR
            ═══════════════════════════════════════════════════════════ */}
            <header className="flex flex-wrap items-center justify-between gap-4 pb-6 mb-6 border-b border-border">
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
                            className="text-xl font-semibold text-center max-w-md"
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
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setIsEditing(false);
                                    setEditTitle(video.title);
                                    setEditPolicy(video.playbackPolicy || "public");
                                }}
                            >
                                Cancel
                            </Button>
                            <Button size="sm" onClick={handleSave} disabled={isSaving}>
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
                                variant="ghost"
                                size="sm"
                                onClick={() => setIsEditing(true)}
                                className="text-muted-foreground hover:text-foreground"
                            >
                                <Pencil className="w-4 h-4 mr-1" />
                                Edit
                            </Button>
                            {!showDeleteConfirm ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="text-red-400 hover:text-red-400 hover:bg-red-500/10"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </Button>
                            ) : (
                                <div className="flex items-center gap-2 animate-in fade-in-0">
                                    <span className="text-xs text-muted-foreground">Delete?</span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setShowDeleteConfirm(false)}
                                    >
                                        No
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="text-red-400 border-red-400/50 hover:bg-red-500/10"
                                        onClick={handleDelete}
                                        disabled={isDeleting}
                                    >
                                        {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Yes"}
                                    </Button>
                                </div>
                            )}
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
                    <div className="rounded-xl overflow-hidden bg-black shadow-2xl">
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
                                {video.status === "processing" || video.status === "uploading" ? (
                                    <>
                                        <Loader2 className="w-10 h-10 text-amber-400 animate-spin mb-3" />
                                        <p className="text-sm text-muted-foreground">Processing video...</p>
                                    </>
                                ) : video.status === "error" || video.status === "failed" ? (
                                    <>
                                        <AlertTriangle className="w-10 h-10 text-red-400 mb-3" />
                                        <p className="text-sm text-muted-foreground">Processing failed</p>
                                    </>
                                ) : (
                                    <>
                                        <Play className="w-10 h-10 text-muted-foreground mb-3" />
                                        <p className="text-sm text-muted-foreground">Waiting to process</p>
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
                    <div className="glass rounded-xl p-5">
                        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">
                            Asset Details
                        </h3>

                        {/* Status + Resolution Row */}
                        <div className="flex items-center gap-3 mb-4">
                            <span className={cn(
                                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                                statusConfig.textColor,
                                "bg-current/10"
                            )}>
                                <span className={cn("w-1.5 h-1.5 rounded-full", statusConfig.color)} />
                                {statusConfig.text}
                            </span>
                            {video.resolutions && (
                                <span className="text-xs text-muted-foreground bg-muted/30 px-2 py-1 rounded">
                                    {video.resolutions}
                                </span>
                            )}
                        </div>

                        {/* Video ID */}
                        <div className="mb-4">
                            <label className="text-xs text-muted-foreground block mb-1.5">Video ID</label>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 px-3 py-2 rounded-lg bg-muted/30 font-mono text-xs text-foreground truncate">
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
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
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
                    <div className="glass rounded-xl p-5 flex-1">
                        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-4">
                            Delivery
                        </h3>

                        {/* Playback Policy */}
                        <div className="flex items-center gap-2 mb-4">
                            {video.playbackPolicy === "signed" ? (
                                <>
                                    <Lock className="w-4 h-4 text-amber-400" />
                                    <span className="text-sm text-amber-400 font-medium">Signed URL Required</span>
                                </>
                            ) : (
                                <>
                                    <Globe className="w-4 h-4 text-emerald-400" />
                                    <span className="text-sm text-emerald-400 font-medium">Public Access</span>
                                </>
                            )}
                        </div>

                        {/* Playback URL */}
                        {video.playbackUrl && (
                            <div className="mb-4">
                                <label className="text-xs text-muted-foreground block mb-1.5 flex items-center gap-2">
                                    <Link2 className="w-3 h-3" />
                                    Playback URL
                                    {video.playbackPolicy === "signed" && (
                                        <span className="text-[10px] text-amber-400">(Token expires in 1h)</span>
                                    )}
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={video.playbackUrl}
                                        className="flex-1 px-3 py-2 rounded-lg bg-muted/30 border border-border text-xs text-foreground font-mono truncate"
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
                            <div>
                                <label className="text-xs text-muted-foreground block mb-1.5">Thumbnail</label>
                                <a
                                    href={video.thumbnailUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    Download Poster
                                </a>
                            </div>
                        ) : (
                            <div className="text-xs text-muted-foreground">
                                Thumbnail available after processing
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════
                TABS SECTION
            ═══════════════════════════════════════════════════════════ */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="bg-transparent border-b border-border rounded-none w-full justify-start gap-6 p-0 h-auto">
                    <TabsTrigger
                        value="analytics"
                        className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3"
                    >
                        <BarChart3 className="w-4 h-4 mr-2" />
                        Analytics
                    </TabsTrigger>
                    <TabsTrigger
                        value="embed"
                        className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3"
                    >
                        <Code className="w-4 h-4 mr-2" />
                        Embed
                    </TabsTrigger>
                    <TabsTrigger
                        value="settings"
                        className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-0 py-3"
                    >
                        <Settings className="w-4 h-4 mr-2" />
                        Settings
                    </TabsTrigger>
                </TabsList>

                {/* Analytics Tab */}
                <TabsContent value="analytics" className="mt-6">
                    {analyticsLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-6 h-6 text-primary animate-spin" />
                        </div>
                    ) : analytics ? (
                        <div className="space-y-8">
                            {/* Stats */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                                <div>
                                    <p className="text-3xl font-semibold text-foreground">{analytics.totalViews.toLocaleString()}</p>
                                    <p className="text-sm text-muted-foreground mt-1">Total views</p>
                                </div>
                                <div>
                                    <p className="text-3xl font-semibold text-foreground">{analytics.uniqueViewers.toLocaleString()}</p>
                                    <p className="text-sm text-muted-foreground mt-1">Unique viewers</p>
                                </div>
                                <div>
                                    <p className="text-3xl font-semibold text-foreground">{Math.floor(analytics.totalWatchTime / 60).toLocaleString()}m</p>
                                    <p className="text-sm text-muted-foreground mt-1">Watch time</p>
                                </div>
                                <div>
                                    <p className="text-3xl font-semibold text-foreground">{Math.floor(analytics.avgWatchTime).toLocaleString()}s</p>
                                    <p className="text-sm text-muted-foreground mt-1">Avg. watch time</p>
                                </div>
                            </div>

                            {/* Chart */}
                            {analytics.dailyViews && analytics.dailyViews.length > 0 && (
                                <div>
                                    <h3 className="text-sm font-medium text-muted-foreground mb-4">Views over time</h3>
                                    <div className="h-48 flex items-end gap-1">
                                        {analytics.dailyViews.map((day, idx) => {
                                            const maxViews = Math.max(...analytics.dailyViews.map(d => d.views), 1);
                                            const height = (day.views / maxViews) * 100;
                                            return (
                                                <div
                                                    key={idx}
                                                    className="flex-1 flex flex-col items-center gap-1"
                                                >
                                                    <div className="w-full relative" style={{ height: "150px" }}>
                                                        <div
                                                            className="absolute bottom-0 w-full bg-primary/60 hover:bg-primary rounded-sm transition-all"
                                                            style={{ height: `${height}%`, minHeight: day.views > 0 ? "4px" : "0" }}
                                                            title={`${day.date}: ${day.views} views`}
                                                        />
                                                    </div>
                                                    <span className="text-[10px] text-muted-foreground">
                                                        {new Date(day.date).toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="text-center py-16 text-muted-foreground">
                            <BarChart3 className="w-8 h-8 mx-auto mb-3 opacity-40" />
                            <p className="text-sm">No analytics data yet</p>
                            <p className="text-xs mt-1 opacity-60">Data will appear once viewers watch your video</p>
                        </div>
                    )}
                </TabsContent>

                {/* Embed Tab */}
                <TabsContent value="embed" className="mt-6">
                    {video.status === "ready" && video.playbackUrl ? (
                        <div className="space-y-6 max-w-2xl">
                            {/* Options */}
                            <div className="flex gap-6">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={embedAutoplay}
                                        onChange={(e) => setEmbedAutoplay(e.target.checked)}
                                        className="rounded border-border"
                                    />
                                    <span className="text-sm">Autoplay</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={embedMuted}
                                        onChange={(e) => setEmbedMuted(e.target.checked)}
                                        className="rounded border-border"
                                    />
                                    <span className="text-sm">Muted</span>
                                </label>
                            </div>

                            {/* Code */}
                            <div className="relative">
                                <pre className="p-4 rounded-lg bg-muted/30 font-mono text-xs overflow-x-auto">
                                    <code>{getEmbedCode()}</code>
                                </pre>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleCopy(getEmbedCode(), "embed")}
                                    className="absolute top-2 right-2"
                                >
                                    {copied === "embed" ? (
                                        <Check className="w-4 h-4 text-emerald-400" />
                                    ) : (
                                        <Copy className="w-4 h-4" />
                                    )}
                                </Button>
                            </div>

                            {/* API Note */}
                            <div className="flex items-start gap-3 text-sm text-muted-foreground">
                                <ExternalLink className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                <p>
                                    For API access, use{" "}
                                    <code className="text-xs bg-muted px-1 rounded">GET /v1/video/{video.id}</code>
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
                    <div className="space-y-8 max-w-xl">
                        {/* Title */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Title</label>
                            {isEditing ? (
                                <Input
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    placeholder="Video title"
                                />
                            ) : (
                                <p className="text-foreground">{video.title}</p>
                            )}
                        </div>

                        {/* Playback Policy */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Access</label>
                            {isEditing ? (
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setEditPolicy("public")}
                                        className={cn(
                                            "flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors",
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
                                            "flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors",
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
                                            <Globe className="w-4 h-4 text-emerald-400" />
                                            <span>Public access</span>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Signed Video Notice */}
                        {video.playbackPolicy === "signed" && (
                            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                                <div className="flex items-start gap-3">
                                    <Lock className="w-5 h-5 text-amber-400 mt-0.5" />
                                    <div>
                                        <p className="font-medium text-amber-400 mb-1">Signed Video</p>
                                        <p className="text-sm text-muted-foreground">
                                            Use{" "}
                                            <code className="text-xs bg-muted/50 px-1 rounded">POST /v1/video/:id/playback-token</code>{" "}
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
