"use client";

import * as React from "react";
import Uppy, { UppyFile, Meta, Body } from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import Dashboard from "@uppy/dashboard";
import { Lock, Globe, Captions, ListVideo } from "lucide-react";

import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";

import { Sheet, SheetHeader, SheetTitle, SheetContent } from "@/components/ui/sheet";
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

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";

export function UploadModal({ open, onClose, onUploadComplete }: UploadModalProps) {
    const dashboardRef = React.useRef<HTMLDivElement>(null);
    const uppyRef = React.useRef<Uppy<CustomMeta, Body> | null>(null);
    const [playbackPolicy, setPlaybackPolicy] = React.useState<"public" | "signed">("public");
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
            shouldUseMultipart: (file: UppyFile<CustomMeta, Body>) => (file.size ?? 0) > 100 * 1024 * 1024, // Use multipart for files > 100MB

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
                const response = await fetch(`${API_BASE_URL}/upload/multipart/create`, {
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

            async completeMultipartUpload(file: UppyFile<CustomMeta, Body>, { uploadId, key, parts }) {
                const response = await fetch(`${API_BASE_URL}/upload/multipart/complete`, {
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
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || "Failed to complete upload");
                }

                const data = await response.json();
                return { location: data.location };
            },

            async abortMultipartUpload(file: UppyFile<CustomMeta, Body>, { uploadId, key }) {
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
        <Sheet open={open} onClose={onClose}>
            <SheetHeader>
                <SheetTitle>Upload Videos</SheetTitle>
            </SheetHeader>
            <SheetContent className="space-y-4">
                {/* Playback Policy Selector */}
                <div className="flex items-center gap-4 p-4 rounded-xl bg-muted/30 border border-border">
                    <div className="flex-1">
                        <p className="text-sm font-medium text-foreground mb-1">Playback Policy</p>
                        <p className="text-xs text-muted-foreground">
                            {playbackPolicy === "public" 
                                ? "Anyone with the URL can view this video" 
                                : "Requires signed token for playback"}
                        </p>
                    </div>
                    <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/50 border border-border">
                        <button
                            type="button"
                            onClick={() => setPlaybackPolicy("public")}
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                                playbackPolicy === "public"
                                    ? "bg-primary text-white shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Globe className="w-4 h-4" />
                            Public
                        </button>
                        <button
                            type="button"
                            onClick={() => setPlaybackPolicy("signed")}
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                                playbackPolicy === "signed"
                                    ? "bg-primary text-white shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Lock className="w-4 h-4" />
                            Signed
                        </button>
                    </div>
                </div>

                {/* AI Subtitles Toggle */}
                <div 
                    className="flex items-center gap-4 p-4 rounded-xl bg-muted/30 border border-border cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => setGenerateSubtitle(!generateSubtitle)}
                >
                    <div className="flex-1">
                        <p className="text-sm font-medium text-foreground mb-1">AI Subtitles</p>
                        <p className="text-xs text-muted-foreground">
                            {generateSubtitle 
                                ? "Subtitles will be auto-generated using AI" 
                                : "No subtitles will be generated"}
                        </p>
                    </div>
                    <button
                        type="button"
                        className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                            generateSubtitle
                                ? "bg-primary text-white shadow-sm"
                                : "bg-muted/50 text-muted-foreground border border-border"
                        )}
                        onClick={(e) => {
                            e.stopPropagation();
                            setGenerateSubtitle(!generateSubtitle);
                        }}
                    >
                        <Captions className="w-4 h-4" />
                        {generateSubtitle ? "Enabled" : "Disabled"}
                    </button>
                </div>

                {/* AI Chapters Toggle */}
                <div 
                    className={cn(
                        "flex items-center gap-4 p-4 rounded-xl bg-muted/30 border border-border transition-colors",
                        generateSubtitle 
                            ? "cursor-pointer hover:bg-muted/50" 
                            : "opacity-50 cursor-not-allowed"
                    )}
                    onClick={() => generateSubtitle && setGenerateChapters(!generateChapters)}
                >
                    <div className="flex-1">
                        <p className="text-sm font-medium text-foreground mb-1">AI Chapters</p>
                        <p className="text-xs text-muted-foreground">
                            {!generateSubtitle 
                                ? "Enable AI Subtitles first (chapters require transcription)"
                                : generateChapters 
                                    ? "Chapters will be auto-generated from transcript" 
                                    : "No chapters will be generated"}
                        </p>
                    </div>
                    <button
                        type="button"
                        disabled={!generateSubtitle}
                        className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                            generateChapters && generateSubtitle
                                ? "bg-primary text-white shadow-sm"
                                : "bg-muted/50 text-muted-foreground border border-border",
                            !generateSubtitle && "opacity-50 cursor-not-allowed"
                        )}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (generateSubtitle) {
                                setGenerateChapters(!generateChapters);
                            }
                        }}
                    >
                        <ListVideo className="w-4 h-4" />
                        {generateChapters ? "Enabled" : "Disabled"}
                    </button>
                </div>

                <div
                    ref={dashboardRef}
                    className={cn(
                        "uppy-container rounded-xl overflow-hidden",
                        "[&_.uppy-Dashboard-inner]:!bg-card/50 [&_.uppy-Dashboard-inner]:!border-border",
                        "[&_.uppy-Dashboard-AddFiles]:!border-border",
                        "[&_.uppy-Dashboard-browse]:!text-primary",
                        "[&_.uppy-StatusBar]:!bg-muted/50"
                    )}
                />

                <p className="text-xs text-muted-foreground text-center">
                    Videos will be transcoded after upload for optimal streaming
                    {playbackPolicy === "signed" && " • AES-128 encrypted"}
                    {generateSubtitle && " • AI subtitles"}
                    {generateChapters && " • AI chapters"}
                </p>
            </SheetContent>
        </Sheet>
    );
}
