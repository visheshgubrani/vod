"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2 } from "lucide-react";
import { useActiveOrganization } from "@/lib/auth-client";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { VideosTable, Video } from "@/components/dashboard/videos-table";
import { VideoDetailModal } from "@/components/dashboard/video-detail-modal";
import { Button } from "@/components/ui/button";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

export default function DashboardPage() {
    const router = useRouter();
    const { data: activeOrg } = useActiveOrganization();
    const [videos, setVideos] = React.useState<Video[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [selectedVideo, setSelectedVideo] = React.useState<Video | null>(null);

    // Fetch videos from API
    const fetchVideos = React.useCallback(async () => {
        if (!activeOrg) return;
        
        try {
            const res = await fetch(`${API_URL}/video`, {
                credentials: "include",
            });
            
            if (!res.ok) throw new Error("Failed to fetch videos");
            
            const data = await res.json();
            setVideos(data.videos || []);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load videos");
        } finally {
            setLoading(false);
        }
    }, [activeOrg]);

    React.useEffect(() => {
        fetchVideos();
    }, [fetchVideos]);

    // Calculate stats from videos
    const readyCount = videos.filter((v) => v.status === "ready").length;
    const processingCount = videos.filter((v) => v.status === "processing" || v.status === "uploading").length;

    const handleCopyId = (id: string) => {
        navigator.clipboard.writeText(id);
    };

    const handleEmbed = (video: Video) => {
        setSelectedVideo(video);
    };

    const handleDelete = async (video: Video) => {
        if (!confirm(`Are you sure you want to delete "${video.title}"?`)) return;
        
        try {
            const res = await fetch(`${API_URL}/video/${video.id}`, {
                method: "DELETE",
                credentials: "include",
            });
            
            if (!res.ok) throw new Error("Failed to delete video");
            
            // Refresh videos list
            fetchVideos();
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to delete video");
        }
    };

    const handleViewDetails = (video: Video) => {
        setSelectedVideo(video);
    };

    const handleCloseModal = () => {
        setSelectedVideo(null);
    };

    const handleVideoUpdate = () => {
        fetchVideos();
        setSelectedVideo(null);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
        );
    }

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

            {/* Error Banner */}
            {error && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                    {error}
                </div>
            )}

            {/* Stats Cards */}
            <StatsCards
                storageUsed={0}
                storageTotal={100}
                bandwidth={0}
                totalVideos={readyCount}
                processingVideos={processingCount}
            />

            {/* Recent Videos Section */}
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">Videos</h2>
                </div>

                <VideosTable
                    videos={videos}
                    onCopyId={handleCopyId}
                    onEmbed={handleEmbed}
                    onDelete={handleDelete}
                    onViewDetails={handleViewDetails}
                />
            </div>

            {/* Video Detail Modal */}
            {selectedVideo && (
                <VideoDetailModal
                    video={selectedVideo}
                    onClose={handleCloseModal}
                    onUpdate={handleVideoUpdate}
                />
            )}
        </div>
    );
}
