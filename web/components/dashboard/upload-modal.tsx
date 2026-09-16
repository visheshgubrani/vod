"use client";

import * as React from "react";
import { ClipMuxError, ClipMuxUploader, UploadAbortedError } from "@clipmux/uploader";
import type { UploadProgress, UploadSession } from "@clipmux/uploader";
import {
  AlertTriangle,
  Captions,
  FolderUp,
  Globe,
  ListVideo,
  Lock,
  Pause,
  Play,
  Upload,
  X,
} from "lucide-react";

import {
  Sheet,
  SheetHeader,
  SheetTitle,
  SheetContent,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { API_BASE_URL, apiOrigin } from "@/lib/api-base";
import { cn } from "@/lib/utils";

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploadComplete?: (fileId: string, key: string) => void;
}

/**
 * The public API lives at the **origin root** (`/v1/upload/...`), while
 * `NEXT_PUBLIC_API_BASE_URL` points at the dashboard's own `/api` prefix. The
 * uploader SDK takes the origin, so the suffix is stripped here rather than
 * asking the deployment for a second URL that could drift from this one.
 */
const API_ORIGIN = apiOrigin(API_BASE_URL);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

type Phase = "idle" | "uploading" | "paused" | "done" | "error";

/** Human-readable message for an `ClipMuxError` code. */
function describeError(error: unknown): string {
  if (error instanceof ClipMuxError) {
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
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-7 w-12 shrink-0 rounded-full border transition-colors",
        checked
          ? "border-brand bg-brand"
          : "border-border bg-panel-quiet",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      <span
        className={cn(
          "absolute top-1 left-1 size-4.5 rounded-full transition-transform",
          checked ? "translate-x-5 bg-white" : "bg-muted-foreground",
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
    Math.floor(Math.log(bytes) / Math.log(1024)),
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
        `That file is ${formatBytes(next.size)} — the limit is 10 GB.`,
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
            `Could not start an upload session (HTTP ${tokenResponse.status})`,
        );
      }

      const { upload_token: uploadToken } = (await tokenResponse.json()) as {
        upload_token: string;
      };

      const uploader = new ClipMuxUploader({
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

  const statusLabel =
    phase === "paused"
      ? "Paused"
      : phase === "done"
        ? "Uploaded"
        : progress?.phase === "completing"
          ? "Finishing upload"
          : progress?.phase === "initializing"
            ? "Preparing upload"
            : "Uploading";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label="Upload videos"
      className="w-full max-w-none border-l border-border sm:w-[min(44rem,100vw)]"
    >
      <SheetHeader className="pr-16">
        <SheetTitle className="text-xl">Upload videos</SheetTitle>
        <p className="dash-meta mt-1.5">
          Files go straight from this browser to your raw R2 bucket. Closing this
          panel does not stop an upload in progress.
        </p>
      </SheetHeader>

      <SheetContent className="space-y-5 p-6">
        {/* Playback policy */}
        <fieldset
          disabled={isBusy}
          className="rounded-[14px] border border-border bg-panel p-4"
        >
          <legend className="px-1 text-[15px] font-semibold text-foreground">
            Playback policy
          </legend>
          <p className="dash-meta mt-1">
            {playbackPolicy === "public"
              ? "Anyone with the playback URL can watch this video."
              : "Every playback request needs a token your backend signs."}
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={isBusy}
              aria-pressed={playbackPolicy === "public"}
              onClick={() => setPlaybackPolicy("public")}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
                playbackPolicy === "public"
                  ? "border-brand bg-brand/10"
                  : "border-border bg-panel-quiet hover:border-muted-foreground/40",
                isBusy && "cursor-not-allowed opacity-60",
              )}
            >
              <Globe
                className={cn(
                  "mt-0.5 size-5 shrink-0",
                  playbackPolicy === "public"
                    ? "text-ember"
                    : "text-muted-foreground",
                )}
                aria-hidden="true"
              />
              <span>
                <span className="block text-[15px] font-semibold text-foreground">
                  Public
                </span>
                <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                  Open HLS and DASH URLs
                </span>
              </span>
            </button>

            <button
              type="button"
              disabled={isBusy}
              aria-pressed={playbackPolicy === "signed"}
              onClick={() => setPlaybackPolicy("signed")}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
                playbackPolicy === "signed"
                  ? "border-brand bg-brand/10"
                  : "border-border bg-panel-quiet hover:border-muted-foreground/40",
                isBusy && "cursor-not-allowed opacity-60",
              )}
            >
              <Lock
                className={cn(
                  "mt-0.5 size-5 shrink-0",
                  playbackPolicy === "signed"
                    ? "text-ember"
                    : "text-muted-foreground",
                )}
                aria-hidden="true"
              />
              <span>
                <span className="block text-[15px] font-semibold text-foreground">
                  Signed
                </span>
                <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                  Token required for every request
                </span>
              </span>
            </button>
          </div>
        </fieldset>

        {/* Processing options */}
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-4 rounded-[14px] border border-border bg-panel p-4">
            <span className="flex items-start gap-3">
              <Captions
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>
                <span className="block text-[15px] font-semibold text-foreground">
                  AI subtitles
                </span>
                <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                  {generateSubtitle
                    ? "A transcript will be generated after transcoding."
                    : "No transcript will be generated."}
                </span>
              </span>
            </span>
            <ToggleSwitch
              checked={generateSubtitle}
              disabled={isBusy}
              label="Generate AI subtitles"
              onChange={() => {
                const next = !generateSubtitle;
                setGenerateSubtitle(next);
                // Chapters are derived from the transcript, so they cannot
                // outlive subtitles. Enforced here rather than in an effect that
                // would re-render on every toggle.
                if (!next) setGenerateChapters(false);
              }}
            />
          </div>

          <div
            className={cn(
              "flex items-center justify-between gap-4 rounded-[14px] border border-border bg-panel p-4",
              !generateSubtitle && "opacity-60",
            )}
          >
            <span className="flex items-start gap-3">
              <ListVideo
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>
                <span className="block text-[15px] font-semibold text-foreground">
                  AI chapters
                </span>
                <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                  {!generateSubtitle
                    ? "Turn on AI subtitles first — chapters come from the transcript."
                    : generateChapters
                      ? "Chapter markers will be generated from the transcript."
                      : "No chapters will be generated."}
                </span>
              </span>
            </span>
            <ToggleSwitch
              checked={generateChapters && generateSubtitle}
              disabled={!generateSubtitle || isBusy}
              label="Generate AI chapters"
              onChange={() => {
                if (generateSubtitle) {
                  setGenerateChapters(!generateChapters);
                }
              }}
            />
          </div>
        </div>

        {/* File picker */}
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
            "rounded-[14px] border border-dashed p-5 transition-colors",
            isDragging
              ? "border-ember bg-ember/5"
              : "border-border bg-panel-quiet",
          )}
        >
          {file ? (
            <div className="space-y-5">
              <div className="flex items-start gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-panel">
                  <Play
                    className="size-5 fill-ember text-ember"
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-foreground">
                    {file.name}
                  </p>
                  <p className="dash-meta mt-1 font-mono">
                    {formatBytes(file.size)}
                    {progress && progress.partsTotal > 0
                      ? ` · part ${progress.partsCompleted}/${progress.partsTotal}`
                      : ""}
                  </p>
                </div>
                {!isBusy && (
                  <button
                    type="button"
                    onClick={reset}
                    aria-label="Remove selected file"
                    className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-strong hover:text-foreground"
                  >
                    <X className="size-5" />
                  </button>
                )}
              </div>

              {/* Progress is only rendered once the upload flow reports it. */}
              {(isBusy || phase === "done") && progress ? (
                <div className="space-y-2.5">
                  <Progress
                    value={percent}
                    variant={phase === "done" ? "success" : "default"}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                    <span className="font-medium text-foreground">
                      {statusLabel}
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {percent}% · {formatBytes(progress.bytesUploaded)} /{" "}
                      {formatBytes(progress.bytesTotal || file.size)}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {phase === "idle" && (
                  <Button onClick={startUpload}>
                    <Upload className="size-4" aria-hidden="true" />
                    Start upload
                  </Button>
                )}
                {phase === "uploading" && (
                  <Button
                    variant="secondary"
                    onClick={() => sessionRef.current?.pause()}
                  >
                    <Pause className="size-4" aria-hidden="true" />
                    Pause
                  </Button>
                )}
                {phase === "paused" && (
                  <Button onClick={() => sessionRef.current?.resume()}>
                    <Play className="size-4" aria-hidden="true" />
                    Resume
                  </Button>
                )}
                {isBusy && (
                  <Button variant="outline" onClick={cancelUpload}>
                    Cancel upload
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <FolderUp
                className="size-7 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="text-[15px] font-semibold text-foreground">
                  Drop a video file here
                </p>
                <p className="dash-meta mt-1">
                  MP4, MOV, WebM or MKV, up to 10 GB.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => inputRef.current?.click()}
              >
                Choose a file
              </Button>
            </div>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="sr-only"
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null;
              event.target.value = "";
              selectFile(picked);
            }}
          />
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-[14px] border border-failed/35 bg-failed/10 p-4 text-sm text-danger"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{errorMessage}</p>
          </div>
        )}

        <p className="dash-meta">
          Every upload is transcoded into HLS and DASH renditions.
          {playbackPolicy === "signed" && " Signed playback adds AES-128 encryption."}
          {generateSubtitle && " AI subtitles are generated from the transcript."}
          {generateChapters && " AI chapters are generated from the transcript."}
        </p>
      </SheetContent>
    </Sheet>
  );
}
