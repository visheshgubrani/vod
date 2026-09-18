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
 * Precedence is a deployment decision (`REDIS_URL` → Upstash REST → in-memory).
 */

describe('resolveRateLimitConfig', () => {
  it('prefers a plain Redis, then Upstash, then memory', () => {
    const upstash = {
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    }

    expect(resolveRateLimitConfig({ ...upstash }).store).toBe('upstash')
    expect(
      resolveRateLimitConfig({ ...upstash, REDIS_URL: 'redis://localhost:6379' }).store,
    ).toBe('redis')
    expect(resolveRateLimitConfig({}).store).toBe('memory')
  })

  it('ignores half-configured Upstash rather than building a client without a token', () => {
    const config = resolveRateLimitConfig({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' })
    expect(config.store).toBe('memory')
    expect(config.upstash).toBeNull()
  })

  it('carries the documented defaults', () => {
    const { policies, prefix } = resolveRateLimitConfig({})

    expect(prefix).toBe('vod-app:ratelimit')
    expect(policies.auth).toMatchObject({ requests: 30, windowMs: 60_000 })
    expect(policies.api).toMatchObject({ requests: 120, windowMs: 60_000 })
    expect(policies.analytics).toMatchObject({ requests: 600, windowMs: 60_000 })
  })

  it('lets an operator override a limit without disabling the others', () => {
    const { policies } = resolveRateLimitConfig({
      RATE_LIMIT_API_MAX: '5',
      RATE_LIMIT_API_WINDOW: '30 s',
    })

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
    const factory = createRateLimiterFactory(resolveRateLimitConfig({}))
    const first = factory('api')
    expect(factory('api')).toBe(first)

    // Two calls on one instance are two requests in the same window.
    const a = await first.limit('ip')
    const b = await first.limit('ip')
    expect(a.remaining).toBe(119)
    expect(b.remaining).toBe(118)
  })
})
