import { describe, expect, it } from 'vitest'
import {
    createAnalyticsEvent,
    drainWatchClock,
    initialWatchClock,
    resolveAnalyticsUserId,
    tickWatchClock,
    type WatchClock,
} from '../src/analyticsQueue'

describe('resolveAnalyticsUserId', () => {
    it('prefers userId', () => {
        expect(resolveAnalyticsUserId({ userId: 'user_1', envKey: 'pk_legacy' })).toBe('user_1')
    })

    it('accepts envKey as the deprecated alias', () => {
        expect(resolveAnalyticsUserId({ envKey: 'user_1' })).toBe('user_1')
    })

    it('reports nothing for an anonymous viewer', () => {
        expect(resolveAnalyticsUserId({})).toBeUndefined()
        expect(resolveAnalyticsUserId({ userId: '', envKey: null })).toBeUndefined()
    })
})

describe('createAnalyticsEvent', () => {
    it('emits the fields the journal endpoint reads', () => {
        const event = createAnalyticsEvent({
            event: 'heartbeat',
            videoId: 'video-1',
            sessionId: 'session-1',
            userId: 'user_1',
            currentTime: 12.5,
            duration: 600,
            watchedDelta: 10,
            now: new Date('2024-01-01T00:00:00.000Z'),
        })

        expect(event).toEqual({
            event: 'heartbeat',
            ts: '2024-01-01T00:00:00.000Z',
            videoId: 'video-1',
            sessionId: 'session-1',
            userId: 'user_1',
            currentTime: 12.5,
            duration: 600,
            watchedDelta: 10,
        })
    })

    it('omits identity and errorCode when they are absent', () => {
        const event = createAnalyticsEvent({
            event: 'play',
            videoId: 'video-1',
            sessionId: 'session-1',
            currentTime: 0,
            duration: 0,
        })

        expect(event).not.toHaveProperty('userId')
        expect(event).not.toHaveProperty('errorCode')
        expect(event.watchedDelta).toBe(0)
    })

    it('includes an error code when there is one', () => {
        const event = createAnalyticsEvent({
            event: 'error',
            videoId: 'video-1',
            sessionId: 'session-1',
            currentTime: 3,
            duration: 600,
            errorCode: 'MEDIA_ERR_DECODE',
        })

        expect(event.errorCode).toBe('MEDIA_ERR_DECODE')
    })
})

describe('tickWatchClock', () => {
    it('starts an interval on the first tick and accumulates between ticks', () => {
        const started = tickWatchClock(initialWatchClock, 1_000, true, false)
        expect(started).toEqual({ watchedSeconds: 0, lastTickMs: 1_000 })

        const afterOneSecond = tickWatchClock(started, 2_000, true, false)
        expect(afterOneSecond.watchedSeconds).toBe(1)

        const afterThreeSeconds = tickWatchClock(afterOneSecond, 4_000, true, false)
        expect(afterThreeSeconds.watchedSeconds).toBe(3)
    })

    it('credits the interval up to a pause, then stops counting', () => {
        const playing = tickWatchClock(initialWatchClock, 1_000, true, false)
        const paused = tickWatchClock(playing, 5_000, false, false)

        // 4s elapsed between ticks, all of it while playing.
        expect(paused).toEqual({ watchedSeconds: 4, lastTickMs: null })

        // The minutes spent paused are not billed when playback resumes.
        const resumed = tickWatchClock(paused, 305_000, true, false)
        expect(resumed).toEqual({ watchedSeconds: 4, lastTickMs: 305_000 })
    })

    it('discards the gap introduced by a seek', () => {
        const playing = tickWatchClock(initialWatchClock, 1_000, true, false)
        const seeking = tickWatchClock(playing, 2_000, true, true)

        expect(seeking.watchedSeconds).toBe(1)
        expect(seeking.lastTickMs).toBeNull()

        // A 10-minute scrub must not be reported as watched content.
        const resumed = tickWatchClock(seeking, 602_000, true, false)
        expect(resumed.watchedSeconds).toBe(1)
        expect(resumed.lastTickMs).toBe(602_000)
    })

    it('ignores a backwards clock instead of subtracting watch time', () => {
        const playing = tickWatchClock(initialWatchClock, 10_000, true, false)
        const stepped = tickWatchClock(playing, 9_000, true, false)

        expect(stepped.watchedSeconds).toBe(0)
        expect(stepped.lastTickMs).toBe(9_000)
    })

    it('does not count a gap that began while paused', () => {
        const paused: WatchClock = { watchedSeconds: 42, lastTickMs: null }
        const resumed = tickWatchClock(paused, 100_000, true, false)

        expect(resumed).toEqual({ watchedSeconds: 42, lastTickMs: 100_000 })
    })
})

describe('drainWatchClock', () => {
    it('returns the accumulated seconds and resets the total', () => {
        const clock = tickWatchClock(tickWatchClock(initialWatchClock, 0, true, false), 2_500, true, false)

        const drained = drainWatchClock(clock)

        expect(drained.seconds).toBe(2.5)
        expect(drained.clock.watchedSeconds).toBe(0)
        // Counting continues from the same tick boundary.
        expect(drained.clock.lastTickMs).toBe(2_500)
    })

    it('is a no-op when nothing was watched', () => {
        const drained = drainWatchClock(initialWatchClock)

        expect(drained.seconds).toBe(0)
        expect(drained.clock).toEqual(initialWatchClock)
    })
})
