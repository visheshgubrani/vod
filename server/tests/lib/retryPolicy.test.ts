import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEBHOOK_RETRY,
  decideDeliveryOutcome,
  isRetryableStatus,
  nextAttemptDelayMs,
} from '../../src/lib/retryPolicy'

describe('isRetryableStatus', () => {
  it('treats a missing response as transient', () => {
    expect(isRetryableStatus(null)).toBe(true)
    expect(isRetryableStatus(undefined)).toBe(true)
  })

  it('treats 5xx and 3xx as transient', () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(302)).toBe(true)
  })

  it('treats a plain 4xx rejection as terminal', () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isRetryableStatus(status), `status ${status}`).toBe(false)
    }
  })

  it('retries the two 4xx that are explicit requests to come back', () => {
    // 408 = the receiver timed out, 429 = the receiver is rate limiting us.
    expect(isRetryableStatus(408)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
  })
})

describe('nextAttemptDelayMs', () => {
  it('doubles from the base and never exceeds the ceiling', () => {
    // Literals: 30s, 60s, 120s, 240s, 480s, 960s, then capped at 1h.
    expect(nextAttemptDelayMs(0)).toBe(30_000)
    expect(nextAttemptDelayMs(1)).toBe(60_000)
    expect(nextAttemptDelayMs(2)).toBe(120_000)
    expect(nextAttemptDelayMs(3)).toBe(240_000)
    expect(nextAttemptDelayMs(4)).toBe(480_000)
    expect(nextAttemptDelayMs(5)).toBe(960_000)
    expect(nextAttemptDelayMs(20)).toBe(3_600_000)
  })

  it('treats a negative attempt count as the first attempt', () => {
    expect(nextAttemptDelayMs(-3)).toBe(30_000)
  })

  it('honours a custom policy', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 }
    expect(nextAttemptDelayMs(0, policy)).toBe(1_000)
    expect(nextAttemptDelayMs(1, policy)).toBe(2_000)
    expect(nextAttemptDelayMs(2, policy)).toBe(4_000)
    expect(nextAttemptDelayMs(3, policy)).toBe(5_000)
  })

  it('exposes the documented defaults', () => {
    expect(DEFAULT_WEBHOOK_RETRY).toEqual({
      maxAttempts: 6,
      baseDelayMs: 30_000,
      maxDelayMs: 3_600_000,
    })
  })
})

describe('decideDeliveryOutcome', () => {
  it('reports success for any 2xx', () => {
    expect(decideDeliveryOutcome({ attemptsMade: 1, status: 200 })).toEqual({
      kind: 'delivered',
    })
    expect(decideDeliveryOutcome({ attemptsMade: 1, status: 202 })).toEqual({
      kind: 'delivered',
    })
  })

  it('gives up immediately on a non-retryable rejection', () => {
    const outcome = decideDeliveryOutcome({ attemptsMade: 1, status: 422 })
    expect(outcome.kind).toBe('give-up')
    expect(outcome.kind === 'give-up' && outcome.reason).toContain('HTTP 422')
  })

  it('schedules a retry with the attempt-indexed delay', () => {
    expect(decideDeliveryOutcome({ attemptsMade: 1, status: 500 })).toEqual({
      kind: 'retry',
      delayMs: 60_000,
    })
    expect(decideDeliveryOutcome({ attemptsMade: 3, status: null })).toEqual({
      kind: 'retry',
      delayMs: 240_000,
    })
  })

  it('gives up once the attempt budget is spent', () => {
    const outcome = decideDeliveryOutcome({ attemptsMade: 6, status: 503 })
    expect(outcome.kind).toBe('give-up')
    expect(outcome.kind === 'give-up' && outcome.reason).toContain('6 attempts')
  })

  it('retries a network failure where no response arrived', () => {
    const outcome = decideDeliveryOutcome({
      attemptsMade: 1,
      status: null,
      error: 'ECONNREFUSED',
    })
    expect(outcome.kind).toBe('retry')
  })

  it('names the transport error when giving up without a response', () => {
    const outcome = decideDeliveryOutcome({
      attemptsMade: 6,
      status: null,
      error: 'ECONNREFUSED',
    })
    expect(outcome.kind === 'give-up' && outcome.reason).toContain('ECONNREFUSED')
  })
})
