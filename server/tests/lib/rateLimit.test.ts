import { describe, expect, it } from 'vitest'
import { InMemorySlidingWindow } from '../../src/lib/rateLimit/memory'

describe('InMemorySlidingWindow', () => {
  const WINDOW_MS = 1_000

  function makeLimiter(max = 3) {
    return new InMemorySlidingWindow({ max, windowMs: WINDOW_MS })
  }

  it('allows requests up to the limit and blocks the overflow', () => {
    const limiter = makeLimiter(3)
    const t0 = 1_000_000

    expect(limiter.limit('ip-1', t0)).toMatchObject({ success: true, remaining: 2 })
    expect(limiter.limit('ip-1', t0 + 100)).toMatchObject({ success: true, remaining: 1 })
    expect(limiter.limit('ip-1', t0 + 200)).toMatchObject({ success: true, remaining: 0 })
    expect(limiter.limit('ip-1', t0 + 300)).toMatchObject({ success: false, remaining: 0 })
  })

  it('slides the window so old timestamps stop counting', () => {
    const limiter = makeLimiter(2)
    const t0 = 1_000_000

    limiter.limit('ip-1', t0)
    limiter.limit('ip-1', t0 + 100)
    // blocked now…
    expect(limiter.limit('ip-1', t0 + 200).success).toBe(false)
    // …but once the first request leaves the window, one slot frees up
    expect(limiter.limit('ip-1', t0 + WINDOW_MS + 1).success).toBe(true)
  })

  it('reports limit and reset (epoch ms of window end)', () => {
    const limiter = makeLimiter(2)
    const t0 = 5_000_000

    const first = limiter.limit('ip-1', t0)
    expect(first.limit).toBe(2)
    expect(first.remaining).toBe(1)
    expect(first.reset).toBe(t0 + WINDOW_MS)
  })

  it('isolates different keys', () => {
    const limiter = makeLimiter(1)
    limiter.limit('ip-a', 100)
    expect(limiter.limit('ip-b', 100).success).toBe(true)
  })

  it('prunes expired buckets and never grows without bound', () => {
    const limiter = new InMemorySlidingWindow({ max: 2, windowMs: WINDOW_MS, maxKeys: 2 })
    const t0 = 1_000_000

    limiter.limit('a', t0)
    limiter.limit('b', t0)
    // A third key evicts the least-recently-used bucket (a).
    limiter.limit('c', t0)
    expect(limiter.limit('a', t0 + 50).success).toBe(true) // 'a' forgotten
    expect(limiter.bucketCount()).toBeLessThanOrEqual(2)
  })

  it('forgets expired buckets on access', () => {
    const limiter = makeLimiter(1)
    limiter.limit('ip-1', 1_000_000)
    limiter.limit('ip-1', 2_000_000 + WINDOW_MS) // far future: old bucket expired
    expect(limiter.bucketCount()).toBe(1)
  })
})
