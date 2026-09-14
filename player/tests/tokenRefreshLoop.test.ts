import { describe, expect, it } from 'vitest'
import { planNextRefresh, retryDelayMs } from '../src/tokenRefreshLoop'

/** Build a JWT-shaped token with a given `exp` (no signature needed). */
function tokenExpiringAt(exp: number): string {
    const payload = btoa(JSON.stringify({ video_id: 'v1', exp }))
    return `header.${payload}.sig`
}

const NOW = 1_700_000_000

describe('planNextRefresh', () => {
    it('waits until the lead window before expiry', () => {
        // 1000s of life left, refresh 60s before the end.
        const decision = planNextRefresh({ token: tokenExpiringAt(NOW + 1000), nowEpochSec: NOW })

        expect(decision).toEqual({ kind: 'wait', delayMs: 1000 * 1000 - 60_000 })
    })

    it('refreshes immediately when the token is inside its lead window', () => {
        const decision = planNextRefresh({ token: tokenExpiringAt(NOW + 30), nowEpochSec: NOW })

        expect(decision).toEqual({ kind: 'wait', delayMs: 0 })
    })

    it('refreshes immediately when the token is already expired', () => {
        const decision = planNextRefresh({ token: tokenExpiringAt(NOW - 5), nowEpochSec: NOW })

        expect(decision).toEqual({ kind: 'wait', delayMs: 0 })
    })

    it('backs off exponentially after failures once the token is due', () => {
        const token = tokenExpiringAt(NOW - 5)

        expect(planNextRefresh({ token, nowEpochSec: NOW, failures: 1 })).toEqual({
            kind: 'wait',
            delayMs: 1_000,
        })
        expect(planNextRefresh({ token, nowEpochSec: NOW, failures: 2 })).toEqual({
            kind: 'wait',
            delayMs: 2_000,
        })
        expect(planNextRefresh({ token, nowEpochSec: NOW, failures: 3 })).toEqual({
            kind: 'wait',
            delayMs: 4_000,
        })
    })

    it('caps the retry delay instead of growing without bound', () => {
        const token = tokenExpiringAt(NOW - 5)
        const decision = planNextRefresh({
            token,
            nowEpochSec: NOW,
            failures: 8,
            maxFailures: 10,
        })

        expect(decision).toEqual({ kind: 'wait', delayMs: 60_000 })
    })

    it('stops after the configured number of consecutive failures', () => {
        const token = tokenExpiringAt(NOW - 5)

        expect(planNextRefresh({ token, nowEpochSec: NOW, failures: 4, maxFailures: 5 })).toEqual({
            kind: 'wait',
            delayMs: 8_000,
        })
        expect(planNextRefresh({ token, nowEpochSec: NOW, failures: 5, maxFailures: 5 })).toEqual({
            kind: 'stop',
            reason: 'too-many-failures',
        })
    })

    it('keeps the expiry anchor when a failure happened early', () => {
        // Still 10 minutes of life: a failed early refresh must not shorten the
        // wait to a retry interval — the token has not expired yet.
        const decision = planNextRefresh({
            token: tokenExpiringAt(NOW + 600),
            nowEpochSec: NOW,
            failures: 3,
        })

        expect(decision).toEqual({ kind: 'wait', delayMs: 600_000 - 60_000 })
    })

    it('uses a fixed interval for a token without a readable exp', () => {
        expect(planNextRefresh({ token: 'opaque-token', nowEpochSec: NOW })).toEqual({
            kind: 'wait',
            delayMs: 5 * 60_000,
        })
        // ...and backs off when those polls fail.
        expect(planNextRefresh({ token: 'opaque-token', nowEpochSec: NOW, failures: 2 })).toEqual({
            kind: 'wait',
            delayMs: 2_000,
        })
    })

    it('never schedules before a token exists', () => {
        expect(planNextRefresh({ token: '', nowEpochSec: NOW })).toEqual({
            kind: 'wait',
            delayMs: 5 * 60_000,
        })
    })

    it('stops for good once the session ended', () => {
        expect(
            planNextRefresh({ token: tokenExpiringAt(NOW + 1000), nowEpochSec: NOW, stopped: true }),
        ).toEqual({ kind: 'stop', reason: 'stopped' })
    })

    it('honours a custom lead time', () => {
        const decision = planNextRefresh({
            token: tokenExpiringAt(NOW + 300),
            nowEpochSec: NOW,
            leadMs: 120_000,
        })

        expect(decision).toEqual({ kind: 'wait', delayMs: 300_000 - 120_000 })
    })
})

describe('retryDelayMs', () => {
    it('doubles from one second and stops at a minute', () => {
        expect(retryDelayMs(1)).toBe(1_000)
        expect(retryDelayMs(2)).toBe(2_000)
        expect(retryDelayMs(6)).toBe(32_000)
        expect(retryDelayMs(7)).toBe(60_000)
        expect(retryDelayMs(30)).toBe(60_000)
    })

    it('treats a zero failure count as the first retry delay', () => {
        expect(retryDelayMs(0)).toBe(1_000)
    })
})
