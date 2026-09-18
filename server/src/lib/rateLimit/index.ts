/**
 * Rate limiting — one selection point, three adapters.
 *
 * | Store     | Why |
 * | --------- | --- |
 * | `redis`   | A self-hoster's own Redis. No second vendor. |
 * | `upstash` | REST Redis, optional. |
 * | `memory`  | Zero-config default; per instance only. |
 *
 * Selection precedence is fixed and reported by `/health/config`:
 * `REDIS_URL` → `UPSTASH_REDIS_REST_URL/TOKEN` → in-memory.
 */

import type { Duration } from '@upstash/ratelimit'
import type { EnvLike } from '../config'
import { InMemorySlidingWindow } from './memory'
import { createRedisLimiter } from './redis'
import { createUpstashLimiter } from './upstash'
import type { RateLimiter } from './contract'

export type { RateLimitDecision, RateLimiter } from './contract'
export { InMemorySlidingWindow } from './memory'
export { createRedisLimiter } from './redis'
export { createUpstashLimiter } from './upstash'

export type RateLimitStoreKind = 'redis' | 'upstash' | 'memory'

/** Which limiter a request path belongs to. */
export type RateLimitScope = 'auth' | 'api' | 'analytics'

export type RateLimitPolicy = {
  requests: number
  windowMs: number
  /** The same window in Upstash's own `Duration` notation ('1 m'). */
  window: Duration
}

export type RateLimitConfig = {
  store: RateLimitStoreKind
  prefix: string
  /** Upstash-side analytics for the limiter itself. Off unless asked for. */
  analytics: boolean
  redisUrl: string | null
  upstash: { url: string; token: string } | null
  policies: Record<RateLimitScope, RateLimitPolicy>
  /** Non-fatal notes (e.g. a store that had to be downgraded). */
  problems: string[]
}

export const DEFAULT_RATE_LIMIT_PREFIX = 'vod-app:ratelimit'

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const DURATION_PATTERN = /^\d+\s?(ms|s|m|h|d)$/

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

/** Parse '1 m' / '30 s'. Invalid values fall back rather than disabling a limit. */
export function parseDuration(value: string | undefined, fallback: Duration): Duration {
  const normalized = value?.trim()
  if (!normalized || !DURATION_PATTERN.test(normalized)) {
    return fallback
  }
  return normalized as Duration
}

export function durationToMs(value: Duration, fallbackMs: number): number {
  const match = String(value).trim().match(/^(\d+)\s*(ms|s|m|h|d)$/)
  if (!match) return fallbackMs
  return Number(match[1]) * (DURATION_UNIT_MS[match[2]] ?? 1)
}

function policy(
  env: EnvLike,
  prefix: string,
  defaults: { requests: number; window: Duration },
): RateLimitPolicy {
  const requests = parsePositiveInt(env[`${prefix}_MAX`], defaults.requests)
  const window = parseDuration(env[`${prefix}_WINDOW`], defaults.window)
  return {
    requests,
    window,
    windowMs: durationToMs(window, durationToMs(defaults.window, 60_000)),
  }
}

function value(env: EnvLike, key: string): string | null {
  const raw = env[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export function resolveRateLimitConfig(env: EnvLike): RateLimitConfig {
  const problems: string[] = []

  const redisUrl = value(env, 'REDIS_URL')
  const upstashUrl = value(env, 'UPSTASH_REDIS_REST_URL')
  const upstashToken = value(env, 'UPSTASH_REDIS_REST_TOKEN')
  const upstash = upstashUrl && upstashToken ? { url: upstashUrl, token: upstashToken } : null

  let store: RateLimitStoreKind = 'memory'
  if (redisUrl) {
    store = 'redis'
  } else if (upstash) {
    store = 'upstash'
  }

  return {
    store,
    prefix: value(env, 'RATE_LIMIT_PREFIX') ?? DEFAULT_RATE_LIMIT_PREFIX,
    analytics: value(env, 'RATE_LIMIT_ANALYTICS') === 'true',
    redisUrl,
    upstash,
    policies: {
      auth: policy(env, 'RATE_LIMIT_AUTH', { requests: 30, window: '1 m' as Duration }),
      api: policy(env, 'RATE_LIMIT_API', { requests: 120, window: '1 m' as Duration }),
      analytics: policy(env, 'RATE_LIMIT_ANALYTICS', {
        requests: 600,
        window: '1 m' as Duration,
      }),
    },
    problems,
  }
}

/** Which limiter a request path belongs to. */
export function resolveRateLimitScope(path: string): RateLimitScope {
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'auth'
  if (path === '/api/playback' || path.startsWith('/api/playback/')) return 'analytics'
  return 'api'
}

export type RateLimiterFactory = (scope: RateLimitScope) => RateLimiter

/**
 * Build the (scope → limiter) lookup for one deployment.
 *
 * Limiter instances are cached per scope: each carries connection state (an
 * Upstash ephemeral cache, a Redis client, an in-memory bucket map) that must
 * survive across requests or the limiter counts nothing.
 */
export function createRateLimiterFactory(
  config: RateLimitConfig,
  onError?: (error: unknown, context: string) => void,
): RateLimiterFactory {
  const cache = new Map<RateLimitScope, RateLimiter>()

  return (scope) => {
    const cached = cache.get(scope)
    if (cached) return cached

    const selected = config.policies[scope]
    let limiter: RateLimiter

    if (config.store === 'redis' && config.redisUrl) {
      limiter = createRedisLimiter({
        url: config.redisUrl,
        prefix: config.prefix,
        scope,
        requests: selected.requests,
        windowMs: selected.windowMs,
        ...(onError ? { onError } : {}),
      })
    } else if (config.store === 'upstash' && config.upstash) {
      limiter = createUpstashLimiter({
        url: config.upstash.url,
        token: config.upstash.token,
        prefix: config.prefix,
        scope,
        requests: selected.requests,
        window: selected.window,
        analytics: config.analytics,
      })
    } else {
      const memory = new InMemorySlidingWindow({
        max: selected.requests,
        windowMs: selected.windowMs,
      })
      limiter = {
        limit: async (identifier) => ({
          ...memory.limit(identifier),
          pending: Promise.resolve(),
        }),
      }
    }

    cache.set(scope, limiter)
    return limiter
  }
}
