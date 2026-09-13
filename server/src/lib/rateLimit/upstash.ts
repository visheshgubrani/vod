/**
 * Upstash Redis (REST) rate-limit adapter.
 *
 * The only shared-store adapter that works on **both** runtimes: Upstash speaks
 * HTTP, so Cloudflare Workers can use it despite having no TCP sockets. Kept
 * lazy (`@upstash/ratelimit` is a real dependency, not a type import) because
 * the default Node configuration uses a plain Redis instead and should not pay
 * for it.
 */

import { Ratelimit, type Duration } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { RateLimitDecision, RateLimiter } from './contract'

export type UpstashLimiterInput = {
  url: string
  token: string
  /** Key prefix shared by every scope in this deployment. */
  prefix: string
  /** Key prefix for this limiter (auth/api/analytics). */
  scope: string
  requests: number
  window: Duration
  /** Upstash-side analytics. Off by default: it costs a request per call. */
  analytics: boolean
}

export function createUpstashLimiter(input: UpstashLimiterInput): RateLimiter {
  const redis = new Redis({ url: input.url, token: input.token })

  const upstash = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(input.requests, input.window),
    prefix: `${input.prefix}:${input.scope}`,
    analytics: input.analytics,
    // Per-isolate cache so a burst on one instance does not hit the network for
    // every request. Upstash still enforces the real limit.
    ephemeralCache: new Map<string, number>(),
  })

  return {
    limit: async (identifier) =>
      (await upstash.limit(identifier)) as unknown as RateLimitDecision,
  }
}
