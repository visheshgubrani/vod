"use client";

import * as React from "react";
import { OpenVodError, OpenVodUploader, UploadAbortedError } from "@openvod/uploader";
import type { UploadProgress, UploadSession } from "@openvod/uploader";
import {
  AlertTriangle,
  Captions,
  FolderUp,
  Globe,
  ListVideo,
  Lock,
  Pause,
  Play,
  X,
} from "lucide-react";

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

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787/api";

/**
 * The public API lives at the **origin root** (`/v1/upload/...`), while
 * `NEXT_PUBLIC_API_BASE_URL` points at the dashboard's own `/api` prefix. The
 * uploader SDK takes the origin, so the suffix is stripped here rather than
 * asking the deployment for a second URL that could drift from this one.
 */
const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, "");

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

type Phase = "idle" | "uploading" | "paused" | "done" | "error";

/** Human-readable message for an `OpenVodError` code. */
function describeError(error: unknown): string {
  if (error instanceof OpenVodError) {
    switch (error.code) {
      case "UPLOADS_DISABLED":
        return "Uploads are disabled on this deployment.";
      case "UPLOAD_TOKEN_EXPIRED":
        return "The upload session expired before it started. Try again.";
      case "UPLOAD_TOKEN_EXHAUSTED":
        return "This upload session was already used. Try again.";
      case "RATE_LIMITED":
        return "Too many requests — the API is rate limiting this upload. Retry in a moment.";
      case "SIZE_MISMATCH":
      case "OBJECT_MISSING":
        return "The uploaded bytes did not arrive intact. Please upload the file again.";
      case "TOO_MANY_PARTS":
        return "This file needs more parts than the API allows.";
      case "NETWORK":
        return "Network error while uploading. Retry when the connection is back.";
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return "Upload failed.";
}

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function UploadModal({
  open,
  onClose,
  onUploadComplete,
}: UploadModalProps) {
  const [playbackPolicy, setPlaybackPolicy] = React.useState<
    "public" | "signed"
  >("public");
  const [generateSubtitle, setGenerateSubtitle] = React.useState(false);
  const [generateChapters, setGenerateChapters] = React.useState(false);

  const [file, setFile] = React.useState<File | null>(null);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState<UploadProgress | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  const sessionRef = React.useRef<UploadSession | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectFile = (next: File | null) => {
    if (!next) return;
    if (next.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setPhase("error");
      setErrorMessage(
        `That file is ${formatBytes(next.size)} — the limit is 10 GB.`
      );
      return;
    }
    setFile(next);
    setPhase("idle");
    setProgress(null);
    setErrorMessage(null);
  };

  const startUpload = async () => {
    if (!file) return;

    setPhase("uploading");
    setErrorMessage(null);

    try {
      // Session-authenticated upload token: the API key stays on the server,
      // and the browser talks to the same /v1/upload/* endpoints an external
      // integration uses.
      const tokenResponse = await fetch(`${API_BASE_URL}/upload/token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expires_in: "1h", max_files: 1 }),
      });

      if (!tokenResponse.ok) {
        const body = (await tokenResponse.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ||
            `Could not start an upload session (HTTP ${tokenResponse.status})`
        );
      }

      const { upload_token: uploadToken } = (await tokenResponse.json()) as {
        upload_token: string;
      };

      const uploader = new OpenVodUploader({
        baseUrl: API_ORIGIN,
        uploadToken,
      });

      const session = uploader.startUpload(file, {
        title: file.name,
        playbackPolicy,
        generateSubtitle,
        generateChapters: generateSubtitle && generateChapters,
        onProgress: (next) => {
          if (!mountedRef.current) return;
          setProgress(next);
        },
      });
      sessionRef.current = session;

      const result = await session.run();

      // The upload finished: drop the handle so nothing can cancel it.
      // `/complete` has already claimed the row and dispatched a transcode job
      // against the object, so a late abort would destroy both.
      sessionRef.current = null;

      if (!mountedRef.current) return;
      setPhase("done");
      onUploadComplete?.(result.fileId, result.key);
      onClose();
    } catch (error) {
      sessionRef.current = null;
      if (!mountedRef.current) return;

      if (error instanceof UploadAbortedError) {
        setPhase("idle");
        setProgress(null);
        return;
      }

      setPhase("error");
      setErrorMessage(describeError(error));
    }
  };

  const cancelUpload = async () => {
    const session = sessionRef.current;
    sessionRef.current = null;

    // Abandoning the multipart upload also deletes the video row — abandoned
    // parts are billed by storage until they are removed.
    await session?.cancel().catch(() => undefined);

    if (!mountedRef.current) return;
    setPhase("idle");
    setProgress(null);
  };

  const reset = () => {
    setFile(null);
    setPhase("idle");
    setProgress(null);
    setErrorMessage(null);
  };

  const percent = progress?.percentage ?? 0;
  const isBusy = phase === "uploading" || phase === "paused";

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
              disabled={isBusy}
              onClick={() => setPlaybackPolicy("public")}
              className={cn(
                "flex flex-1 flex-col items-start gap-1 rounded-sm px-3 py-2 text-left text-sm font-medium transition-all",
                playbackPolicy === "public"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-black/70 text-muted-foreground hover:text-foreground",
                isBusy && "cursor-not-allowed opacity-70"
              )}
            >
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4" />
                <span>Public</span>
              </div>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setPlaybackPolicy("signed")}
              className={cn(
                "flex flex-1 flex-col items-start gap-1 rounded-sm px-3 py-2 text-left text-sm font-medium transition-all",
                playbackPolicy === "signed"
                  ? "bg-primary text-white shadow-sm"
                  : "bg-black/70 text-muted-foreground hover:text-foreground",
                isBusy && "cursor-not-allowed opacity-70"
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
          onClick={() => {
            if (isBusy) return;
            const next = !generateSubtitle;
            setGenerateSubtitle(next);
            // Chapters are derived from the transcript, so they cannot outlive
            // subtitles. Enforced here rather than in an effect that would
            // re-render on every toggle.
            if (!next) setGenerateChapters(false);
          }}
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
              disabled={isBusy}
              onChange={() => {
                const next = !generateSubtitle;
                setGenerateSubtitle(next);
                if (!next) setGenerateChapters(false);
              }}
            />
          </div>
        </div>

        {/* AI Chapters Toggle */}
        <div
          className={cn(
            "flex items-center justify-between gap-4 rounded-sm border border-border bg-muted-foreground/20 p-4 transition-colors",
            generateSubtitle && !isBusy
              ? "cursor-pointer"
              : "opacity-50 cursor-not-allowed"
          )}
          onClick={() =>
            generateSubtitle && !isBusy && setGenerateChapters(!generateChapters)
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
              disabled={!generateSubtitle || isBusy}
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

          {/* Drop zone / picker */}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!isBusy) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              if (isBusy) return;
              const dropped = event.dataTransfer.files?.[0];
              if (dropped) selectFile(dropped);
            }}
            className={cn(
              "flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-sm border border-dashed border-border bg-black/40 p-6 text-center transition-colors",
              isDragging && "border-primary bg-primary/10"
            )}
          >
            {file ? (
              <div className="w-full space-y-3">
                <div className="flex items-start justify-between gap-3 text-left">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                      {progress && progress.partsTotal > 0
                        ? ` • part ${progress.partsCompleted}/${progress.partsTotal}`
                        : ""}
                    </p>
                  </div>
                  {!isBusy && (
                    <button
                      type="button"
                      onClick={reset}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      aria-label="Remove file"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>

                {(isBusy || phase === "done") && (
                  <div className="space-y-2">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-black/50">
                      <div
                        className="h-full rounded-full bg-lime-500/80 transition-[width]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {phase === "paused"
                          ? "Paused"
                          : phase === "done"
                            ? "Uploaded"
                            : progress?.phase === "completing"
                              ? "Finishing…"
                              : "Uploading…"}
                      </span>
                      <span>
                        {percent}% • {formatBytes(progress?.bytesUploaded ?? 0)} /{" "}
                        {formatBytes(progress?.bytesTotal ?? file.size)}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {phase === "idle" && (
                    <button
                      type="button"
                      onClick={startUpload}
                      className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                    >
                      Upload
                    </button>
                  )}
                  {phase === "uploading" && (
                    <button
                      type="button"
                      onClick={() => sessionRef.current?.pause()}
                      className="inline-flex items-center gap-2 rounded-sm bg-black/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-black/50"
                    >
                      <Pause className="size-4" />
                      Pause
                    </button>
                  )}
                  {phase === "paused" && (
                    <button
                      type="button"
                      onClick={() => sessionRef.current?.resume()}
                      className="inline-flex items-center gap-2 rounded-sm bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                    >
                      <Play className="size-4" />
                      Resume
                    </button>
                  )}
                  {isBusy && (
                    <button
                      type="button"
                      onClick={cancelUpload}
                      className="rounded-sm border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <FolderUp className="size-6 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="rounded-sm bg-accent px-3 py-2 text-sm font-medium text-foreground transition-opacity hover:opacity-90"
                >
                  browse files
                </button>
                <p className="text-xs text-muted-foreground/70">
                  MP4, MOV, WebM, MKV
                </p>
              </>
            )}

            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null;
                event.target.value = "";
                selectFile(picked);
              }}
            />
          </div>

          {errorMessage && (
            <div className="mt-3 flex items-start gap-2 rounded-sm border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground/60">
          Videos will be transcoded after upload for optimal streaming
          {playbackPolicy === "signed" && " • AES-128 encrypted"}
          {generateSubtitle && " • AI subtitles"}
          {generateChapters && " • AI chapters"}
        </p>
        {isBusy && (
          <p className="text-center text-xs text-muted-foreground/50">
            Closing this panel does not stop the upload.
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
