"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import { useActiveOrganization } from "@/lib/auth-client";
import { DashboardPageHeader } from "@/components/dashboard/page-header";
import { DashboardOverviewSkeleton } from "@/components/dashboard/page-skeletons";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { VideosTable, Video } from "@/components/dashboard/videos-table";
import { Button } from "@/components/ui/button";

const API_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";
const VIDEOS_PER_PAGE = 10;

interface UsageSummary {
  storage: {
    billedGB: number;
  };
}

interface BandwidthSummary {
  bandwidth: {
    totalGB: number;
  };
}

export default function DashboardPage() {
  const router = useRouter();
  const { data: activeOrg } = useActiveOrganization();
  const [videos, setVideos] = React.useState<Video[]>([]);
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [bandwidth, setBandwidth] = React.useState<BandwidthSummary | null>(
    null
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [videoToDelete, setVideoToDelete] = React.useState<Video | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(1);

  const fetchDashboardData = React.useCallback(
    async (showLoadingState = false) => {
      if (!activeOrg) {
        setLoading(false);
        return;
      }

      if (showLoadingState) {
        setLoading(true);
      }

      try {
        const [videosRes, usageRes, bandwidthRes] = await Promise.all([
          fetch(`${API_URL}/video`, {
            credentials: "include",
          }),
          fetch(`${API_URL}/usage`, {
            credentials: "include",
          }),
          fetch(`${API_URL}/usage/bandwidth?days=30`, {
            credentials: "include",
          }),
        ]);

        if (!videosRes.ok) throw new Error("Failed to fetch videos");
        if (!usageRes.ok) throw new Error("Failed to fetch usage data");

        const videosData = await videosRes.json();
        const usageData = (await usageRes.json()) as UsageSummary;

        setVideos(videosData.videos || []);
        setUsage(usageData);

        if (bandwidthRes.ok) {
          const bandwidthData =
            (await bandwidthRes.json()) as BandwidthSummary;
          setBandwidth(bandwidthData);
        } else {
          setBandwidth(null);
        }

        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load dashboard"
        );
      } finally {
        if (showLoadingState) {
          setLoading(false);
        }
      }
    },
    [activeOrg]
  );

  React.useEffect(() => {
    void fetchDashboardData(true);
  }, [fetchDashboardData]);

  // Calculate stats from videos
  const readyCount = videos.filter((video) => video.status === "ready").length;
  const processingCount = videos.filter(
    (video) => video.status === "processing" || video.status === "uploading"
  ).length;
  const filteredVideos = videos.filter((video) =>
    video.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalPages = Math.max(
    1,
    Math.ceil(filteredVideos.length / VIDEOS_PER_PAGE)
  );
  const paginatedVideos = filteredVideos.slice(
    (currentPage - 1) * VIDEOS_PER_PAGE,
    currentPage * VIDEOS_PER_PAGE
  );
  const rangeStart =
    filteredVideos.length === 0 ? 0 : (currentPage - 1) * VIDEOS_PER_PAGE + 1;
  const rangeEnd = Math.min(
    currentPage * VIDEOS_PER_PAGE,
    filteredVideos.length
  );

  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  React.useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
  };

  const handleEmbed = (video: Video) => {
    router.push(`/dashboard/videos/${video.id}?tab=embed`);
  };

  const handleDelete = async () => {
    if (!videoToDelete) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`${API_URL}/video/${videoToDelete.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to delete video");

      setVideoToDelete(null);
      await fetchDashboardData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete video");
    } finally {
      setIsDeleting(false);
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
        storageUsed={usage?.storage.billedGB ?? 0}
        bandwidth={bandwidth?.bandwidth.totalGB ?? null}
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
          videos={paginatedVideos}
          onCopyId={handleCopyId}
          onEmbed={handleEmbed}
          onDelete={setVideoToDelete}
          onViewDetails={handleViewDetails}
        />

        {filteredVideos.length > 0 && (
          <div className="flex flex-col gap-5 sm:gap-3 rounded-sm px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-muted-foreground">
              Showing {rangeStart}-{rangeEnd} of {filteredVideos.length} videos
            </p>
            <div className="min-w-[88px] rounded-sm font-medium bg-muted/30 px-3 py-1 text-center text-xs text-foreground/50">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex md:flex-row flex-col sm:w-fit w-full items-center gap-2 self-end sm:self-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                disabled={currentPage === 1}
                className="rounded-sm sm:w-fit w-full border hover:border-mauve-300/40 hover:bg-muted border-mauve-300/60"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentPage((page) => Math.min(totalPages, page + 1))
                }
                disabled={currentPage === totalPages}
                className="rounded-sm sm:w-fit w-full bg-accent/50 hover:bg-accent/60"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {videoToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="glass mx-4 w-full max-w-md rounded-sm p-4 md:p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-destructive/20">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <h2 className="text-xl font-bold text-foreground">
                Delete Video
              </h2>
            </div>
            <p className="mb-6 text-muted-foreground">
              Are you sure you want to delete &quot;{videoToDelete.title}
              &quot;? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => setVideoToDelete(null)}
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
    </div>
  );
}
