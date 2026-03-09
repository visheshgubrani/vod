"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useActiveOrganization } from "@/lib/auth-client";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardOverviewSkeleton } from "@/components/dashboard/page-skeletons";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { VideosTable, Video } from "@/components/dashboard/videos-table";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

export default function DashboardPage() {
  const router = useRouter();
  const { data: activeOrg } = useActiveOrganization();
  const [videos, setVideos] = React.useState<Video[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");

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
  const processingCount = videos.filter(
    (v) => v.status === "processing" || v.status === "uploading"
  ).length;
  const filteredVideos = videos.filter((video) =>
    video.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
  };

  const handleEmbed = (video: Video) => {
    router.push(`/dashboard/videos/${video.id}?tab=embed`);
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
    router.push(`/dashboard/videos/${video.id}`);
  };

  if (loading) {
    return <DashboardOverviewSkeleton />;
  }

  return (
    <div className="w-full space-y-8">
      {/* Page Header */}
      <DashboardPageHeader
        title="Dashboard"
        description="Manage your videos and monitor usage"
      />

      {/* Error Banner */}
      {error && (
        <div className="p-3 rounded-sm bg-destructive/10 border border-destructive/20 text-destructive text-sm">
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
      <div className="pt-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold text-foreground">Videos</h2>
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search videos"
              className="h-10 w-full rounded-sm border border-border bg-card/60 pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/40"
            />
          </div>
        </div>

        <VideosTable
          videos={filteredVideos}
          onCopyId={handleCopyId}
          onEmbed={handleEmbed}
          onDelete={handleDelete}
          onViewDetails={handleViewDetails}
        />
      </div>
    </div>
  );
}
