'use client'

import * as React from 'react'
import { MediaPlayer, MediaProvider, Track, useMediaState } from '@vidstack/react'
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from '@vidstack/react/player/layouts/default'

import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import './clipmux-player.css'

type Chapter = {
  startTime: number
  endTime: number
  title: string
}

type ClipMuxPlayerProps = {
  src: string
  videoId: string
  title?: string
  thumbnails?: string
  subtitles?: string
  chapters?: Chapter[] | null
  userId?: string | null
}

// Analytics event type
type AnalyticsEvent = {
  event: string
  ts: string
  videoId: string
  sessionId: string
  userId?: string | null
  currentTime: number
  duration: number
  watchedDelta: number
  errorCode?: string
}

// Analytics API endpoint
const ANALYTICS_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL
    ? `${process.env.NEXT_PUBLIC_API_BASE_URL}/playback/journal`
    : 'http://localhost:8000/api/playback/journal'

/**
 * Convert chapters array to VTT format string
 */
function chaptersToVtt(chapters: Chapter[]): string {
  let vtt = 'WEBVTT\n\n'

  chapters.forEach((ch, idx) => {
    const formatTime = (seconds: number) => {
      const h = Math.floor(seconds / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const s = seconds % 60
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
    }

    vtt += `${idx + 1}\n`
    vtt += `${formatTime(ch.startTime)} --> ${formatTime(ch.endTime)}\n`
    vtt += `${ch.title}\n\n`
  })

  return vtt
}

/**
 * Analytics tracker hook for video player
 */
function useVideoAnalytics(
  videoId: string,
  userId: string | null | undefined,
  playerRef: React.RefObject<{ currentTime: number; duration: number } | null>,
) {
  // Session ID - generated once per component mount
  const sessionIdRef = React.useRef<string>('')

  // Event queue for batching
  const eventQueueRef = React.useRef<AnalyticsEvent[]>([])

  // Watch time tracking
  const watchTimeAccumulatorRef = React.useRef<number>(0)
  const lastTickTimeRef = React.useRef<number | null>(null)
  const isPlayingRef = React.useRef<boolean>(false)
  const isSeekingRef = React.useRef<boolean>(false)

  // Heartbeat interval ref
  const heartbeatIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  // Generate session ID on mount
  React.useEffect(() => {
    sessionIdRef.current = crypto.randomUUID()
  }, [])

  // Get current player state
  const getPlayerState = React.useCallback(() => {
    const player = playerRef.current
    return {
      currentTime: player?.currentTime ?? 0,
      duration: player?.duration ?? 0,
    }
  }, [playerRef])

  // Create an event object
  const createEvent = React.useCallback(
    (eventType: string, watchedDelta: number = 0, errorCode?: string): AnalyticsEvent => {
      const { currentTime, duration } = getPlayerState()
      return {
        event: eventType,
        ts: new Date().toISOString(),
        videoId,
        sessionId: sessionIdRef.current,
        userId: userId ?? null,
        currentTime,
        duration,
        watchedDelta,
        ...(errorCode && { errorCode }),
      }
    },
    [videoId, userId, getPlayerState],
  )

  // Flush events to server
  const flushEvents = React.useCallback(
    async (useBeacon: boolean = false) => {
      // Get accumulated watch time and reset
      const watchedDelta = watchTimeAccumulatorRef.current
      watchTimeAccumulatorRef.current = 0

      // Add heartbeat event with watch delta if we have accumulated time
      if (watchedDelta > 0) {
        const heartbeatEvent = createEvent('heartbeat', watchedDelta)
        eventQueueRef.current.push(heartbeatEvent)
      }

      const events = [...eventQueueRef.current]
      eventQueueRef.current = []

      if (events.length === 0) return

      const body = JSON.stringify(events)

      if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        // Use sendBeacon for exit events (more reliable on page unload)
        navigator.sendBeacon(ANALYTICS_URL, body)
      } else {
        try {
          await fetch(ANALYTICS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          })
        } catch (error) {
          console.error('Failed to send analytics:', error)
        }
      }
    },
    [createEvent],
  )

  // Queue an event
  const queueEvent = React.useCallback((eventType: string, errorCode?: string) => {
    const event = createEvent(eventType, 0, errorCode)
    eventQueueRef.current.push(event)
  }, [createEvent])

  // Immediate flush (for pause/error)
  const flushImmediate = React.useCallback(() => {
    flushEvents(false)
  }, [flushEvents])

  // Update watch time accumulator
  const tickWatchTime = React.useCallback(() => {
    if (!isPlayingRef.current || isSeekingRef.current) {
      lastTickTimeRef.current = null
      return
    }

    const now = performance.now()
    if (lastTickTimeRef.current !== null) {
      const deltaMs = now - lastTickTimeRef.current
      watchTimeAccumulatorRef.current += deltaMs / 1000
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
    tickWatchTime() // Capture final time before pause
    isPlayingRef.current = false
    lastTickTimeRef.current = null
    queueEvent('pause')
    flushImmediate()
  }, [tickWatchTime, queueEvent, flushImmediate])

  const onSeeking = React.useCallback(() => {
    tickWatchTime() // Capture time before seek
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

  // Set up heartbeat interval and beforeunload
  React.useEffect(() => {
    // Heartbeat every 10 seconds
    heartbeatIntervalRef.current = setInterval(() => {
      tickWatchTime()
      flushEvents(false)
    }, 10000)

    // Watch time ticker (every 1 second for accuracy)
    const watchTimeTicker = setInterval(tickWatchTime, 1000)

    // Handle page unload
    const handleBeforeUnload = () => {
      tickWatchTime()
      flushEvents(true) // Use sendBeacon
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', handleBeforeUnload)
    }

    return () => {
      // Cleanup
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current)
      }
      clearInterval(watchTimeTicker)

      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', handleBeforeUnload)
      }

      // Flush remaining events on unmount
      tickWatchTime()
      flushEvents(true)
    }
  }, [tickWatchTime, flushEvents])

  return {
    onPlay,
    onPause,
    onSeeking,
    onSeeked,
    onEnded,
    onError,
  }
}

export function ClipMuxPlayer({
  src,
  videoId,
  title,
  thumbnails,
  subtitles,
  chapters,
  userId,
}: ClipMuxPlayerProps) {
  // Ref to access player state
  const playerStateRef = React.useRef<{ currentTime: number; duration: number } | null>(null)

  // Analytics hooks
  const analytics = useVideoAnalytics(videoId, userId, playerStateRef)

  // Convert chapters to VTT data URL
  const chaptersVttUrl = React.useMemo(() => {
    if (!chapters || chapters.length === 0) return null
    const vtt = chaptersToVtt(chapters)
    return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`
  }, [chapters])

  return (
    <MediaPlayer
      className="media-player"
      title={title}
      src={src}
      crossOrigin="anonymous"
      onPlay={analytics.onPlay}
      onPause={analytics.onPause}
      onSeeking={analytics.onSeeking}
      onSeeked={analytics.onSeeked}
      onEnded={analytics.onEnded}
      onError={() => analytics.onError()}
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
        // Initialize player state ref when player is ready
        playerStateRef.current = { currentTime: 0, duration: 0 }
      }}
    >
      <MediaProvider>
        {subtitles ? (
          <Track
            src={subtitles}
            kind="subtitles"
            label="English"
            lang="en"
            default
          />
        ) : null}
        {chaptersVttUrl ? (
          <Track
            src={chaptersVttUrl}
            kind="chapters"
            label="Chapters"
            lang="en"
            default
          />
        ) : null}
      </MediaProvider>
      <DefaultVideoLayout
        thumbnails={thumbnails}
        icons={defaultLayoutIcons}
        menuGroup="bottom"
        smallLayoutWhen={({ width }) => width < 520}
      />
    </MediaPlayer>
  )
}
