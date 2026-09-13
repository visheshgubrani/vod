/**
 * Rate-limit contract — the single surface every adapter satisfies.
 *
 * This lived implicitly in `app.ts` while there was exactly one pairing
 * (Upstash-or-memory) and one call site. With a third adapter (a plain Redis
 * over TCP, for self-hosted runtimes that must not depend on a hosted service)
 * the shape is worth naming: `app.ts` learns one method, and each adapter — and
 * its tests — crosses the same seam.
 */

export type RateLimitDecision = {
  success: boolean
  limit: number
  remaining: number
  /** Epoch ms when the window resets. */
  reset: number
  /**
   * Work the adapter wants to finish after the response (Upstash syncs
   * analytics with it). `Promise.resolve()` when there is nothing to do, so the
   * call site never branches.
   */
  pending: Promise<unknown>
}

export interface RateLimiter {
  limit(identifier: string): Promise<RateLimitDecision>
}
