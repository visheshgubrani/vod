"use client";

import * as React from "react";
import {
    MoreHorizontal,
    Copy,
    Code,
    Trash2,
    ExternalLink,
    Play,
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
        className: "bg-emerald-500",
    },
    processing: {
        label: "Processing",
        className: "bg-amber-500 animate-pulse",
    },
    uploading: {
        label: "Uploading",
        className: "bg-blue-500 animate-pulse",
    },
    pending: {
        label: "Pending",
        className: "bg-slate-500",
    },
    error: {
        label: "Error",
        className: "bg-red-500",
    },
    failed: {
        label: "Failed",
        className: "bg-red-500",
    },
};

function formatDuration(seconds?: number): string {
    if (!seconds) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatRelativeTime(date: Date | string): string {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - dateObj.getTime()) / 1000);

    if (diffInSeconds < 60) return "Just now";
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} min ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;

    return dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
            <div className="flex flex-col items-center justify-center py-16 px-4 border border-dashed border-border rounded-2xl bg-card/30">
                <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                    <Play className="w-8 h-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-1">No videos yet</h3>
                <p className="text-sm text-muted-foreground text-center max-w-sm">
                    Upload your first video to get started. Your videos will appear here.
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-2xl border border-border bg-card/50 backdrop-blur-sm">
            {/* Table Header */}
            <div className="grid grid-cols-[auto_1fr_100px_120px_auto] gap-4 px-4 py-3 border-b border-border bg-muted/30 text-sm font-medium text-muted-foreground">
                <div className="w-6">Status</div>
                <div>Video</div>
                <div>Duration</div>
                <div>Created</div>
                <div className="w-10"></div>
            </div>

            {/* Table Body */}
            <div className="divide-y divide-border">
                {videos.map((video) => {
                    const status = statusConfig[video.status];

                    return (
                        <div
                            key={video.id}
                            className="grid grid-cols-[auto_1fr_100px_120px_auto] gap-4 px-4 py-3 items-center hover:bg-muted/20 transition-colors group"
                        >
                            {/* Status */}
                            <div className="flex items-center justify-center w-6">
                                <div
                                    className={cn("w-2.5 h-2.5 rounded-full", status.className)}
                                    title={status.label}
                                />
                            </div>

                            {/* Video Info */}
                            <div className="flex items-center gap-3 min-w-0">
                                {/* Thumbnail */}
                                <div className="w-16 h-9 rounded-lg bg-muted/50 overflow-hidden flex-shrink-0 border border-border">
                                    {video.thumbnailUrl ? (
                                        <img
                                            src={video.thumbnailUrl}
                                            alt={video.title}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <Play className="w-4 h-4 text-muted-foreground" />
                                        </div>
                                    )}
                                </div>

                                {/* Title */}
                                <button
                                    onClick={() => onViewDetails?.(video)}
                                    className="text-sm font-medium text-foreground hover:text-primary transition-colors truncate text-left"
                                >
                                    {video.title}
                                </button>
                            </div>

                            {/* Duration */}
                            <div className="text-sm text-muted-foreground font-mono">
                                {formatDuration(video.duration)}
                            </div>

                            {/* Created */}
                            <div className="text-sm text-muted-foreground">
                                {formatRelativeTime(video.createdAt)}
                            </div>

                            {/* Actions */}
                            <div className="flex items-center justify-end w-10">
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100">
                                            <MoreHorizontal className="w-4 h-4" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => handleCopyId(video.id)}>
                                            <Copy className="w-4 h-4" />
                                            Copy ID
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => onEmbed?.(video)}>
                                            <Code className="w-4 h-4" />
                                            Get Embed Code
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => onViewDetails?.(video)}>
                                            <ExternalLink className="w-4 h-4" />
                                            View Details
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={() => onDelete?.(video)}
                                            destructive
                                        >
                                            <Trash2 className="w-4 h-4" />
                                            Delete
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
