import { describe, expect, it, vi } from 'vitest'
import { InMemorySlidingWindow } from '../../../src/lib/rateLimit/memory'
import { createRedisLimiter, type RedisCommandClient } from '../../../src/lib/rateLimit/redis'

/**
 * The Redis adapter, tested through a scripted client.
 *
 * A live-Redis integration test is gated on `TEST_REDIS_URL`, but the behaviour
 * that matters here is what the adapter *asks* for and what it does when the
 * answer is wrong or absent — neither of which needs a server.
 */

const WINDOW_MS = 1_000
const MAX = 3

function clientWithReply(reply: unknown) {
  const calls: Array<{ script: string; keys: string[]; arguments: string[] }> = []
  const client: RedisCommandClient = {
    async eval(script, options) {
      calls.push({ script, keys: options.keys, arguments: options.arguments })
      return reply
    },
  }
  return { client, calls }
}

function limiterWith(client: RedisCommandClient, onError = vi.fn()) {
  return {
    onError,
    limiter: createRedisLimiter({
      url: 'redis://localhost:6379',
      prefix: 'vod:ratelimit',
      scope: 'api',
      requests: MAX,
      windowMs: WINDOW_MS,
      connect: async () => client,
      onError,
    }),
  }
}

describe('createRedisLimiter', () => {
  it('maps a reply to the same decision shape as the in-memory adapter', async () => {
    const { client } = clientWithReply([1, MAX, 2, 1_000_000 + WINDOW_MS])
    const { limiter } = limiterWith(client)

    const decision = await limiter.limit('ip-1')
    expect(decision).toMatchObject({
      success: true,
      limit: MAX,
      remaining: 2,
      reset: 1_000_000 + WINDOW_MS,
    })
    expect(decision.pending).toBeInstanceOf(Promise)
  })

  it('reports a refused request', async () => {
    const { client } = clientWithReply([0, MAX, 0, 1_000_000 + WINDOW_MS])
    const { limiter } = limiterWith(client)

    expect((await limiter.limit('ip-1')).success).toBe(false)
  })

  it('runs one sliding-window script against the namespaced key, with unique members', async () => {
    // Distinct members matter: ZADD with an equal score *and* member would
    // overwrite an earlier request in the same millisecond and undercount it.
    const { client, calls } = clientWithReply([1, MAX, 2, 1])
    const { limiter } = limiterWith(client)

    await limiter.limit('ip-1')
    await limiter.limit('ip-1')

    expect(calls).toHaveLength(2)
    expect(calls[0].keys).toEqual(['vod:ratelimit:api:ip-1'])
    expect(calls[0].script).toContain('ZREMRANGEBYSCORE')
    expect(calls[0].script).toContain('ZADD')
    expect(calls[0].script).toContain('PEXPIRE')
    expect(calls[0].arguments[1]).toBe(String(WINDOW_MS))
    expect(calls[0].arguments[2]).toBe(String(MAX))
    expect(calls[1].arguments[3]).not.toBe(calls[0].arguments[3])
  })

  it('degrades to the in-memory window when Redis is unreachable, never fail-open', async () => {
    const onError = vi.fn()
    const fallback = new InMemorySlidingWindow({ max: 1, windowMs: WINDOW_MS })
    const limiter = createRedisLimiter({
      url: 'redis://localhost:6379',
      prefix: 'vod:ratelimit',
      scope: 'api',
      requests: 1,
      windowMs: WINDOW_MS,
      connect: async () => {
        throw new Error('ECONNREFUSED')
      },
      fallback,
      onError,
    })

    expect((await limiter.limit('ip-1')).success).toBe(true)
    expect((await limiter.limit('ip-1')).success).toBe(false)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls[0][1]).toMatch(/using in-memory window/)
  })

  it('treats a malformed reply as a failure rather than as "allowed"', async () => {
    const onError = vi.fn()
    const { client } = clientWithReply(['not-a-number'])
    const { limiter } = limiterWith(client, onError)

    const decision = await limiter.limit('ip-1')
    expect(decision.success).toBe(true) // the in-memory fallback's first request
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0])).toMatch(/unexpected reply/)
  })
})

/**
 * Against a real server.
 *
 * The scripted client above pins the *contract*; only a real Redis proves the Lua
 * actually runs — a syntax error, a wrong return shape from `EVAL`, or a key-type
 * clash would all pass the fakes and fail here. Gated like the Postgres suites so
 * `pnpm test` still works with no Redis; CI provides one.
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? ''
const suiteKey = `clipmux-test:${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!TEST_REDIS_URL)('createRedisLimiter (real Redis)', () => {
  it('enforces a sliding window and reports the same numbers as the memory adapter', async () => {
    const make = (scope: string) =>
      createRedisLimiter({
        url: TEST_REDIS_URL,
        prefix: suiteKey,
        scope,
        requests: 2,
        windowMs: WINDOW_MS,
      })

    const limiter = make('parity')
    const memory = new InMemorySlidingWindow({ max: 2, windowMs: WINDOW_MS })

    const first = await limiter.limit('ip-1')
    expect(first).toMatchObject({ success: true, limit: 2, remaining: 1 })

    const second = await limiter.limit('ip-1')
    expect(second.success).toBe(true)
    expect(second.remaining).toBe(0)

    const third = await limiter.limit('ip-1')
    expect(third.success).toBe(false)
    expect(third.remaining).toBe(0)

    // Same shape as the in-memory adapter for the same first request.
    const memoryFirst = memory.limit('ip-1', Date.now())
    expect(first.limit).toBe(memoryFirst.limit)
    expect(first.remaining).toBe(memoryFirst.remaining)

    // A different key is unaffected.
    expect((await limiter.limit('ip-2')).success).toBe(true)
  })

  it('isolates scopes by prefix', async () => {
    const auth = createRedisLimiter({
      url: TEST_REDIS_URL,
      prefix: suiteKey,
      scope: 'auth',
      requests: 1,
      windowMs: WINDOW_MS,
    })
    const api = createRedisLimiter({
      url: TEST_REDIS_URL,
      prefix: suiteKey,
      scope: 'api',
      requests: 1,
      windowMs: WINDOW_MS,
    })

    expect((await auth.limit('same-ip')).success).toBe(true)
    expect((await auth.limit('same-ip')).success).toBe(false)
    expect((await api.limit('same-ip')).success).toBe(true)
  })
})
