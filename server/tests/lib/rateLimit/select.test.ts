import { describe, expect, it } from 'vitest'
import {
  createRateLimiterFactory,
  durationToMs,
  parseDuration,
  parsePositiveInt,
  resolveRateLimitConfig,
  resolveRateLimitScope,
} from '../../../src/lib/rateLimit'

/**
 * Rate-limit store selection.
 *
 * Precedence is a deployment decision (`REDIS_URL` → Upstash REST → in-memory),
 * and the Workers runtime must never be handed a TCP store: the failure mode is
 * the worst kind — limits that appear to work and are silently per-isolate.
 */

describe('resolveRateLimitConfig', () => {
  it('prefers a plain Redis, then Upstash, then memory', () => {
    const upstash = {
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    }

    expect(resolveRateLimitConfig({ ...upstash }, 'node').store).toBe('upstash')
    expect(
      resolveRateLimitConfig({ ...upstash, REDIS_URL: 'redis://localhost:6379' }, 'node').store,
    ).toBe('redis')
    expect(resolveRateLimitConfig({}, 'node').store).toBe('memory')
  })

  it('refuses a TCP Redis on Workers and says what to use instead', () => {
    const config = resolveRateLimitConfig({ REDIS_URL: 'redis://localhost:6379' }, 'workers')

    expect(config.store).toBe('memory')
    expect(config.problems.join('\n')).toMatch(/UPSTASH_REDIS_REST_URL/)
  })

  it('falls back to Upstash on Workers when both are configured', () => {
    const config = resolveRateLimitConfig(
      {
        REDIS_URL: 'redis://localhost:6379',
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'token',
      },
      'workers',
    )

    expect(config.store).toBe('upstash')
    expect(config.problems).toHaveLength(1)
  })

  it('ignores half-configured Upstash rather than building a client without a token', () => {
    const config = resolveRateLimitConfig(
      { UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' },
      'node',
    )
    expect(config.store).toBe('memory')
    expect(config.upstash).toBeNull()
  })

  it('carries the documented defaults', () => {
    const { policies, prefix } = resolveRateLimitConfig({}, 'node')

    expect(prefix).toBe('vod-app:ratelimit')
    expect(policies.auth).toMatchObject({ requests: 30, windowMs: 60_000 })
    expect(policies.api).toMatchObject({ requests: 120, windowMs: 60_000 })
    expect(policies.analytics).toMatchObject({ requests: 600, windowMs: 60_000 })
  })

  it('lets an operator override a limit without disabling the others', () => {
    const { policies } = resolveRateLimitConfig(
      { RATE_LIMIT_API_MAX: '5', RATE_LIMIT_API_WINDOW: '30 s' },
      'node',
    )

    expect(policies.api).toMatchObject({ requests: 5, windowMs: 30_000 })
    expect(policies.auth.requests).toBe(30)
  })
})

describe('policy parsing', () => {
  it('keeps the default on an invalid value rather than removing the limit', () => {
    expect(parsePositiveInt('0', 30)).toBe(30)
    expect(parsePositiveInt('-1', 30)).toBe(30)
    expect(parsePositiveInt('nonsense', 30)).toBe(30)
    expect(parsePositiveInt('45', 30)).toBe(45)
    expect(parseDuration('forever', '1 m')).toBe('1 m')
    expect(parseDuration('2 m', '1 m')).toBe('2 m')
    expect(durationToMs('2 m', 0)).toBe(120_000)
  })
})

describe('resolveRateLimitScope', () => {
  it('maps auth and playback to their own buckets', () => {
    expect(resolveRateLimitScope('/api/auth/sign-in')).toBe('auth')
    expect(resolveRateLimitScope('/api/playback/journal')).toBe('analytics')
    expect(resolveRateLimitScope('/api/video')).toBe('api')
  })
})

describe('createRateLimiterFactory', () => {
  it('caches one limiter per scope so its window survives across calls', async () => {
    const factory = createRateLimiterFactory(resolveRateLimitConfig({}, 'node'))
    const first = factory('api')
    expect(factory('api')).toBe(first)

    // Two calls on one instance are two requests in the same window.
    const a = await first.limit('ip')
    const b = await first.limit('ip')
    expect(a.remaining).toBe(119)
    expect(b.remaining).toBe(118)
  })
})
