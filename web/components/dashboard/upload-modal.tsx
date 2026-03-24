"use client";

import * as React from "react";
import Uppy, { UppyFile, Meta, Body } from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import Dashboard from "@uppy/dashboard";
import { Lock, Globe, Captions, ListVideo, Play } from "lucide-react";

import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";

import {
  Sheet,
  SheetHeader,
  SheetTitle,
  SheetContent,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploadComplete?: (fileId: string, key: string) => void;
}

interface CustomMeta extends Meta {
  fileId?: string;
  key?: string;
  partSize?: number;
  partCount?: number;
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000/api";

function ToggleSwitch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-6 w-11 rounded-full transition-colors",
        checked ? "bg-lime-600/75" : "bg-black/70",
        disabled && "cursor-not-allowed opacity-50"
      )}
      aria-pressed={checked}
    >
      <span
        className={cn(
          "absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform",
          checked && "translate-x-5"
        )}
      />
    </button>
  );
}

export function UploadModal({
  open,
  onClose,
  onUploadComplete,
}: UploadModalProps) {
  const dashboardRef = React.useRef<HTMLDivElement>(null);
  const uppyRef = React.useRef<Uppy<CustomMeta, Body> | null>(null);
  const [playbackPolicy, setPlaybackPolicy] = React.useState<
    "public" | "signed"
  >("public");
  const [generateSubtitle, setGenerateSubtitle] = React.useState(false);
  const [generateChapters, setGenerateChapters] = React.useState(false);

  // Store in refs so they're accessible in Uppy callbacks
  const playbackPolicyRef = React.useRef(playbackPolicy);
  const generateSubtitleRef = React.useRef(generateSubtitle);
  const generateChaptersRef = React.useRef(generateChapters);
  React.useEffect(() => {
    playbackPolicyRef.current = playbackPolicy;
  }, [playbackPolicy]);
  React.useEffect(() => {
    generateSubtitleRef.current = generateSubtitle;
  }, [generateSubtitle]);
  React.useEffect(() => {
    generateChaptersRef.current = generateChapters;
  }, [generateChapters]);
  // Auto-disable chapters if subtitles are disabled (chapters require transcription)
  React.useEffect(() => {
    if (!generateSubtitle && generateChapters) {
      setGenerateChapters(false);
    }
  }, [generateSubtitle, generateChapters]);

  React.useEffect(() => {
    if (!open || !dashboardRef.current) return;

    // Initialize Uppy
    const uppy = new Uppy<CustomMeta, Body>({
      id: "uploader",
      autoProceed: false,
      restrictions: {
        maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
        allowedFileTypes: ["video/*"],
      },
    });

    // Configure AWS S3 multipart upload with custom endpoints
    uppy.use(AwsS3, {
      id: "AwsS3",
      shouldUseMultipart: (file: UppyFile<CustomMeta, Body>) =>
        (file.size ?? 0) > 100 * 1024 * 1024, // Use multipart for files > 100MB

      // For small files - single PUT upload
      async getUploadParameters(file: UppyFile<CustomMeta, Body>) {
        const response = await fetch(`${API_BASE_URL}/upload/url`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            size: file.size,
            playbackPolicy: playbackPolicyRef.current,
            generateSubtitle: generateSubtitleRef.current,
            generateChapters: generateChaptersRef.current,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to get upload URL");
        }

        const data = await response.json();

        // Store fileId and key for later use
        if (file.meta) {
          file.meta.fileId = data.fileId;
          file.meta.key = data.key;
        }

        return {
          method: "PUT" as const,
          url: data.uploadUrl,
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
        };
      },

      // For large files - multipart upload
      async createMultipartUpload(file: UppyFile<CustomMeta, Body>) {
        const response = await fetch(
          `${API_BASE_URL}/upload/multipart/create`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filename: file.name,
              contentType: file.type,
              size: file.size,
              playbackPolicy: playbackPolicyRef.current,
              generateSubtitle: generateSubtitleRef.current,
              generateChapters: generateChaptersRef.current,
            }),
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to create multipart upload");
        }

        const data = await response.json();

        // Store metadata for later
        if (file.meta) {
          file.meta.fileId = data.fileId;
          file.meta.key = data.key;
          file.meta.partSize = data.partSize;
          file.meta.partCount = data.partCount;
        }

        return {
          uploadId: data.uploadId,
          key: data.key,
        };
      },

      async listParts() {
        // Not implementing resume functionality for now
        return [];
      },

      async signPart(file: UppyFile<CustomMeta, Body>, partData) {
        const { uploadId, key, partNumber } = partData;

        const response = await fetch(`${API_BASE_URL}/upload/multipart/parts`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            key,
            uploadId,
            partNumbers: [partNumber],
            size: file.size,
            partSize: file.meta?.partSize,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to get part upload URL");
        }

        const data = await response.json();
        const partInfo = data.urls[0];

        return {
          url: partInfo.url,
          headers: {},
        };
      },

      async completeMultipartUpload(
        file: UppyFile<CustomMeta, Body>,
        { uploadId, key, parts }
      ) {
        const response = await fetch(
          `${API_BASE_URL}/upload/multipart/complete`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              key,
              uploadId,
              fileId: file.meta?.fileId,
              parts: parts.map((part) => ({
                partNumber: part.PartNumber,
                etag: part.ETag,
              })),
            }),
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to complete upload");
        }

        const data = await response.json();
        return { location: data.location };
      },

      async abortMultipartUpload(
        file: UppyFile<CustomMeta, Body>,
        { uploadId, key }
      ) {
        await fetch(`${API_BASE_URL}/upload/multipart/abort`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            key,
            uploadId,
            fileId: file.meta?.fileId,
          }),
        });
      },
    });

    // Use Dashboard UI
    uppy.use(Dashboard, {
      target: dashboardRef.current,
      inline: true,
      width: "100%",
      height: 350,
      proudlyDisplayPoweredByUppy: false,
      theme: "dark",
      note: "Video files up to 10GB. MP4, MOV, WebM, MKV supported.",
      locale: {
        strings: {
          dropPasteFiles: "Drop video files here or %{browseFiles}",
          browseFiles: "browse files",
        },
      },
    });

    // Handle individual file upload success (for single-file uploads, call /complete)
    uppy.on("upload-success", async (file, response) => {
      console.log("upload-success event fired", { file, response });
      if (!file) return;

      const meta = file.meta as CustomMeta;
      const fileId = meta?.fileId;

      // Only call /complete for single-file uploads (non-multipart)
      // Multipart uploads have their own completeMultipartUpload callback
      const isMultipart = (file.size ?? 0) > 100 * 1024 * 1024;

      if (fileId && !isMultipart) {
        try {
          const result = await fetch(`${API_BASE_URL}/upload/complete`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ fileId }),
          });
        } catch (err) {
          console.error("Failed to mark upload as complete:", err);
        }
      }
    });

    // Handle upload complete
    uppy.on("complete", (result) => {
      if (result.successful && result.successful.length > 0) {
        result.successful.forEach((file) => {
          const fileId = (file.meta as CustomMeta)?.fileId;
          const key = (file.meta as CustomMeta)?.key;
          if (fileId && key) {
            onUploadComplete?.(fileId, key);
          }
        });
        onClose();
      }
    });

    // Handle errors
    uppy.on("error", (error) => {
      console.error("Uppy error:", error);
    });

    // Handle file removal/cancel - delete from backend
    uppy.on("file-removed", async (file: UppyFile<CustomMeta, Body>) => {
      const meta = file.meta as CustomMeta;
      const fileId = meta?.fileId;

      // If file had a fileId, delete the record from backend
      // This handles both single-file and multipart uploads
      if (fileId) {
        try {
          await fetch(`${API_BASE_URL}/upload/${fileId}`, {
            method: "DELETE",
            credentials: "include",
          });
          console.log(`Deleted canceled upload: ${fileId}`);
        } catch (err) {
          console.error("Failed to delete upload:", err);
        }
      }
    });

    uppyRef.current = uppy;

    return () => {
      uppy.cancelAll();
      uppy.destroy();
      uppyRef.current = null;
    };
  }, [open, onUploadComplete]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      className="max-w-md sm:max-w-xl xl:max-w-2xl"
    >
      <SheetHeader className="bg-card">
        <SheetTitle>Upload Videos</SheetTitle>
      </SheetHeader>
      <SheetContent className="space-y-4 sm:space-y-5">
        {/* Playback Policy Selector */}
        <div className="flex flex-col gap-4 rounded-sm border border-border bg-muted-foreground/20 p-4">
          <div className="flex flex-col">
            <p className="text-sm font-medium text-foreground mb-1">
              Playback Policy
            </p>
            <p className="text-xs text-muted-foreground">
              {playbackPolicy === "public"
                ? "Anyone with the URL can view this video"
                : "Requires signed token for playback"}
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-sm border border-border bg-muted/30 p-1 sm:flex-row">
            <button
              type="button"
              onClick={() => setPlaybackPolicy("public")}
              className={cn(
                "flex flex-1 flex-col items-start gap-1 rounded-sm px-3 py-2 text-left text-sm font-medium transition-all",
                playbackPolicy === "public"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-black/70 text-muted-foreground hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4" />
                <span>Public</span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setPlaybackPolicy("signed")}
              className={cn(
                "flex flex-1 flex-col items-start gap-1 rounded-sm px-3 py-2 text-left text-sm font-medium transition-all",
                playbackPolicy === "signed"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-black/70 text-muted-foreground hover:text-foreground"
              )}
            >
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4" />
                <span>Signed</span>
              </div>
            </button>
          </div>
        </div>

        {/* AI Subtitles Toggle */}
        <div
          className="flex items-center justify-between gap-4 rounded-sm border border-border bg-muted-foreground/20 p-4 transition-colors"
          onClick={() => setGenerateSubtitle(!generateSubtitle)}
        >
          <div className="flex flex-1 items-stretch gap-3">
            <div className="flex min-h-full w-11 shrink-0 items-center justify-center rounded-sm bg-black/40">
              <Captions className="size-5.5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <p className="mb-1 text-sm font-medium text-foreground">
                AI Subtitles
              </p>
              <p className="text-xs text-muted-foreground">
                {generateSubtitle
                  ? "Subtitles will be auto-generated using AI"
                  : "No subtitles will be generated"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ToggleSwitch
              checked={generateSubtitle}
              onChange={() => setGenerateSubtitle(!generateSubtitle)}
            />
          </div>
        </div>

        {/* AI Chapters Toggle */}
        <div
          className={cn(
            "flex items-center justify-between gap-4 rounded-sm border border-border bg-muted-foreground/20 p-4 transition-colors",
            generateSubtitle
              ? "cursor-pointer"
              : "opacity-50 cursor-not-allowed"
          )}
          onClick={() =>
            generateSubtitle && setGenerateChapters(!generateChapters)
          }
        >
          <div className="flex flex-1 items-stretch gap-3">
            <div className="flex min-h-full w-11 shrink-0 items-center justify-center rounded-sm bg-black/40">
              <ListVideo className="size-5.5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <p className="mb-1 text-sm font-medium text-foreground">
                AI Chapters
              </p>
              <p className="text-xs text-muted-foreground">
                {!generateSubtitle
                  ? "Enable AI Subtitles first (chapters require transcription)"
                  : generateChapters
                  ? "Chapters will be auto-generated from transcript"
                  : "No chapters will be generated"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ToggleSwitch
              checked={generateChapters && generateSubtitle}
              disabled={!generateSubtitle}
              onChange={() => {
                if (generateSubtitle) {
                  setGenerateChapters(!generateChapters);
                }
              }}
            />
          </div>
        </div>

        <div className="rounded-sm border border-border bg-muted/40 p-4">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex size-8.5 md:size-11 p-2 items-center justify-center rounded-full border border-muted-foreground/20 bg-card">
              <Play className="size-4 md:size-5 text-primary/80 fill-primary/80" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                Drop video files
              </p>
              <p className="mt-1 text-xs text-muted-foreground/80">
                Drag and drop files here or use the picker to upload videos up
                to 10GB.
              </p>
            </div>
          </div>

          <div
            ref={dashboardRef}
            className={cn(
              "uppy-container rounded-sm overflow-hidden",
              "[&_.uppy-Dashboard-inner]:!min-h-[300px]",
              "[&_.uppy-Dashboard-inner]:!rounded-sm [&_.uppy-Dashboard-inner]:!border-border [&_.uppy-Dashboard-inner]:!bg-card/50",
              "[&_.uppy-Dashboard-AddFiles]:!rounded-sm [&_.uppy-Dashboard-AddFiles]:!border-border [&_.uppy-Dashboard-AddFiles]:!bg-black/40",
              "[&_.uppy-Dashboard-AddFiles]:!p-6 [&_.uppy-Dashboard-AddFiles-title]:!text-sm [&_.uppy-Dashboard-AddFiles-title]:!font-medium",
              "[&_.uppy-Dashboard-browse]:!rounded-sm [&_.uppy-Dashboard-browse]:!px-2 [&_.uppy-Dashboard-browse]:!mx-1 [&_.uppy-Dashboard-browse]:!py-2 [&_.uppy-Dashboard-browse]:!bg-accent [&_.uppy-Dashboard-browse]:!text-foreground",
              "[&_.uppy-Dashboard-note]:!text-xs [&_.uppy-Dashboard-note]:!text-muted-foreground/70",
              "[&_.uppy-StatusBar]:!mt-4 [&_.uppy-StatusBar]:!border-t [&_.uppy-StatusBar]:!border-border [&_.uppy-StatusBar]:!bg-muted/30",
              "[&_.uppy-StatusBar-actionBtn]:!h-11 [&_.uppy-StatusBar-actionBtn]:!w-40 [&_.uppy-StatusBar-actionBtn]:!rounded-sm",
              "[&_.uppy-StatusBar-actionBtn_svg]:!h-5 [&_.uppy-StatusBar-actionBtn_svg]:!w-5",
              "[&_.uppy-Dashboard-files]:!mt-4",
              "[&_.uppy-Dashboard-Item]:!w-full [&_.uppy-Dashboard-Item]:!rounded-sm [&_.uppy-Dashboard-Item]:!border-border [&_.uppy-Dashboard-Item]:!bg-lime-500/10",
              "[&_.uppy-Dashboard-Item-preview]:!w-full [&_.uppy-Dashboard-Item-previewInnerWrap]:!w-full [&_.uppy-Dashboard-Item-previewInnerWrap]:!rounded-sm [&_.uppy-Dashboard-Item-previewInnerWrap]:!bg-lime-500/10",
              "[&_.uppy-Dashboard-Item-action]:!z-10",
              "[&_.uppy-Dashboard-Item-name]:!text-foreground [&_.uppy-Dashboard-Item-status]:!text-lime-300",
              "[&_.uppy-StatusBar.is-waiting]:!bg-muted/20 [&_.uppy-StatusBar.is-uploading]:!bg-muted/20",
              "[&_.uppy-StatusBar-actionCircle]:!bg-black/10 [&_.uppy-StatusBar-actionCircle]:!shadow-none"
            )}
          />
        </div>

        <p className="text-center text-xs text-muted-foreground/60">
          Videos will be transcoded after upload for optimal streaming
          {playbackPolicy === "signed" && " • AES-128 encrypted"}
          {generateSubtitle && " • AI subtitles"}
          {generateChapters && " • AI chapters"}
        </p>
      </SheetContent>
    </Sheet>
  );
}
