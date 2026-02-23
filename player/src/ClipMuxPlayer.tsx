'use client'

import * as React from 'react'
import {
    MediaPlayer,
    MediaProvider,
    Poster,
    Track,
} from '@vidstack/react'
import {
    defaultLayoutIcons,
    DefaultVideoLayout,
} from '@vidstack/react/player/layouts/default'

// Vidstack CSS — vendored locally to avoid sideEffects:false tree-shaking.
// tsup's injectStyle will bundle these into the JS output.
import './vidstack-styles.css'
import './clipmux-player.css'

// ─── Types ──────────────────────────────────────────────────────────

export type Chapter = {
    startTime: number
    endTime: number
    title: string
}

export interface ClipMuxPlayerProps {
    /**
     * The ClipMux video ID. Used to resolve the HLS URL and track analytics.
     * At minimum, one of `playbackId` or `src` must be provided.
     */
    playbackId?: string

    /**
     * Direct HLS/DASH URL. Escape hatch for custom CDNs, proxies, or local files.
     * If both `playbackId` and `src` are provided, `src` takes precedence for playback
     * but `playbackId` is still sent to analytics.
     */
    src?: string

    /** Environment/public key identifying the tenant. */
    envKey?: string

    /** Signed playback token for private content. Appended to the URL as `?token=`. */
    token?: string

    /** Video title shown in the player chrome. */
    title?: string

    /** Poster/thumbnail image URL. */
    poster?: string

    /** Subtitle/caption VTT URL. */
    subtitles?: string

    /** Chapter markers — converted to VTT internally. */
    chapters?: Chapter[] | null

    /** Auto-play on load. */
    autoPlay?: boolean

    /** Start muted. */
    muted?: boolean

    /** Theme customization. */
    theme?: {
        /** Maps to `--video-brand` CSS variable. */
        primaryColor?: string
        accentColor?: string
    }

    /** Additional CSS class on the player container. */
    className?: string

    /** Inline styles on the player container. */
    style?: React.CSSProperties

    /**
     * Override the analytics ingestion URL.
     * Default: the ClipMux production beacon endpoint.
     * Set to `false` to disable analytics entirely.
     */
    analyticsEndpoint?: string | false

    /** Fired when the player is ready. */
    onReady?: () => void

    /** Fired on playback error. */
    onError?: (err: Error) => void

    /** Fired when the video ends. */
    onEnded?: () => void
}

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Default analytics beacon URL.
 * Override with the `analyticsEndpoint` prop if you run your own proxy.
 */
const DEFAULT_ANALYTICS_URL = 'https://api.clipmux.com/api/playback/journal'

/**
 * CDN pattern for resolving playbackId → HLS URL.
 * Override with `src` prop if using a custom CDN.
 */
const CDN_BASE = 'https://delivery.clipmux.com/videos'

// ─── Helpers ────────────────────────────────────────────────────────

/** Append signed playback token to a URL if needed. */
function withToken(url: string, token?: string): string {
    if (!token || /(?:\?|&)token=/.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}token=${encodeURIComponent(token)}`
}

/** Resolve the playback source URL from props. */
function resolveSourceUrl(props: Pick<ClipMuxPlayerProps, 'playbackId' | 'src' | 'token'>): string {
    const url = props.src || `${CDN_BASE}/${props.playbackId}/playlist.m3u8`
    return withToken(url, props.token)
}

/** Convert chapters array to a WebVTT data URL. */
function chaptersToVttUrl(chapters: Chapter[]): string {
    let vtt = 'WEBVTT\n\n'

    chapters.forEach((ch, idx) => {
        const fmt = (s: number) => {
            const h = Math.floor(s / 3600)
            const m = Math.floor((s % 3600) / 60)
            const sec = s % 60
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`
        }
        vtt += `${idx + 1}\n${fmt(ch.startTime)} --> ${fmt(ch.endTime)}\n${ch.title}\n\n`
    })

    return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`
}

// ─── Analytics Event Types ──────────────────────────────────────────

type AnalyticsEvent = {
    event: string
    ts: string
    videoId: string
    sessionId: string
    envKey?: string
    currentTime: number
    duration: number
    watchedDelta: number
    errorCode?: string
}

// ─── Analytics Hook ─────────────────────────────────────────────────

function useVideoAnalytics(
    videoId: string,
    envKey: string | undefined,
    analyticsUrl: string | false,
    playerRef: React.RefObject<{ currentTime: number; duration: number } | null>,
) {
    // Disabled — return no-op handlers
    if (analyticsUrl === false) {
        return {
            onPlay: () => { },
            onPause: () => { },
            onSeeking: () => { },
            onSeeked: () => { },
            onEnded: () => { },
            onError: (_code?: string) => { },
        }
    }

    const url = analyticsUrl || DEFAULT_ANALYTICS_URL

    // Session ID — generated once per component mount
    const sessionIdRef = React.useRef<string>('')
    const eventQueueRef = React.useRef<AnalyticsEvent[]>([])
    const watchTimeAccumulatorRef = React.useRef<number>(0)
    const lastTickTimeRef = React.useRef<number | null>(null)
    const isPlayingRef = React.useRef<boolean>(false)
    const isSeekingRef = React.useRef<boolean>(false)
    const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

    React.useEffect(() => {
        sessionIdRef.current = crypto.randomUUID()
    }, [])

    const getPlayerState = React.useCallback(() => {
        const player = playerRef.current
        return {
            currentTime: player?.currentTime ?? 0,
            duration: player?.duration ?? 0,
        }
    }, [playerRef])

    const createEvent = React.useCallback(
        (eventType: string, watchedDelta: number = 0, errorCode?: string): AnalyticsEvent => {
            const { currentTime, duration } = getPlayerState()
            return {
                event: eventType,
                ts: new Date().toISOString(),
                videoId,
                sessionId: sessionIdRef.current,
                ...(envKey && { envKey }),
                currentTime,
                duration,
                watchedDelta,
                ...(errorCode && { errorCode }),
            }
        },
        [videoId, envKey, getPlayerState],
    )

    const flushEvents = React.useCallback(
        async (useBeacon: boolean = false) => {
            const watchedDelta = watchTimeAccumulatorRef.current
            watchTimeAccumulatorRef.current = 0

            if (watchedDelta > 0) {
                eventQueueRef.current.push(createEvent('heartbeat', watchedDelta))
            }

            const events = [...eventQueueRef.current]
            eventQueueRef.current = []
            if (events.length === 0) return

            const body = JSON.stringify(events)

            if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
                navigator.sendBeacon(url, body)
            } else {
                try {
                    await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body,
                        keepalive: true,
                    })
                } catch {
                    // Silently fail — analytics should never break the player
                }
            }
        },
        [createEvent, url],
    )

    const queueEvent = React.useCallback(
        (eventType: string, errorCode?: string) => {
            eventQueueRef.current.push(createEvent(eventType, 0, errorCode))
        },
        [createEvent],
    )

    const flushImmediate = React.useCallback(() => {
        flushEvents(false)
    }, [flushEvents])

    const tickWatchTime = React.useCallback(() => {
        if (!isPlayingRef.current || isSeekingRef.current) {
            lastTickTimeRef.current = null
            return
        }
        const now = performance.now()
        if (lastTickTimeRef.current !== null) {
            watchTimeAccumulatorRef.current += (now - lastTickTimeRef.current) / 1000
        }
        lastTickTimeRef.current = now
    }, [])

    // Event handlers
    const onPlay = React.useCallback(() => {
        isPlayingRef.current = true
        lastTickTimeRef.current = performance.now()
        queueEvent('play')
    }, [queueEvent])

    const onPause = React.useCallback(() => {
        tickWatchTime()
        isPlayingRef.current = false
        lastTickTimeRef.current = null
        queueEvent('pause')
        flushImmediate()
    }, [tickWatchTime, queueEvent, flushImmediate])

    const onSeeking = React.useCallback(() => {
        tickWatchTime()
        isSeekingRef.current = true
        queueEvent('seeking')
    }, [tickWatchTime, queueEvent])

    const onSeeked = React.useCallback(() => {
        isSeekingRef.current = false
        if (isPlayingRef.current) {
            lastTickTimeRef.current = performance.now()
        }
        queueEvent('seeked')
    }, [queueEvent])

    const onEnded = React.useCallback(() => {
        tickWatchTime()
        isPlayingRef.current = false
        queueEvent('ended')
        flushImmediate()
    }, [tickWatchTime, queueEvent, flushImmediate])

    const onError = React.useCallback(
        (errorCode?: string) => {
            tickWatchTime()
            queueEvent('error', errorCode || 'unknown')
            flushImmediate()
        },
        [tickWatchTime, queueEvent, flushImmediate],
    )

    // Heartbeat interval (10s) + watchTime ticker (1s) + beforeunload
    React.useEffect(() => {
        heartbeatIntervalRef.current = setInterval(() => {
            tickWatchTime()
            flushEvents(false)
        }, 10_000)

        const watchTimeTicker = setInterval(tickWatchTime, 1000)

        const handleBeforeUnload = () => {
            tickWatchTime()
            flushEvents(true) // sendBeacon — guaranteed delivery
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', handleBeforeUnload)
        }

        return () => {
            if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current)
            clearInterval(watchTimeTicker)
            if (typeof window !== 'undefined') {
                window.removeEventListener('beforeunload', handleBeforeUnload)
            }
            // Flush remaining events on unmount
            tickWatchTime()
            flushEvents(true)
        }
    }, [tickWatchTime, flushEvents])

    return { onPlay, onPause, onSeeking, onSeeked, onEnded, onError }
}

// ─── Component ──────────────────────────────────────────────────────

export function ClipMuxPlayer({
    playbackId,
    src,
    envKey,
    token,
    title,
    poster,
    subtitles,
    chapters,
    autoPlay = false,
    muted = false,
    theme,
    className,
    style,
    analyticsEndpoint,
    onReady,
    onError,
    onEnded: onEndedCallback,
}: ClipMuxPlayerProps) {
    // Resolve video ID — playbackId is preferred, fall back to extracting from src
    const videoId = playbackId || 'unknown'

    // Resolve the playback URL
    const videoSrc = React.useMemo(
        () => resolveSourceUrl({ playbackId, src, token }),
        [playbackId, src, token],
    )

    // Player state ref for analytics
    const playerStateRef = React.useRef<{ currentTime: number; duration: number } | null>(null)

    // Analytics hook
    const analytics = useVideoAnalytics(videoId, envKey, analyticsEndpoint ?? DEFAULT_ANALYTICS_URL, playerStateRef)

    // Chapters → VTT
    const chaptersVttUrl = React.useMemo(() => {
        if (!chapters || chapters.length === 0) return null
        return chaptersToVttUrl(chapters)
    }, [chapters])

    const posterSrc = React.useMemo(() => {
        if (!poster) return undefined
        return withToken(poster, token)
    }, [poster, token])

    const subtitlesSrc = React.useMemo(() => {
        if (!subtitles) return undefined
        return withToken(subtitles, token)
    }, [subtitles, token])

    // Build inline style with theme CSS variables
    const mergedStyle = React.useMemo(() => {
        const vars: Record<string, string> = {}
        if (theme?.primaryColor) vars['--video-brand'] = theme.primaryColor
        if (theme?.accentColor) vars['--video-accent'] = theme.accentColor
        return { ...vars, ...style }
    }, [theme, style])

    return (
        <MediaPlayer
            className={`clipmux-player ${className || ''}`}
            title={title}
            src={videoSrc}
            autoPlay={autoPlay}
            muted={muted}
            crossOrigin="anonymous"
            playsInline
            style={mergedStyle as any}
            onPlay={analytics.onPlay}
            onPause={analytics.onPause}
            onSeeking={analytics.onSeeking}
            onSeeked={analytics.onSeeked}
            onEnded={() => {
                analytics.onEnded()
                onEndedCallback?.()
            }}
            onError={(e) => {
                analytics.onError(e?.message || 'unknown')
                onError?.(new Error(e?.message || 'Playback error'))
            }}
            onTimeUpdate={(detail) => {
                if (playerStateRef.current) {
                    playerStateRef.current.currentTime = detail.currentTime
                }
            }}
            onDurationChange={(detail) => {
                if (playerStateRef.current) {
                    playerStateRef.current.duration = detail
                }
            }}
            onCanPlay={() => {
                playerStateRef.current = { currentTime: 0, duration: 0 }
                onReady?.()
            }}
        >
            <MediaProvider>
                {poster && (
                    <Poster
                        className="vds-poster absolute inset-0 block h-full w-full object-cover opacity-0 transition-opacity data-[visible]:opacity-100"
                        src={posterSrc}
                        alt={title || 'Video poster'}
                    />
                )}
                {subtitlesSrc && (
                    <Track
                        src={subtitlesSrc}
                        kind="subtitles"
                        label="English"
                        lang="en"
                        default
                    />
                )}
                {chaptersVttUrl && (
                    <Track
                        src={chaptersVttUrl}
                        kind="chapters"
                        label="Chapters"
                        lang="en"
                        default
                    />
                )}
            </MediaProvider>
            <DefaultVideoLayout
                thumbnails={posterSrc}
                icons={defaultLayoutIcons}
                menuGroup="bottom"
                smallLayoutWhen={({ width }) => width < 520}
            />
        </MediaPlayer>
    )
}
