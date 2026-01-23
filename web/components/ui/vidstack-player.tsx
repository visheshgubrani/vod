"use client";

import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";

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
import { useRef } from "react";

export interface VidstackPlayerProps {
    /** HLS manifest URL */
    src: string;
    /** Video title */
    title?: string;
    /** Poster/thumbnail URL */
    poster?: string;
    /** Subtitle/caption VTT URL */
    subtitles?: string;
    /** JWT token for signed videos */
    token?: string;
    /** Auto-play on load */
    autoPlay?: boolean;
    /** Start muted */
    muted?: boolean;
    /** Custom class name */
    className?: string;
    /** Callback when video ends */
    onEnded?: () => void;
    /** Callback on error */
    onError?: (error: Error) => void;
}

export function VidstackPlayer({
    src,
    title,
    poster,
    subtitles,
    token,
    autoPlay = false,
    muted = false,
    className = "",
    onEnded,
    onError,
}: VidstackPlayerProps) {
    const playerRef = useRef<MediaPlayerInstance>(null);

    // Append token to src if provided (for signed videos)
    const videoSrc = token && !src.includes("token=")
        ? `${src}${src.includes("?") ? "&" : "?"}token=${token}`
        : src;

    return (
        <MediaPlayer
            ref={playerRef}
            src={videoSrc}
            title={title}
            autoPlay={autoPlay}
            muted={muted}
            crossOrigin="anonymous"
            playsInline
            className={`w-full aspect-video rounded-xl overflow-hidden ${className}`}
            onEnded={onEnded}
            onError={(e) => onError?.(new Error(e.message || "Playback error"))}
        >
            <MediaProvider>
                {poster && (
                    <Poster
                        className="vds-poster absolute inset-0 block h-full w-full object-cover opacity-0 transition-opacity data-[visible]:opacity-100"
                        src={poster}
                        alt={title || "Video poster"}
                    />
                )}
                
                {/* Subtitles track */}
                {subtitles && (
                    <Track
                        src={subtitles}
                        kind="subtitles"
                        label="English"
                        lang="en"
                        default
                    />
                )}
            </MediaProvider>

            {/* Default video layout with all controls */}
            <DefaultVideoLayout
                icons={defaultLayoutIcons}
                thumbnails={poster}
            />
        </MediaPlayer>
    );
}

// Minimal player without controls (for embedding/previews)
export function VidstackPlayerMinimal({
    src,
    poster,
    token,
    autoPlay = false,
    muted = false,
    className = "",
}: Pick<VidstackPlayerProps, "src" | "poster" | "token" | "autoPlay" | "muted" | "className">) {
    const videoSrc = token && !src.includes("token=")
        ? `${src}${src.includes("?") ? "&" : "?"}token=${token}`
        : src;

    return (
        <MediaPlayer
            src={videoSrc}
            autoPlay={autoPlay}
            muted={muted}
            playsInline
            crossOrigin="anonymous"
            className={`w-full aspect-video ${className}`}
        >
            <MediaProvider>
                {poster && (
                    <Poster
                        className="vds-poster absolute inset-0 block h-full w-full object-cover"
                        src={poster}
                        alt="Video"
                    />
                )}
            </MediaProvider>
        </MediaPlayer>
    );
}
