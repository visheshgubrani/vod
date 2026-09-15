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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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
        title="Library"
        description="Every asset in this organization, with its processing state and playback policy."
        actions={
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Search videos</span>
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-faint-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by title"
              className="h-11 w-full rounded-[10px] border border-border bg-background pl-10 pr-3 text-[15px] text-foreground transition-colors placeholder:text-muted-foreground focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/30"
            />
          </label>
        }
      />

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-failed/35 bg-failed/10 p-4 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{error}</p>
        </div>
      )}

      {/* Stats Cards */}
      <StatsCards
        storageUsed={usage?.storage.billedGB ?? 0}
        bandwidth={bandwidth?.bandwidth.totalGB ?? null}
        totalVideos={readyCount}
        processingVideos={processingCount}
      />

      {/* Video list */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="dash-section-title text-foreground">
            {searchQuery ? "Search results" : "All videos"}
          </h2>
          <p className="dash-meta">
            {filteredVideos.length}{" "}
            {filteredVideos.length === 1 ? "asset" : "assets"}
          </p>
        </div>

        <VideosTable
          videos={paginatedVideos}
          onCopyId={handleCopyId}
          onEmbed={handleEmbed}
          onDelete={setVideoToDelete}
          onViewDetails={handleViewDetails}
        />

        {filteredVideos.length > 0 && (
          <nav
            aria-label="Pagination"
            className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="dash-meta">
              Showing{" "}
              <span className="font-mono text-foreground">
                {rangeStart}–{rangeEnd}
              </span>{" "}
              of <span className="font-mono text-foreground">{filteredVideos.length}</span>
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                disabled={currentPage === 1}
                className="flex-1 sm:flex-none"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                Previous
              </Button>
              <span className="dash-meta px-2 whitespace-nowrap">
                Page <span className="font-mono text-foreground">{currentPage}</span> of{" "}
                <span className="font-mono text-foreground">{totalPages}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCurrentPage((page) => Math.min(totalPages, page + 1))
                }
                disabled={currentPage === totalPages}
                className="flex-1 sm:flex-none"
              >
                Next
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        )}
      </div>

      <ConfirmDialog
        open={videoToDelete !== null}
        title="Delete this video?"
        description={
          <>
            <span className="font-medium text-foreground">
              {videoToDelete?.title}
            </span>{" "}
            and its transcoded outputs will be removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete video"
        busyLabel="Deleting…"
        busy={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setVideoToDelete(null)}
      />
    </div>
  );
}
