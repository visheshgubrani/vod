"use client";

import * as React from "react";
import {
  X,
  Copy,
  Check,
  Play,
  Lock,
  Globe,
  Clock,
  Calendar,
  Film,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { Video } from "./videos-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { OpenVodPlayer } from "@/components/ui/openvod-player";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";

interface VideoDetailModalProps {
  video: Video;
  onClose: () => void;
  onUpdate?: () => void;
}

interface VideoDetail extends Video {
  playbackUrl?: string | null;
  token?: string | null;
  subtitleUrl?: string | null;
  chapters?: Array<{
    startTime: number;
    endTime: number;
    title: string;
  }> | null;
  chaptersStatus?: string | null;
}

export function VideoDetailModal({
  video,
  onClose,
  onUpdate,
}: VideoDetailModalProps) {
  const [detail, setDetail] = React.useState<VideoDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState(video.title);
  const [editPolicy, setEditPolicy] = React.useState<"public" | "signed">(
    video.playbackPolicy || "public"
  );
  const [isSaving, setIsSaving] = React.useState(false);

  // Fetch video details
  React.useEffect(() => {
    const fetchDetail = async () => {
      try {
        const res = await fetch(`${API_URL}/video/${video.id}`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to fetch video details");
        const data = await res.json();
        setDetail(data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetail();
  }, [video.id]);

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleSave = async () => {
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
      setIsEditing(false);
      onUpdate?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update video");
    } finally {
      setIsSaving(false);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "Unknown";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatDate = (date?: Date | string) => {
    if (!date) return "Unknown";
    const d = typeof date === "string" ? new Date(date) : date;
    return d.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const statusColors: Record<string, string> = {
    ready: "text-lime-400",
    processing: "text-amber-400",
    uploading: "text-blue-400",
    pending: "text-slate-400",
    error: "text-red-400",
    failed: "text-red-400",
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="glass rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold text-foreground">Video Details</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-sm hover:bg-muted/50 transition-colors"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          ) : (
            <>
              {/* Title Section */}
              <div className="space-y-2">
                {isEditing ? (
                  <>
                    <Label>Title</Label>
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">Title</p>
                    <p className="text-lg font-semibold text-foreground">
                      {detail?.title || video.title}
                    </p>
                  </>
                )}
              </div>

              {/* Status & Policy Row */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-muted/30 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">Status</p>
                  <p
                    className={cn(
                      "font-medium capitalize",
                      statusColors[video.status] || "text-foreground"
                    )}
                  >
                    {video.status}
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-muted/30 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">
                    Playback Policy
                  </p>
                  {isEditing ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditPolicy("public")}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium",
                          editPolicy === "public"
                            ? "bg-primary text-white"
                            : "bg-muted/50 text-muted-foreground"
                        )}
                      >
                        <Globe className="w-3 h-3" />
                        Public
                      </button>
                      <button
                        onClick={() => setEditPolicy("signed")}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium",
                          editPolicy === "signed"
                            ? "bg-primary text-white"
                            : "bg-muted/50 text-muted-foreground"
                        )}
                      >
                        <Lock className="w-3 h-3" />
                        Signed
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 font-medium">
                      {(detail?.playbackPolicy || video.playbackPolicy) ===
                      "signed" ? (
                        <>
                          <Lock className="w-4 h-4 text-amber-400" />
                          <span className="text-amber-400">Signed</span>
                        </>
                      ) : (
                        <>
                          <Globe className="w-4 h-4 text-lime-500" />
                          <span className="text-lime-500">Public</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Video ID */}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Video ID</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 p-3 rounded-sm bg-muted/30 border border-border font-mono text-sm text-foreground">
                    {video.id}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCopy(video.id, "id")}
                  >
                    {copied === "id" ? (
                      <Check className="w-4 h-4 text-lime-400" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Playback URL (only for public or if we have a token) */}
              {video.status === "ready" && detail?.playbackUrl && (
                <>
                  {/* Video Player Preview */}
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Preview Player
                    </p>
                    <OpenVodPlayer
                      src={detail.playbackUrl}
                      videoId={video.id}
                      title={detail?.title || video.title}
                      subtitles={detail?.subtitleUrl || undefined}
                      chapters={detail?.chapters || undefined}
                    />
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Playback URL
                      {(detail?.playbackPolicy || video.playbackPolicy) ===
                        "signed" && (
                        <span className="ml-2 text-xs text-amber-400">
                          (Token expires in 1 hour)
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 p-3 rounded-sm bg-muted/30 border border-border font-mono text-xs text-foreground truncate">
                        {detail.playbackUrl}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleCopy(detail.playbackUrl!, "url")}
                      >
                        {copied === "url" ? (
                          <Check className="w-4 h-4 text-lime-400" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {/* Info Grid */}
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-muted/30 border border-border">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Clock className="w-4 h-4" />
                    <p className="text-xs">Duration</p>
                  </div>
                  <p className="font-medium text-foreground">
                    {formatDuration(detail?.duration || video.duration)}
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-muted/30 border border-border">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="w-4 h-4" />
                    <p className="text-xs">Created</p>
                  </div>
                  <p className="font-medium text-foreground text-sm">
                    {formatDate(detail?.createdAt || video.createdAt)}
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-muted/30 border border-border">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Film className="w-4 h-4" />
                    <p className="text-xs">Format</p>
                  </div>
                  <p className="font-medium text-foreground">HLS</p>
                </div>
              </div>

              {/* Signed Video Notice */}
              {(detail?.playbackPolicy || video.playbackPolicy) ===
                "signed" && (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                  <div className="flex items-start gap-3">
                    <Lock className="w-5 h-5 text-amber-400 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-400 mb-1">
                        Signed Video
                      </p>
                      <p className="text-sm text-muted-foreground">
                        This video requires a signed token for playback. Use the{" "}
                        <code className="text-xs bg-muted/50 px-1 rounded">
                          POST /v1/video/:id/playback-token
                        </code>{" "}
                        API to generate playback URLs for your users.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-border">
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
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Changes"
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => setIsEditing(true)}>Edit Video</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
