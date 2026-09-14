/**
 * Playback analytics: event construction, watch-time accounting, and the
 * identity mapping (pure — no React, no DOM).
 *
 * The shape here is mirrored by `server/src/routes/analytics.ts`, which reads
 * `userId` — *not* `envKey`. The player used to send `envKey`, so per-user
 * analytics silently recorded nothing; `resolveAnalyticsUserId` keeps the old
 * prop working as an alias while making `userId` the documented one.
 */

export interface AnalyticsEvent {
    event: string
    ts: string
    videoId: string
    sessionId: string
    /** Viewer identity (your app's user id). Absent when anonymous. */
    userId?: string
    currentTime: number
    duration: number
    /** Seconds watched since the last flush; 0 for instantaneous events. */
    watchedDelta: number
    errorCode?: string
}

/**
 * Which viewer identity to report.
 *
 * `userId` wins; `envKey` is the deprecated spelling of the same field.
 */
export function resolveAnalyticsUserId(input: {
    userId?: string | null
    /** @deprecated Use `userId`. */
    envKey?: string | null
}): string | undefined {
    return input.userId || input.envKey || undefined
}

export interface CreateEventInput {
    event: string
    videoId: string
    sessionId: string
    userId?: string | undefined
    currentTime: number
    duration: number
    watchedDelta?: number
    errorCode?: string
    /** Injectable clock for tests. */
    now?: Date
}

export function createAnalyticsEvent(input: CreateEventInput): AnalyticsEvent {
    const now = input.now ?? new Date()
    return {
        event: input.event,
        ts: now.toISOString(),
        videoId: input.videoId,
        sessionId: input.sessionId,
        ...(input.userId ? { userId: input.userId } : {}),
        currentTime: input.currentTime,
        duration: input.duration,
        watchedDelta: input.watchedDelta ?? 0,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    }
}

/**
 * Watch-time accounting across pause, seek and clock skew.
 *
 * `watchedSeconds` only advances while playback is running and not seeking, so
 * a viewer who scrubs through a 90-minute film does not report 90 minutes
 * watched. `lastTickMs === null` means "not counting" — the next tick starts a
 * fresh interval rather than billing the gap.
 */
export interface WatchClock {
    watchedSeconds: number
    lastTickMs: number | null
}

export const initialWatchClock: WatchClock = { watchedSeconds: 0, lastTickMs: null }

/**
 * Advance the clock to `nowMs`, given the current play/seek state.
 *
 * Order matters at the call site: flip the state first, then tick. The elapsed
 * interval since the previous tick *was* watched, so it is always credited;
 * what the flags decide is whether counting continues from `nowMs` or stops.
 * That is what makes "pause at 5s, resume at 5min" bill 5s rather than 5min,
 * and makes a scrub discard the time skipped over.
 */
export function tickWatchClock(
    clock: WatchClock,
    nowMs: number,
    playing: boolean,
    seeking: boolean,
): WatchClock {
    const wasCounting = clock.lastTickMs !== null
    const elapsedMs = wasCounting ? nowMs - (clock.lastTickMs as number) : 0
    // A backwards clock (NTP step, background tab) must not subtract watch time.
    const deltaSeconds = elapsedMs > 0 ? elapsedMs / 1000 : 0

    return {
        watchedSeconds: clock.watchedSeconds + deltaSeconds,
        lastTickMs: playing && !seeking ? nowMs : null,
    }
}

/**
 * Take the accumulated watch time, resetting the clock.
 *
 * Returns whole milliseconds of precision rather than rounding here — callers
 * report `watchedDelta` in seconds and the server hashes on it.
 */
export function drainWatchClock(clock: WatchClock): { seconds: number; clock: WatchClock } {
    return {
        seconds: clock.watchedSeconds,
        clock: { watchedSeconds: 0, lastTickMs: clock.lastTickMs },
    }
}
