"use client";

import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./clipmux-player.css";

import {
    MediaPlayer,
    MediaProvider,
    Poster,
    Track,
    type MediaPlayerInstance,
} from "@vidstack/react";
import {
    DefaultVideoLayout,
    defaultLayoutIcons,
} from "@vidstack/react/player/layouts/default";
import { useRef, useEffect, useState, useCallback } from "react";

// ============================================================================
// Types
// ============================================================================

export interface Chapter {
    startTime: number;
    title: string;
}

export interface Subtitle {
    src: string;
    label: string;
    lang: string;
    default?: boolean;
}

export interface ClipMuxPlayerProps {
    // Smart Mode - auto-fetches from API
    videoId?: string;

    // Raw Mode - manual control
    src?: string;
    poster?: string;
    title?: string;
    token?: string;
    subtitles?: Subtitle[];
    chapters?: Chapter[];

    // Playback
    autoPlay?: boolean;
    muted?: boolean;
    loop?: boolean;
    playbackRate?: number;
    startTime?: number;

    // Theming
    theme?: "dark" | "light" | "minimal";
    accentColor?: string;
    className?: string;

    // Events
    onPlay?: () => void;
    onPause?: () => void;
    onEnded?: () => void;
    onTimeUpdate?: (time: number) => void;
    onError?: (error: Error) => void;
    onQualityChange?: (level: number) => void;
    onTokenExpired?: () => Promise<string>;
    onReady?: () => void;
}

interface VideoMetadata {
    playbackUrl: string;
    thumbnailUrl?: string;
    title?: string;
    token?: string;
    chapters?: Chapter[];
    subtitles?: Subtitle[];
}

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4080/api";

// ============================================================================
// Main Component
// ============================================================================

export function ClipMuxPlayer({
    videoId,
    src: rawSrc,
    poster: rawPoster,
    title: rawTitle,
    token: rawToken,
    subtitles: rawSubtitles,
    chapters: rawChapters,
    autoPlay = false,
    muted = false,
    loop = false,
    playbackRate = 1,
    startTime = 0,
    theme = "dark",
    accentColor = "#8B5CF6",
    className = "",
    onPlay,
    onPause,
    onEnded,
    onTimeUpdate,
    onError,
    onQualityChange,
    onTokenExpired,
    onReady,
}: ClipMuxPlayerProps) {
    const playerRef = useRef<MediaPlayerInstance>(null);

    // Smart Mode state
    const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
    const [loading, setLoading] = useState(!!videoId);
    const [error, setError] = useState<string | null>(null);

    // Resolve final values (Smart Mode overrides Raw Mode)
    const src = metadata?.playbackUrl || rawSrc;
    const poster = metadata?.thumbnailUrl || rawPoster;
    const title = metadata?.title || rawTitle;
    const token = metadata?.token || rawToken;
    const subtitles = metadata?.subtitles || rawSubtitles || [];
    const chapters = metadata?.chapters || rawChapters || [];

    // Append token to src if provided (for signed videos)
    const videoSrc = src && token && !src.includes("token=")
        ? `${src}${src.includes("?") ? "&" : "?"}token=${token}`
        : src;

    // ========================================================================
    // Smart Mode: Fetch video metadata
    // ========================================================================
    useEffect(() => {
        if (!videoId || rawSrc) return; // Skip if using Raw Mode

        const fetchMetadata = async () => {
            setLoading(true);
            setError(null);

            try {
                const res = await fetch(`${API_URL}/video/${videoId}`, {
                    credentials: "include",
                });

                if (!res.ok) {
                    throw new Error(`Failed to fetch video: ${res.status}`);
                }

                const data = await res.json();

                setMetadata({
                    playbackUrl: data.playbackUrl,
                    thumbnailUrl: data.thumbnailUrl,
                    title: data.title,
                    token: data.token,
                    // AI features - ready for Groq integration
                    chapters: data.aiFeatures?.chapters || data.chapters || [],
                    subtitles: data.aiFeatures?.transcriptUrl
                        ? [{ src: data.aiFeatures.transcriptUrl, label: "English", lang: "en", default: true }]
                        : [],
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to load video";
                setError(message);
                onError?.(err instanceof Error ? err : new Error(message));
            } finally {
                setLoading(false);
            }
        };

        fetchMetadata();
    }, [videoId, rawSrc, onError]);

    // ========================================================================
    // Keyboard Shortcuts
    // ========================================================================
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        const player = playerRef.current;
        if (!player) return;

        // Ignore if typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
            return;
        }

        const { currentTime, duration, volume, muted: isMuted, paused } = player.state;

        switch (e.key.toLowerCase()) {
            case " ":
            case "k":
                e.preventDefault();
                paused ? player.play() : player.pause();
                break;

            case "arrowleft":
            case "j":
                e.preventDefault();
                player.currentTime = Math.max(0, currentTime - 10);
                break;

            case "arrowright":
            case "l":
                e.preventDefault();
                player.currentTime = Math.min(duration, currentTime + 10);
                break;

            case "arrowup":
                e.preventDefault();
                player.volume = Math.min(1, volume + 0.1);
                break;

            case "arrowdown":
                e.preventDefault();
                player.volume = Math.max(0, volume - 0.1);
                break;

            case "m":
                e.preventDefault();
                player.muted = !isMuted;
                break;

            case "f":
                e.preventDefault();
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    player.el?.requestFullscreen();
                }
                break;

            case "c":
                e.preventDefault();
                // Toggle captions - Vidstack handles this internally
                const textTracks = player.textTracks;
                if (textTracks.length > 0) {
                    const activeTrack = textTracks.toArray().find(t => t.mode === "showing");
                    if (activeTrack) {
                        activeTrack.mode = "disabled";
                    } else {
                        const firstTrack = textTracks.toArray()[0];
                        if (firstTrack) firstTrack.mode = "showing";
                    }
                }
                break;

            case ",":
                // Frame backward (when paused)
                if (paused) {
                    e.preventDefault();
                    player.currentTime = Math.max(0, currentTime - 1 / 30);
                }
                break;

            case ".":
                // Frame forward (when paused)
                if (paused) {
                    e.preventDefault();
                    player.currentTime = Math.min(duration, currentTime + 1 / 30);
                }
                break;

            case "<":
                e.preventDefault();
                player.playbackRate = Math.max(0.25, player.playbackRate - 0.25);
                break;

            case ">":
                e.preventDefault();
                player.playbackRate = Math.min(2, player.playbackRate + 0.25);
                break;

            default:
                // Number keys 0-9: seek to percentage
                if (/^[0-9]$/.test(e.key)) {
                    e.preventDefault();
                    const percent = parseInt(e.key) * 10;
                    player.currentTime = (duration * percent) / 100;
                }
                break;
        }
    }, []);

    // Attach keyboard listener when player is focused
    useEffect(() => {
        const player = playerRef.current;
        if (!player) return;

        const container = player.el;
        if (!container) return;

        // Make focusable
        container.tabIndex = 0;

        const handleFocus = () => {
            window.addEventListener("keydown", handleKeyDown);
        };

        const handleBlur = () => {
            window.removeEventListener("keydown", handleKeyDown);
        };

        container.addEventListener("focus", handleFocus);
        container.addEventListener("blur", handleBlur);
        container.addEventListener("click", () => container.focus());

        return () => {
            container.removeEventListener("focus", handleFocus);
            container.removeEventListener("blur", handleBlur);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [handleKeyDown, loading]);

    // ========================================================================
    // Convert chapters to VTT for Vidstack
    // ========================================================================
    const chaptersVttUrl = useChaptersVtt(chapters);

    // ========================================================================
    // Render
    // ========================================================================

    // Loading state
    if (loading) {
        return (
            <div
                className={`clipmux-player clipmux-player--${theme} ${className}`}
                style={{ "--clipmux-accent": accentColor } as React.CSSProperties}
            >
                <div className="clipmux-player__loading">
                    <div className="clipmux-player__spinner" />
                    <span>Loading video...</span>
                </div>
            </div>
        );
    }

    // Error state
    if (error || !videoSrc) {
        return (
            <div
                className={`clipmux-player clipmux-player--${theme} ${className}`}
                style={{ "--clipmux-accent": accentColor } as React.CSSProperties}
            >
                <div className="clipmux-player__error">
                    <span>⚠️</span>
                    <p>{error || "No video source provided"}</p>
                </div>
            </div>
        );
    }

    return (
        <MediaPlayer
            ref={playerRef}
            src={videoSrc}
            title={title}
            autoPlay={autoPlay}
            muted={muted}
            loop={loop}
            playbackRate={playbackRate}
            currentTime={startTime}
            crossOrigin="anonymous"
            playsInline
            className={`clipmux-player clipmux-player--${theme} ${className}`}
            style={{ "--clipmux-accent": accentColor } as unknown as React.CSSProperties}
            onPlay={() => onPlay?.()}
            onPause={() => onPause?.()}
            onEnded={() => onEnded?.()}
            onTimeUpdate={(e) => onTimeUpdate?.(e.currentTime)}
            onError={(e) => onError?.(new Error(e.message || "Playback error"))}
            onCanPlay={() => onReady?.()}
        >
            <MediaProvider>
                {poster && (
                    <Poster
                        className="vds-poster absolute inset-0 block h-full w-full object-cover opacity-0 transition-opacity data-[visible]:opacity-100"
                        src={poster}
                        alt={title || "Video poster"}
                    />
                )}

                {/* Subtitle tracks */}
                {subtitles.map((sub, i) => (
                    <Track
                        key={`sub-${i}`}
                        src={sub.src}
                        kind="subtitles"
                        label={sub.label}
                        lang={sub.lang}
                        default={sub.default}
                    />
                ))}

                {/* Chapter track */}
                {chaptersVttUrl && (
                    <Track
                        src={chaptersVttUrl}
                        kind="chapters"
                        label="Chapters"
                        default
                    />
                )}
            </MediaProvider>

            <DefaultVideoLayout
                icons={defaultLayoutIcons}
                thumbnails={poster}
            />
        </MediaPlayer>
    );
}

// ============================================================================
// Helper: Convert chapters array to VTT blob URL
// ============================================================================

function useChaptersVtt(chapters: Chapter[]): string | null {
    const [vttUrl, setVttUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!chapters.length) {
            setVttUrl(null);
            return;
        }

        // Generate VTT content
        let vtt = "WEBVTT\n\n";

        chapters.forEach((chapter, i) => {
            const start = formatVttTime(chapter.startTime);
            const end = formatVttTime(
                i < chapters.length - 1
                    ? chapters[i + 1].startTime
                    : chapter.startTime + 3600 // Default 1hr for last chapter
            );
            vtt += `${start} --> ${end}\n${chapter.title}\n\n`;
        });

        const blob = new Blob([vtt], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        setVttUrl(url);

        return () => URL.revokeObjectURL(url);
    }, [chapters]);

    return vttUrl;
}

function formatVttTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

// ============================================================================
// Export minimal version for embeds
// ============================================================================

export function ClipMuxPlayerMinimal({
    videoId,
    src,
    poster,
    token,
    autoPlay = false,
    muted = true,
    accentColor = "#8B5CF6",
    className = "",
}: Pick<ClipMuxPlayerProps,
    "videoId" | "src" | "poster" | "token" | "autoPlay" | "muted" | "accentColor" | "className"
>) {
    return (
        <ClipMuxPlayer
            videoId={videoId}
            src={src}
            poster={poster}
            token={token}
            autoPlay={autoPlay}
            muted={muted}
            theme="minimal"
            accentColor={accentColor}
            className={className}
        />
    );
}
