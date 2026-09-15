"use client";

import * as React from "react";
import {
  MoreVertical,
  Copy,
  Code,
  Trash2,
  ExternalLink,
  Play,
  Lock,
  ImageOff,
  Film,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface Video {
  id: string;
  title: string;
  status: "ready" | "processing" | "error" | "uploading" | "pending" | "failed";
  playbackPolicy?: "public" | "signed";
  thumbnailUrl?: string;
  duration?: number; // in seconds
  createdAt: Date | string;
}

interface VideosTableProps {
  videos: Video[];
  onCopyId?: (id: string) => void;
  onEmbed?: (video: Video) => void;
  onDelete?: (video: Video) => void;
  onViewDetails?: (video: Video) => void;
}

export const statusConfig = {
  ready: {
    label: "Ready",
    text: "text-ready",
    dot: "bg-ready",
    badge: "ready" as const,
  },
  processing: {
    label: "Processing",
    text: "text-processing",
    dot: "bg-processing animate-pulse",
    badge: "processing" as const,
  },
  uploading: {
    label: "Uploading",
    text: "text-info",
    dot: "bg-info animate-pulse",
    badge: "uploading" as const,
  },
  pending: {
    label: "Pending",
    text: "text-idle",
    dot: "bg-idle",
    badge: "neutral" as const,
  },
  error: {
    label: "Failed",
    text: "text-failed",
    dot: "bg-failed",
    badge: "failed" as const,
  },
  failed: {
    label: "Failed",
    text: "text-failed",
    dot: "bg-failed",
    badge: "failed" as const,
  },
};

function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === "string" ? new Date(date) : date;
  const diffInSeconds = Math.floor((Date.now() - dateObj.getTime()) / 1000);

  if (diffInSeconds < 60) return "Just now";
  if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} min ago`;
  }
  if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (diffInSeconds < 604800) {
    const days = Math.floor(diffInSeconds / 86400);
    return days === 1 ? "Yesterday" : `${days} days ago`;
  }

  return dateObj.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * 112×63 thumbnail (16:9) with three explicit fallbacks:
 *
 * - **signed** assets keep the lock treatment. The point of signed playback is
 *   that the thumbnail URL is not publicly reachable, so the dashboard does not
 *   probe it — there is nothing to load and nothing to leak.
 * - a missing or broken `thumbnailUrl` falls back to a neutral placeholder,
 *   never a browser broken-image icon.
 * - otherwise the real customer thumbnail is shown, unmodified.
 */
function VideoThumbnail({
  video,
  className,
}: {
  video: Video;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = React.useState(false);

  React.useEffect(() => {
    setImageFailed(false);
  }, [video.thumbnailUrl]);

  const isSigned = video.playbackPolicy === "signed";

  return (
    <div
      className={cn(
        "relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg border border-border bg-panel-strong",
        className,
      )}
    >
      {isSigned ? (
        <div className="flex size-full flex-col items-center justify-center gap-1 bg-panel-strong text-muted-foreground">
          <Lock className="size-4" aria-hidden="true" />
          <span className="text-[11px] font-medium">Signed</span>
        </div>
      ) : video.thumbnailUrl && !imageFailed ? (
        <img
          src={video.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="flex size-full items-center justify-center text-faint-foreground">
          {video.thumbnailUrl ? (
            <ImageOff className="size-5" aria-hidden="true" />
          ) : (
            <Film className="size-5" aria-hidden="true" />
          )}
          <span className="sr-only">
            {video.thumbnailUrl
              ? "Thumbnail unavailable"
              : "No thumbnail yet"}
          </span>
        </div>
      )}
    </div>
  );
}

function VideoActions({
  video,
  onCopyId,
  onEmbed,
  onDelete,
  onViewDetails,
  openUpward = false,
}: {
  video: Video;
  onCopyId: (id: string) => void;
  onEmbed?: (video: Video) => void;
  onDelete?: (video: Video) => void;
  onViewDetails?: (video: Video) => void;
  openUpward?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${video.title}`}
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-strong hover:text-foreground"
        >
          <MoreVertical className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={openUpward ? "top" : "bottom"}
        className="min-w-[210px] whitespace-nowrap"
      >
        <DropdownMenuItem
          onClick={() => onCopyId(video.id)}
          className="whitespace-nowrap"
        >
          <Copy className="size-4" />
          Copy video ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onEmbed?.(video)}
          className="whitespace-nowrap"
        >
          <Code className="size-4" />
          Get embed code
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onViewDetails?.(video)}
          className="whitespace-nowrap"
        >
          <ExternalLink className="size-4" />
          View details
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onDelete?.(video)}
          destructive
          className="whitespace-nowrap"
        >
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function VideosTable({
  videos,
  onCopyId,
  onEmbed,
  onDelete,
  onViewDetails,
}: VideosTableProps) {
  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    onCopyId?.(id);
  };

  if (videos.length === 0) {
    return (
      <div className="dash-panel flex flex-col items-center justify-center px-6 py-16 text-center">
        <span className="flex size-14 items-center justify-center rounded-full border border-border bg-panel-strong text-muted-foreground">
          <Play className="size-6" aria-hidden="true" />
        </span>
        <h3 className="mt-5 text-lg font-semibold text-foreground">
          No videos yet
        </h3>
        <p className="dash-body mt-2 max-w-sm text-muted-foreground">
          Use the upload button in the sidebar to add your first asset. It will
          appear here with its processing state.
        </p>
      </div>
    );
  }

  return (
    <div className="dash-panel overflow-hidden">
      {/* Desktop table */}
      <div className="hidden md:block">
        <div className="grid grid-cols-[minmax(0,1fr)_92px_104px_128px_56px] items-center gap-4 border-b border-border px-5 py-3 text-[13px] font-semibold text-muted-foreground">
          <div>Video</div>
          <div>Status</div>
          <div>Duration</div>
          <div>Added</div>
          <div className="sr-only">Actions</div>
        </div>

        <ul className="divide-y divide-border-soft">
          {videos.map((video, index) => {
            const status = statusConfig[video.status];

            return (
              <li
                key={video.id}
                className="grid min-h-[88px] grid-cols-[minmax(0,1fr)_92px_104px_128px_56px] items-center gap-4 px-5 py-3 transition-colors hover:bg-panel-strong/40"
              >
                <div className="flex min-w-0 items-center gap-4">
                  <VideoThumbnail video={video} />
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onViewDetails?.(video)}
                      className="block max-w-full truncate text-left text-[15px] font-semibold text-foreground transition-colors hover:text-ember"
                    >
                      {video.title}
                    </button>
                    <p className="mt-1 flex items-center gap-2 truncate font-mono text-[13px] text-muted-foreground">
                      <span className="truncate">{video.id}</span>
                      <span aria-hidden="true" className="text-faint-foreground">
                        ·
                      </span>
                      <span className="shrink-0">
                        {video.playbackPolicy === "signed" ? "Signed" : "Public"}
                      </span>
                    </p>
                  </div>
                </div>

                <div
                  className={cn(
                    "flex items-center gap-2 text-[13px] font-medium",
                    status.text,
                  )}
                >
                  <span
                    className={cn("dash-dot", status.dot)}
                    aria-hidden="true"
                  />
                  {status.label}
                </div>

                <div className="font-mono text-[13px] text-muted-foreground">
                  {formatDuration(video.duration)}
                </div>

                <div className="text-[13px] text-muted-foreground">
                  {formatRelativeTime(video.createdAt)}
                </div>

                <div className="flex justify-end">
                  <VideoActions
                    video={video}
                    onCopyId={handleCopyId}
                    onEmbed={onEmbed}
                    onDelete={onDelete}
                    onViewDetails={onViewDetails}
                    openUpward={index >= videos.length - 3}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Mobile cards */}
      <ul className="divide-y divide-border-soft md:hidden">
        {videos.map((video, index) => {
          const status = statusConfig[video.status];

          return (
            <li key={video.id} className="p-4">
              <div className="flex items-start gap-3">
                <VideoThumbnail video={video} className="w-24" />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onViewDetails?.(video)}
                    className="block w-full truncate text-left text-[15px] font-semibold text-foreground"
                  >
                    {video.title}
                  </button>
                  <p
                    className={cn(
                      "mt-1.5 flex items-center gap-2 text-[13px] font-medium",
                      status.text,
                    )}
                  >
                    <span
                      className={cn("dash-dot", status.dot)}
                      aria-hidden="true"
                    />
                    {status.label}
                  </p>
                  <p className="mt-1 font-mono text-[13px] text-muted-foreground">
                    {formatDuration(video.duration)} ·{" "}
                    {formatRelativeTime(video.createdAt)}
                  </p>
                </div>
                <VideoActions
                  video={video}
                  onCopyId={handleCopyId}
                  onEmbed={onEmbed}
                  onDelete={onDelete}
                  onViewDetails={onViewDetails}
                  openUpward={index >= videos.length - 2}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
