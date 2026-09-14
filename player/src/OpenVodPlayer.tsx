'use client'

import * as React from 'react'
import {
    isHLSProvider,
    MediaPlayer,
    MediaProvider,
    Poster,
    Track,
} from '@vidstack/react'
import { planNextRefresh } from './tokenRefreshLoop'
import {
    createAnalyticsEvent,
    drainWatchClock,
    initialWatchClock,
    resolveAnalyticsUserId,
    tickWatchClock,
    type AnalyticsEvent,
    type WatchClock,
} from './analyticsQueue'
import {
    defaultLayoutIcons,
    DefaultVideoLayout,
} from '@vidstack/react/player/layouts/default'

// Vidstack CSS — vendored locally to avoid sideEffects:false tree-shaking.
// tsup's injectStyle will bundle these into the JS output, so the stylesheet is
// inlined by default and there is nothing extra to import. Consumers who prefer
// a separate file can import '@openvod/player/styles.css' (see the README).
import './vidstack-styles.css'
import './openvod-player.css'

// ─── Types ──────────────────────────────────────────────────────────

export type Chapter = {
    startTime: number
    endTime: number
    title: string
}

/**
 * How the player obtains a fresh playback token.
 *
 * - `string`: an endpoint fetched with `credentials: 'include'` (same-origin
 *   session endpoints). Returns `{ token }`, `{ playback_token }` or
 *   `{ playback_url }`.
 * - `function`: any other source — a cross-origin API, a signed request, a
 *   token cache. Return the new token, a token-shaped object, or `null` when
 *   there is no session (the player then keeps the existing token).
 */
export type TokenSource = string | (() => Promise<string | TokenResponse | null>)

export interface TokenResponse {
    token?: string
    /** Alias accepted by the delivery API. */
    playback_token?: string
    /** A full playback URL carrying `?token=` — the token is extracted. */
    playback_url?: string
}

export interface OpenVodPlayerProps {
    /**
     * The OpenVOD video ID. Used with `cdnBase` to resolve the HLS URL and
     * to tag analytics events. At minimum, one of `src` or (`cdnBase` +
     * `playbackId`) must be provided.
     */
    playbackId?: string

    /**
     * Direct HLS/DASH URL. Takes precedence over `cdnBase` + `playbackId`.
     */
    src?: string

    /**
     * Delivery origin used to build `{cdnBase}/{playbackId}/playlist.m3u8`
     * when `src` is omitted (e.g. `https://media.example.com/videos`).
     * There is no hosted default — set this to your own delivery worker.
     */
    cdnBase?: string

    /**
     * Deprecated alias for `userId`. Sending `envKey` used to be silently
     * dropped by the journal endpoint, so the player sent no identity at all.
     */
    envKey?: string

    /** Signed playback token for private content. Appended to the URL as `?token=`. */
    token?: string

    /**
     * Where to get a fresh token before `token` expires — an endpoint URL or a
     * callback. Set it together with `token`; the player swaps the new token
     * into the playback URL without interrupting playback.
     */
    tokenRefreshEndpoint?: TokenSource

    /** Refresh lead time before token expiry in ms (default 60_000). */
    tokenRefreshLeadMs?: number

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
     * Analytics ingestion URL. Off by default (no phone-home).
     * Pass your API's `/api/playback/journal` to enable; `false` also disables.
     */
    analyticsEndpoint?: string | false

    /** Viewer identity reported with analytics events. */
    userId?: string

    /** Fired once when the video is ready to play. */
    onReady?: () => void

    /** Fired on playback error. */
    onError?: (err: Error) => void

    /** Fired when the video ends. */
    onEnded?: () => void
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Append signed playback token to a URL if needed. */
function withToken(url: string, token?: string): string {
    if (!token || /(?:\?|&)token=/.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}token=${encodeURIComponent(token)}`
}

/** Resolve the playback source URL from props. */
export function resolveSourceUrl(
    props: Pick<OpenVodPlayerProps, 'playbackId' | 'src' | 'token' | 'cdnBase'>,
): string {
    const fromCdn =
        props.cdnBase && props.playbackId
            ? `${props.cdnBase.replace(/\/$/, '')}/${props.playbackId}/playlist.m3u8`
            : ''
    const url = props.src || fromCdn
    if (!url) return ''
    return withToken(url, props.token)
}

/**
 * Pull a token out of whatever shape a refresh endpoint returned.
 *
 * Three shapes are accepted because all three exist in the wild: this package's
 * documented `{ token }`, the delivery contract's `playback_token`, and the
 * API's `{ playback_url }` (which carries the token in its query string).
 */
export function extractToken(response: unknown): string | null {
    if (typeof response === 'string') return response.trim() || null
    if (!response || typeof response !== 'object') return null

    const record = response as TokenResponse
    if (typeof record.token === 'string' && record.token.trim()) return record.token.trim()
    if (typeof record.playback_token === 'string' && record.playback_token.trim()) {
        return record.playback_token.trim()
    }
    if (typeof record.playback_url === 'string') {
        const match = record.playback_url.match(/[?&]token=([^&]+)/)
        if (match) return decodeURIComponent(match[1])
    }
    return null
}

/** Convert chapters array to a WebVTT data URL. */
export function chaptersToVttUrl(chapters: Chapter[]): string {
    return `data:text/vtt;charset=utf-8,${encodeURIComponent(chaptersToVtt(chapters))}`
}

export function chaptersToVtt(chapters: Chapter[]): string {
    const fmt = (s: number) => {
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`
    }

    let vtt = 'WEBVTT\n\n'
    chapters.forEach((ch, idx) => {
        vtt += `${idx + 1}\n${fmt(ch.startTime)} --> ${fmt(ch.endTime)}\n${ch.title}\n\n`
    })
    return vtt
}

// ─── Analytics Hook ─────────────────────────────────────────────────

interface PlayerState {
    currentTime: number
    duration: number
}

function useVideoAnalytics(
    videoId: string,
    userId: string | undefined,
    analyticsUrl: string | false | undefined,
    playerRef: React.RefObject<PlayerState | null>,
) {
    const url = typeof analyticsUrl === 'string' && analyticsUrl.length > 0 ? analyticsUrl : ''

    const sessionIdRef = React.useRef<string>('')
    const eventQueueRef = React.useRef<AnalyticsEvent[]>([])
    const watchClockRef = React.useRef<WatchClock>(initialWatchClock)
    const isPlayingRef = React.useRef<boolean>(false)
    const isSeekingRef = React.useRef<boolean>(false)

    React.useEffect(() => {
        sessionIdRef.current =
            typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2)
    }, [])

    const getPlayerState = React.useCallback((): PlayerState => {
        const player = playerRef.current
        return { currentTime: player?.currentTime ?? 0, duration: player?.duration ?? 0 }
    }, [playerRef])

    const tickWatchTime = React.useCallback(() => {
        watchClockRef.current = tickWatchClock(
            watchClockRef.current,
            performance.now(),
            isPlayingRef.current,
            isSeekingRef.current,
        )
    }, [])

    const makeEvent = React.useCallback(
        (eventType: string, watchedDelta = 0, errorCode?: string): AnalyticsEvent => {
            const { currentTime, duration } = getPlayerState()
            return createAnalyticsEvent({
                event: eventType,
                videoId,
                sessionId: sessionIdRef.current,
                userId,
                currentTime,
                duration,
                watchedDelta,
                errorCode,
            })
        },
        [videoId, userId, getPlayerState],
    )

    const flushEvents = React.useCallback(
        async (useBeacon = false) => {
            if (!url) return

            const drained = drainWatchClock(watchClockRef.current)
            watchClockRef.current = drained.clock
            if (drained.seconds > 0) {
                eventQueueRef.current.push(makeEvent('heartbeat', drained.seconds))
            }

            const events = eventQueueRef.current
            eventQueueRef.current = []
            if (events.length === 0) return

            const body = JSON.stringify(events)

            if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
                navigator.sendBeacon(url, body)
                return
            }

            try {
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    keepalive: true,
                })
            } catch {
                // Silently fail — analytics must never break playback
            }
        },
        [makeEvent, url],
    )

    const queueEvent = React.useCallback(
        (eventType: string, errorCode?: string) => {
            if (!url) return
            eventQueueRef.current.push(makeEvent(eventType, 0, errorCode))
        },
        [makeEvent, url],
    )

    const flushImmediate = React.useCallback(() => {
        void flushEvents(false)
    }, [flushEvents])

    // Event handlers.
    //
    // Every handler flips the play/seek flag *before* ticking: the clock
    // credits the interval that just elapsed and then stops counting, which is
    // what keeps a pause (or a scrub) from billing the time that follows it.
    const onPlay = React.useCallback(() => {
        isPlayingRef.current = true
        tickWatchTime()
        queueEvent('play')
    }, [tickWatchTime, queueEvent])

    const onPause = React.useCallback(() => {
        isPlayingRef.current = false
        tickWatchTime()
        queueEvent('pause')
        flushImmediate()
    }, [tickWatchTime, queueEvent, flushImmediate])

    const onSeeking = React.useCallback(() => {
        isSeekingRef.current = true
        tickWatchTime()
        queueEvent('seeking')
    }, [tickWatchTime, queueEvent])

    const onSeeked = React.useCallback(() => {
        isSeekingRef.current = false
        tickWatchTime()
        queueEvent('seeked')
    }, [tickWatchTime, queueEvent])

    const onEnded = React.useCallback(() => {
        isPlayingRef.current = false
        tickWatchTime()
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
        if (!url) return

        const heartbeat = setInterval(() => {
            tickWatchTime()
            void flushEvents(false)
        }, 10_000)

        const ticker = setInterval(tickWatchTime, 1_000)

        const handleBeforeUnload = () => {
            tickWatchTime()
            void flushEvents(true) // sendBeacon — guaranteed delivery
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', handleBeforeUnload)
        }

        return () => {
            clearInterval(heartbeat)
            clearInterval(ticker)
            if (typeof window !== 'undefined') {
                window.removeEventListener('beforeunload', handleBeforeUnload)
            }
            // Flush remaining events on unmount
            tickWatchTime()
            void flushEvents(true)
        }
    }, [tickWatchTime, flushEvents, url])

    return { onPlay, onPause, onSeeking, onSeeked, onEnded, onError }
}

// ─── Component ──────────────────────────────────────────────────────

export function OpenVodPlayer({
    playbackId,
    src,
    cdnBase,
    envKey,
    userId,
    token,
    tokenRefreshEndpoint,
    tokenRefreshLeadMs,
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
}: OpenVodPlayerProps) {
    const videoId = playbackId || 'unknown'

    // Live token state: `token` from props is the initial/static value; a
    // successful refresh swaps in a new one without unmounting playback.
    const [liveToken, setLiveToken] = React.useState<string | null>(null)
    const effectiveToken = liveToken ?? token

    const effectiveUserId = resolveAnalyticsUserId({ userId, envKey })

    const videoSrc = React.useMemo(
        () => resolveSourceUrl({ playbackId, src, token: effectiveToken, cdnBase }),
        [playbackId, src, effectiveToken, cdnBase],
    )

    // ── Signed-token auto-refresh ─────────────────────────────────────────
    const failuresRef = React.useRef(0)

    React.useEffect(() => {
        if (!token || !tokenRefreshEndpoint || typeof window === 'undefined') return

        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const fetchToken = async (): Promise<string | null> => {
            if (typeof tokenRefreshEndpoint === 'function') {
                return extractToken(await tokenRefreshEndpoint())
            }
            const res = await fetch(tokenRefreshEndpoint, { credentials: 'include' })
            if (!res.ok) throw new Error(`token refresh failed: ${res.status}`)
            return extractToken(await res.json())
        }

        const schedule = () => {
            const decision = planNextRefresh({
                token: liveToken ?? token,
                nowEpochSec: Date.now() / 1000,
                leadMs: tokenRefreshLeadMs,
                failures: failuresRef.current,
            })
            if (decision.kind === 'stop') return

            // Never busy-loop on clock skew.
            const delayMs = Math.max(decision.delayMs, 250)

            timer = setTimeout(async () => {
                if (cancelled) return
                try {
                    const next = await fetchToken()
                    if (next) {
                        failuresRef.current = 0
                        setLiveToken(next)
                        return // the state change reschedules with the new token
                    }
                    // No session (yet) — count it and try again later.
                    failuresRef.current += 1
                } catch {
                    failuresRef.current += 1 // transient failure — never interrupt playback
                }
                if (!cancelled) schedule()
            }, delayMs)
        }

        schedule()

        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [token, tokenRefreshEndpoint, tokenRefreshLeadMs, liveToken])

    // Player state ref for analytics
    const playerStateRef = React.useRef<PlayerState | null>(null)

    // Analytics hook
    const analytics = useVideoAnalytics(videoId, effectiveUserId, analyticsEndpoint, playerStateRef)

    // Chapters → VTT
    const chaptersVttUrl = React.useMemo(() => {
        if (!chapters || chapters.length === 0) return null
        return chaptersToVttUrl(chapters)
    }, [chapters])

    const posterSrc = React.useMemo(() => {
        if (!poster) return undefined
        return withToken(poster, effectiveToken)
    }, [poster, effectiveToken])

    const subtitlesSrc = React.useMemo(() => {
        if (!subtitles) return undefined
        return withToken(subtitles, effectiveToken)
    }, [subtitles, effectiveToken])

    const mergedStyle = React.useMemo(() => {
        const vars: Record<string, string> = {}
        if (theme?.primaryColor) vars['--video-brand'] = theme.primaryColor
        if (theme?.accentColor) vars['--video-accent'] = theme.accentColor
        return { ...vars, ...style } as React.CSSProperties &
            Record<`--${string}`, string | number | undefined>
    }, [theme, style])

    // `onCanPlay` fires again after every seek on some browsers; a "ready"
    // callback that fires mid-playback is a bug for anything that counts it.
    const readyForSrcRef = React.useRef<string | null>(null)

    return (
        <MediaPlayer
            className={`openvod-player ${className || ''}`}
            title={title}
            src={videoSrc}
            autoPlay={autoPlay}
            muted={muted}
            crossOrigin="anonymous"
            playsInline
            style={mergedStyle}
            onPlay={analytics.onPlay}
            onPause={analytics.onPause}
            onSeeking={analytics.onSeeking}
            onSeeked={analytics.onSeeked}
            onEnded={() => {
                analytics.onEnded()
                onEndedCallback?.()
            }}
            onError={(event) => {
                const detail = event as unknown as { message?: string } | undefined
                analytics.onError(detail?.message || 'unknown')
                onError?.(new Error(detail?.message || 'Playback error'))
            }}
            onProviderChange={(provider) => {
                if (isHLSProvider(provider)) {
                    provider.config = {
                        ...provider.config,
                        maxBufferLength: 30,
                        maxMaxBufferLength: 30,
                    }
                }
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
                if (readyForSrcRef.current === videoSrc) return
                readyForSrcRef.current = videoSrc
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
