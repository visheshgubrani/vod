/**
 * Retry policy for webhook delivery.
 *
 * Pure rules, no I/O, so the awkward cases are pinned down with literals rather
 * than discovered in production: which HTTP responses are worth retrying, how
 * long to wait, and when to stop.
 *
 * Delivery is at-least-once. A retry therefore must be safe for the receiver,
 * which is why the event id is stable across attempts and receivers deduplicate
 * on it. Nothing here tries to achieve exactly-once: a response lost after the
 * receiver committed its side effect is indistinguishable from one lost before.
 */

export type RetryPolicy = {
  /** Total attempts allowed, including the first. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_WEBHOOK_RETRY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
}

/**
 * Is this HTTP status worth another attempt?
 *
 * 4xx means the receiver understood and refused — retrying the same body will
 * produce the same refusal, so it is terminal. The two exceptions are timeouts
 * (408) and rate limiting (429), where the receiver is explicitly asking us to
 * come back.
 *
 * 5xx, and a null status (network error, DNS failure, timeout — no response at
 * all), are transient.
 */
export function isRetryableStatus(status: number | null | undefined): boolean {
  if (status == null) return true
  if (status === 408 || status === 429) return true
  if (status >= 400 && status < 500) return false
  return true
}

/**
 * Delay before the next attempt. `attempts` is how many have already happened.
 *
 * Exponential with a ceiling: 30s, 60s, 120s, 240s, 480s, then capped at 1h.
 */
export function nextAttemptDelayMs(
  attempts: number,
  policy: RetryPolicy = DEFAULT_WEBHOOK_RETRY,
): number {
  const safeAttempts = Math.max(0, Math.floor(attempts))
  const exponential = policy.baseDelayMs * 2 ** safeAttempts
  return Math.min(exponential, policy.maxDelayMs)
}

export type DeliveryOutcome =
  | { kind: 'delivered' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'give-up'; reason: string }

/**
 * Decide what to do after one delivery attempt.
 *
 * `attemptsMade` includes the attempt being judged, so the first failure is
 * `attemptsMade: 1`.
 */
export function decideDeliveryOutcome(input: {
  attemptsMade: number
  /** HTTP status, or null when no response was received. */
  status: number | null
  /** Transport error message, when the request never completed. */
  error?: string | null
  policy?: RetryPolicy
}): DeliveryOutcome {
  const policy = input.policy ?? DEFAULT_WEBHOOK_RETRY
  const { attemptsMade, status } = input

  if (status != null && status >= 200 && status < 300) {
    return { kind: 'delivered' }
  }

  if (!isRetryableStatus(status)) {
    return {
      kind: 'give-up',
      reason: `receiver rejected with HTTP ${status}; retrying the same body cannot succeed`,
    }
  }

  if (attemptsMade >= policy.maxAttempts) {
    return {
      kind: 'give-up',
      reason: `exhausted ${policy.maxAttempts} attempts (last status ${
        status ?? input.error ?? 'no response'
      })`,
    }
  }

  return { kind: 'retry', delayMs: nextAttemptDelayMs(attemptsMade, policy) }
}
