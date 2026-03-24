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

const statusConfig = {
  ready: {
    label: "Ready",
    className: "bg-lime-500",
  },
  processing: {
    label: "Processing",
    className: "bg-amber-400 animate-pulse",
  },
  uploading: {
    label: "Uploading",
    className: "bg-cyan-500 animate-pulse",
  },
  pending: {
    label: "Pending",
    className: "bg-slate-500",
  },
  error: {
    label: "Error",
    className: "bg-red-400",
  },
  failed: {
    label: "Failed",
    className: "bg-red-400",
  },
};

function VideoThumbnail({ video }: { video: Video }) {
  return (
    <div className="h-10 w-16 flex-shrink-0 overflow-hidden rounded-sm border border-border bg-muted/50">
      {video.playbackPolicy === "signed" ? (
        <div className="flex h-full w-full items-center justify-center bg-amber-500/10">
          <Lock className="h-4 w-4 text-amber-400" />
        </div>
      ) : video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-accent/10">
          <Play className="size-4.5 fill-pink-300/70 text-primary/40" />
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
        <button className="rounded-sm p-2 text-foreground/80 transition-colors hover:bg-muted/70 hover:text-foreground">
          <MoreVertical className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={openUpward ? "top" : "bottom"}
        className="min-w-[220px] whitespace-nowrap rounded-sm bg-muted p-1.5"
      >
        <DropdownMenuItem
          onClick={() => onCopyId(video.id)}
          className="whitespace-nowrap rounded-sm hover:bg-mauve-500/20"
        >
          <Copy className="w-4 h-4" />
          Copy ID
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem
          onClick={() => onEmbed?.(video)}
          className="whitespace-nowrap rounded-sm hover:bg-mauve-500/20"
        >
          <Code className="w-4 h-4" />
          Get Embed Code
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem
          onClick={() => onViewDetails?.(video)}
          className="whitespace-nowrap rounded-sm hover:bg-mauve-500/20"
        >
          <ExternalLink className="w-4 h-4" />
          View Details
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem
          onClick={() => onDelete?.(video)}
          destructive
          className="whitespace-nowrap rounded-sm"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - dateObj.getTime()) / 1000);

  if (diffInSeconds < 60) return "Just now";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} min ago`;
  if (diffInSeconds < 86400)
    return `${Math.floor(diffInSeconds / 3600)} hours ago`;
  if (diffInSeconds < 604800)
    return `${Math.floor(diffInSeconds / 86400)} days ago`;

  return dateObj.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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
      <div className="flex flex-col items-center justify-center rounded-sm border border-dashed border-border bg-card/30 px-4 py-16">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-mauve-300/20 bg-muted/50">
          <Play className="w-8 h-8 fill-muted-foreground text-muted-foreground" />
        </div>
        <h3 className="text-lg md:text-2xl mt-3 font-semibold text-foreground mb-1">
          No videos yet
        </h3>
        <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
          Upload your first video to get started. Your videos will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-card/50 backdrop-blur-sm">
      <div className="hidden md:block">
        {/* Table Header */}
        <div className="grid grid-cols-[52px_1fr_100px_120px_auto] gap-6 border-b border-border bg-muted/30 px-4 py-3 text-sm font-semibold text-muted-foreground">
          <div className="w-6">Status</div>
          <div>Video</div>
          <div>Duration</div>
          <div>Created</div>
          <div className="w-10"></div>
        </div>

        {/* Table Body */}
        <div className="divide-y divide-border">
          {videos.map((video, index) => {
            const status = statusConfig[video.status];
            const openUpward = index >= videos.length - 3;

            return (
              <div
                key={video.id}
                className="grid grid-cols-[52px_1fr_100px_120px_auto] items-center gap-6 px-4 py-3 transition-colors"
              >
                <div className="flex w-6 items-center justify-center">
                  <div
                    className={cn("h-2.5 w-2.5 rounded-full", status.className)}
                    title={status.label}
                  />
                </div>

                <div className="flex min-w-0 items-center gap-3">
                  <VideoThumbnail video={video} />
                  <button
                    onClick={() => onViewDetails?.(video)}
                    className="text-left text-sm font-medium tracking-wide text-foreground transition-colors hover:text-primary"
                  >
                    {video.title}
                  </button>
                </div>

                <div className="font-mono text-sm text-muted-foreground">
                  {formatDuration(video.duration)}
                </div>

                <div className="text-sm text-muted-foreground">
                  {formatRelativeTime(video.createdAt)}
                </div>

                <div className="flex w-10 items-center justify-end">
                  <VideoActions
                    video={video}
                    onCopyId={handleCopyId}
                    onEmbed={onEmbed}
                    onDelete={onDelete}
                    onViewDetails={onViewDetails}
                    openUpward={openUpward}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="divide-y divide-border md:hidden">
        {videos.map((video, index) => {
          const status = statusConfig[video.status];
          const openUpward = index >= videos.length - 2;

          return (
            <div key={video.id} className="space-y-3 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <VideoThumbnail video={video} />
                  <div className="min-w-0">
                    <button
                      onClick={() => onViewDetails?.(video)}
                      className="block text-left text-sm font-medium tracking-wide text-foreground transition-colors hover:text-primary"
                    >
                      {video.title}
                    </button>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className={cn(
                          "h-2.5 w-2.5 rounded-full",
                          status.className
                        )}
                        title={status.label}
                      />
                      <span>{status.label}</span>
                    </div>
                  </div>
                </div>

                <VideoActions
                  video={video}
                  onCopyId={handleCopyId}
                  onEmbed={onEmbed}
                  onDelete={onDelete}
                  onViewDetails={onViewDetails}
                  openUpward={openUpward}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-sm bg-muted/20 p-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Duration</p>
                  <p className="mt-1 font-mono text-sm text-foreground">
                    {formatDuration(video.duration)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="mt-1 text-sm text-foreground">
                    {formatRelativeTime(video.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
