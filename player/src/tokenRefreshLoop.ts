/**
 * Playback-token refresh scheduling (pure — no React, no timers).
 *
 * A signed playback token expires; long-form content outlives it. The player
 * must ask for a fresh one shortly before that happens, keep playing if the
 * request fails, and eventually give up instead of hammering the API.
 *
 * This module decides *when* to ask. `OpenVodPlayer` owns the timer and the
 * network call, so the policy is testable without rendering anything.
 *
 * Failure behavior matters more than it looks: an earlier implementation
 * re-scheduled on every failure with a 1-second floor, so an expired token
 * became ~60 requests/minute forever against an endpoint that shares the API's
 * rate-limit budget. Here a failure backs off exponentially, is capped, and
 * stops after `maxFailures` consecutive failures.
 */

import { planRefreshForToken } from './tokenRefresh'

/** Retry delays after a failed refresh, before capping. */
const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 60_000
/** Refresh at least this far before expiry. */
const DEFAULT_LEAD_MS = 60_000
/**
 * Interval used when the token's `exp` cannot be read — an opaque token, or one
 * minted by a proxy that re-shapes the response. Refreshing every 5 minutes is
 * wasteful but safe; never refreshing is not, because playback would simply die
 * at expiry.
 */
const FALLBACK_INTERVAL_MS = 5 * 60_000

export interface RefreshScheduleInput {
    /**
     * The token currently in use. Empty before the first token is known — the
     * planner then uses the fallback interval rather than stopping.
     */
    token: string
    /** Current time in epoch seconds. */
    nowEpochSec: number
    /** How long before expiry to refresh (default 60s). */
    leadMs?: number
    /** Consecutive failures so far (0 right after a success). */
    failures?: number
    /** Give up after this many consecutive failures (default 5). */
    maxFailures?: number
    /** Never schedule again — the playback session ended. */
    stopped?: boolean
}

export type RefreshDecision =
    | { kind: 'wait'; delayMs: number }
    | { kind: 'stop'; reason: 'stopped' | 'too-many-failures' }

/**
 * Decide what the refresh loop should do next.
 *
 * While the token is still valid the wait stays anchored to its expiry: an
 * early refresh that failed should not move the next attempt *earlier* than
 * the token's actual due time.
 */
export function planNextRefresh(input: RefreshScheduleInput): RefreshDecision {
    const {
        token,
        nowEpochSec,
        leadMs = DEFAULT_LEAD_MS,
        failures = 0,
        maxFailures = 5,
        stopped = false,
    } = input

    if (stopped) return { kind: 'stop', reason: 'stopped' }
    if (failures >= maxFailures) {
        return { kind: 'stop', reason: 'too-many-failures' }
    }

    const plan = token ? planRefreshForToken(token, nowEpochSec, leadMs) : null

    // No readable expiry: poll on a fixed interval, but back off on failure so a
    // broken endpoint cannot be hammered.
    if (!plan) {
        if (failures === 0) return { kind: 'wait', delayMs: FALLBACK_INTERVAL_MS }
        return { kind: 'wait', delayMs: retryDelayMs(failures) }
    }

    // Due now (or already expired): retry with backoff until maxFailures.
    if (plan.due || plan.delayMs <= 0) {
        return { kind: 'wait', delayMs: failures === 0 ? 0 : retryDelayMs(failures) }
    }

    return { kind: 'wait', delayMs: plan.delayMs }
}

/** Exponential backoff for a failed refresh, capped. Exported for tests. */
export function retryDelayMs(failures: number): number {
    const exponent = Math.max(0, Math.min(failures, 16) - 1)
    return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent)
}
