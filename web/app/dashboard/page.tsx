"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { VideosTable, Video } from "@/components/dashboard/videos-table";
import { Button } from "@/components/ui/button";

// Mock data - in real app, fetch from API
const mockVideos: Video[] = [
    {
        id: "vid_abc123",
        title: "Introduction to Go Programming",
        status: "ready",
        thumbnailUrl: undefined,
        duration: 600, // 10:00
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    },
    {
        id: "vid_def456",
        title: "Docker Tutorial for Beginners",
        status: "ready",
        thumbnailUrl: undefined,
        duration: 930, // 15:30
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
    },
    {
        id: "vid_ghi789",
        title: "Kubernetes Deep Dive - Part 1",
        status: "processing",
        thumbnailUrl: undefined,
        duration: undefined,
        createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
    },
    {
        id: "vid_jkl012",
        title: "Building REST APIs with Node.js",
        status: "ready",
        thumbnailUrl: undefined,
        duration: 1245, // 20:45
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
    },
    {
        id: "vid_mno345",
        title: "React Performance Optimization",
        status: "error",
        thumbnailUrl: undefined,
        duration: undefined,
        createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    },
];

export default function DashboardPage() {
    const [videos] = React.useState<Video[]>(mockVideos);

    // Calculate stats from videos
    const processingCount = videos.filter((v) => v.status === "processing").length;

    const handleCopyId = (id: string) => {
        // Could show a toast notification here
        console.log("Copied video ID:", id);
    };

    const handleEmbed = (video: Video) => {
        console.log("Get embed code for:", video.title);
    };

    const handleDelete = (video: Video) => {
        console.log("Delete video:", video.title);
    };

    const handleViewDetails = (video: Video) => {
        console.log("View details:", video.id);
    };

    return (
        <div className="space-y-8 max-w-6xl">
            {/* Page Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
                    <p className="text-muted-foreground mt-1">
                        Manage your videos and monitor usage
                    </p>
                </div>
            </div>

            {/* Stats Cards */}
            <StatsCards
                storageUsed={12.5}
                storageTotal={100}
                bandwidth={450}
                totalVideos={videos.filter((v) => v.status === "ready").length}
                processingVideos={processingCount}
            />

            {/* Recent Videos Section */}
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">Recent Videos</h2>
                    <Button variant="outline" size="sm">
                        <Plus className="w-4 h-4 mr-1" />
                        Upload
                    </Button>
                </div>

                <VideosTable
                    videos={videos}
                    onCopyId={handleCopyId}
                    onEmbed={handleEmbed}
                    onDelete={handleDelete}
                    onViewDetails={handleViewDetails}
                />
            </div>
        </div>
    );
}
