"use client";

import React, { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Play, Pause, Volume2, VolumeX, Maximize, Loader2, Bug } from "lucide-react";
import { cn } from "@/lib/utils";

interface HlsPlayerProps {
    src: string;
    poster?: string;
    className?: string;
    autoPlay?: boolean;
    debug?: boolean;
}

interface DebugLog {
    time: string;
    type: "info" | "warn" | "error" | "event";
    message: string;
}

export function HlsPlayer({ src, poster, className, autoPlay = false, debug = false }: HlsPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [showDebug, setShowDebug] = useState(debug);
    const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
    const [hlsStats, setHlsStats] = useState<any>(null);

    const addLog = (type: DebugLog["type"], message: string) => {
        const time = new Date().toLocaleTimeString();
        setDebugLogs((prev) => [...prev.slice(-100), { time, type, message }]);
        if (type === "error") console.error(`[HLS] ${message}`);
        else if (type === "warn") console.warn(`[HLS] ${message}`);
        else console.log(`[HLS] ${message}`);
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !src) return;

        addLog("info", `Initializing player with src: ${src}`);

        // Check if browser supports HLS natively (Safari)
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            addLog("info", "Using native HLS support (Safari)");
            video.src = src;
            setIsLoading(false);
            return;
        }

        // Use hls.js for other browsers
        if (!Hls.isSupported()) {
            addLog("error", "HLS is not supported in this browser");
            setError("HLS playback is not supported in this browser");
            return;
        }

        addLog("info", "Using hls.js for playback");

        const hls = new Hls({
            debug: debug,
            enableWorker: true,
            lowLatencyMode: false,
            // Buffer settings
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000, // 60MB
            maxBufferHole: 0.5,
            // Error recovery
            fragLoadingMaxRetry: 6,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            // Timing
            fragLoadingTimeOut: 20000,
            manifestLoadingTimeOut: 10000,
            levelLoadingTimeOut: 10000,
            // ABR
            startLevel: -1, // Auto select
            abrEwmaDefaultEstimate: 500000,
        });

        hlsRef.current = hls;

        // Attach HLS events
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            addLog("event", "Media attached");
            hls.loadSource(src);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            addLog("event", `Manifest parsed: ${data.levels.length} quality levels`);
            data.levels.forEach((level, i) => {
                addLog("info", `  Level ${i}: ${level.width}x${level.height} @ ${Math.round(level.bitrate / 1000)}kbps`);
            });
            setIsLoading(false);
            if (autoPlay) {
                video.play().catch((e) => addLog("warn", `Autoplay failed: ${e.message}`));
            }
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            const level = hls.levels[data.level];
            addLog("event", `Level switched to ${data.level}: ${level?.width}x${level?.height}`);
        });

        hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
            addLog("info", `Loading fragment: ${data.frag.sn} (${data.frag.type})`);
        });

        hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
            addLog("info", `Fragment loaded: ${data.frag.sn}, size: ${Math.round(data.frag.stats.total / 1024)}KB`);
        });

        hls.on(Hls.Events.BUFFER_APPENDING, (event, data) => {
            addLog("info", `Buffer appending: type=${data.type}`);
        });

        hls.on(Hls.Events.BUFFER_APPENDED, (event, data) => {
            addLog("info", `Buffer appended: type=${data.type}`);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
            addLog("error", `HLS Error: ${data.type} - ${data.details}`);
            addLog("error", `  Fatal: ${data.fatal}, Reason: ${data.reason || "unknown"}`);
            
            if (data.response) {
                addLog("error", `  Response: ${data.response.code} ${data.response.text}`);
            }

            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        addLog("warn", "Fatal network error, trying to recover...");
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        addLog("warn", "Fatal media error, trying to recover...");
                        hls.recoverMediaError();
                        break;
                    default:
                        addLog("error", "Unrecoverable error, destroying player");
                        setError(`Playback error: ${data.details}`);
                        hls.destroy();
                        break;
                }
            }
        });

        hls.on(Hls.Events.FRAG_BUFFERED, () => {
            if (debug) {
                setHlsStats({
                    buffered: video.buffered.length > 0 
                        ? `${video.buffered.start(0).toFixed(1)}s - ${video.buffered.end(video.buffered.length - 1).toFixed(1)}s`
                        : "none",
                    currentLevel: hls.currentLevel,
                    nextLevel: hls.nextLevel,
                    loadLevel: hls.loadLevel,
                });
            }
        });

        hls.attachMedia(video);

        // Video element events
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);
        const handleTimeUpdate = () => setCurrentTime(video.currentTime);
        const handleDurationChange = () => setDuration(video.duration);
        const handleWaiting = () => {
            setIsLoading(true);
            addLog("event", "Video waiting/buffering");
        };
        const handleCanPlay = () => {
            setIsLoading(false);
            addLog("event", "Video can play");
        };
        const handleError = (e: Event) => {
            const mediaError = video.error;
            addLog("error", `Video element error: ${mediaError?.code} - ${mediaError?.message}`);
        };
        const handleSeeking = () => {
            addLog("event", `Seeking to ${video.currentTime.toFixed(1)}s`);
        };
        const handleSeeked = () => {
            addLog("event", `Seeked to ${video.currentTime.toFixed(1)}s`);
        };

        video.addEventListener("play", handlePlay);
        video.addEventListener("pause", handlePause);
        video.addEventListener("timeupdate", handleTimeUpdate);
        video.addEventListener("durationchange", handleDurationChange);
        video.addEventListener("waiting", handleWaiting);
        video.addEventListener("canplay", handleCanPlay);
        video.addEventListener("error", handleError);
        video.addEventListener("seeking", handleSeeking);
        video.addEventListener("seeked", handleSeeked);

        return () => {
            video.removeEventListener("play", handlePlay);
            video.removeEventListener("pause", handlePause);
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("durationchange", handleDurationChange);
            video.removeEventListener("waiting", handleWaiting);
            video.removeEventListener("canplay", handleCanPlay);
            video.removeEventListener("error", handleError);
            video.removeEventListener("seeking", handleSeeking);
            video.removeEventListener("seeked", handleSeeked);
            
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, [src, autoPlay, debug]);

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;
        if (isPlaying) {
            video.pause();
        } else {
            video.play();
        }
    };

    const toggleMute = () => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
        setIsMuted(video.muted);
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const video = videoRef.current;
        if (!video) return;
        const time = parseFloat(e.target.value);
        video.currentTime = time;
        setCurrentTime(time);
    };

    const toggleFullscreen = () => {
        const video = videoRef.current;
        if (!video) return;
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            video.requestFullscreen();
        }
    };

    const formatTime = (seconds: number) => {
        if (!isFinite(seconds)) return "--:--";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    return (
        <div className={cn("relative bg-black rounded-xl overflow-hidden", className)}>
            {/* Video Element */}
            <video
                ref={videoRef}
                className="w-full h-full"
                poster={poster}
                playsInline
            />

            {/* Loading Overlay */}
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 className="w-12 h-12 text-white animate-spin" />
                </div>
            )}

            {/* Error Overlay */}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                    <div className="text-center p-4">
                        <p className="text-red-400 text-lg mb-2">Playback Error</p>
                        <p className="text-white/70 text-sm">{error}</p>
                    </div>
                </div>
            )}

            {/* Controls */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
                {/* Progress Bar */}
                <input
                    type="range"
                    min={0}
                    max={duration || 100}
                    value={currentTime}
                    onChange={handleSeek}
                    className="w-full h-1 mb-3 bg-white/30 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
                />

                {/* Control Buttons */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={togglePlay}
                            className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                        >
                            {isPlaying ? (
                                <Pause className="w-5 h-5 text-white" />
                            ) : (
                                <Play className="w-5 h-5 text-white" />
                            )}
                        </button>

                        <button
                            onClick={toggleMute}
                            className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                        >
                            {isMuted ? (
                                <VolumeX className="w-5 h-5 text-white" />
                            ) : (
                                <Volume2 className="w-5 h-5 text-white" />
                            )}
                        </button>

                        <span className="text-white text-sm font-mono">
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowDebug(!showDebug)}
                            className={cn(
                                "p-2 rounded-full transition-colors",
                                showDebug ? "bg-red-500/50" : "bg-white/20 hover:bg-white/30"
                            )}
                        >
                            <Bug className="w-5 h-5 text-white" />
                        </button>

                        <button
                            onClick={toggleFullscreen}
                            className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                        >
                            <Maximize className="w-5 h-5 text-white" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Debug Panel */}
            {showDebug && (
                <div className="absolute top-0 left-0 right-0 max-h-[60%] overflow-y-auto bg-black/90 p-3 text-xs font-mono">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-green-400 font-bold">HLS Debug Console</span>
                        <button
                            onClick={() => setDebugLogs([])}
                            className="text-white/50 hover:text-white text-xs"
                        >
                            Clear
                        </button>
                    </div>

                    {hlsStats && (
                        <div className="mb-2 p-2 bg-blue-500/20 rounded text-blue-300">
                            <div>Buffered: {hlsStats.buffered}</div>
                            <div>Current Level: {hlsStats.currentLevel} | Next: {hlsStats.nextLevel} | Load: {hlsStats.loadLevel}</div>
                        </div>
                    )}

                    <div className="space-y-0.5">
                        {debugLogs.map((log, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "py-0.5",
                                    log.type === "error" && "text-red-400",
                                    log.type === "warn" && "text-yellow-400",
                                    log.type === "event" && "text-cyan-400",
                                    log.type === "info" && "text-white/70"
                                )}
                            >
                                <span className="text-white/40">[{log.time}]</span> {log.message}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
