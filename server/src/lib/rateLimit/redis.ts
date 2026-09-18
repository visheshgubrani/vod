/**
 * Plain-Redis (TCP) rate-limit adapter.
 *
 * Why it exists: Upstash is a *hosted* service reached over REST. A self-hosted
 * installation already runs its own Redis for nothing else, and asking it to
 * sign up for a second vendor to run more than one API replica is a bad trade.
 * This adapter makes "shared rate limits" a deployment decision rather than a
 * vendor decision.
 *
 * Runtime: Node. Window semantics are a sorted-set sliding window, chosen to match
 * `InMemorySlidingWindow` exactly (`success/limit/remaining/reset`, reset =
 * oldest live timestamp + window) because both feed the same response headers
 * and the same tests. A fixed-window INCR counter would be cheaper and would
 * silently allow a 2x burst across a boundary.
 *
 * Failure policy: never fail open. If Redis is unreachable the adapter falls
 * back to the in-memory window for that request and reports the error through
 * `onError` — a limiter that disappears when its store does is worse than one
 * that is merely per-instance.
 */

import { InMemorySlidingWindow } from './memory'
import type { RateLimitDecision, RateLimiter } from './contract'

/** The subset of the node-redis client this adapter uses. */
export type RedisCommandClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>
}

export type RedisLimiterInput = {
  url: string
  /** Key prefix shared by every scope in this deployment. */
  prefix: string
  /** Key prefix for this limiter (auth/api/analytics). */
  scope: string
  requests: number
  windowMs: number
  /**
   * Connect (or reuse) a client. Injected so the adapter is testable without a
   * live server, and so `redis` — a real dependency — is only imported on the
   * Node path that uses it.
   */
  connect?: (url: string) => Promise<RedisCommandClient>
  /** Per-scope fallback used when Redis is unavailable. */
  fallback?: InMemorySlidingWindow
  onError?: (error: unknown, context: string) => void
}

/**
 * KEYS[1] key, ARGV[1] now (ms), ARGV[2] window (ms), ARGV[3] max,
 * ARGV[4] unique member.
 *
 * Returns { allowed, limit, remaining, reset } with the same meaning as the
 * in-memory adapter: `remaining` counts the window *after* this request.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local allowed = count < max
if allowed then
  redis.call('ZADD', key, now, member)
  count = count + 1
end
redis.call('PEXPIRE', key, window)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local reset = now + window
if oldest[2] then
  reset = tonumber(oldest[2]) + window
end
return { allowed and 1 or 0, max, math.max(0, max - count), reset }
`

/** Lazily creates and shares one node-redis client per URL. */
function defaultConnect(url: string): Promise<RedisCommandClient> {
  const key = `redis:${url}`
  const cached = connections.get(key)
  if (cached) return cached

  const pending = (async () => {
    // Dynamic import keeps `redis` out of unused composition paths.
    const { createClient } = await import('redis')
    const client = createClient({ url })
    // node-redis emits 'error' out of band; without a handler it is an
    // unhandled 'error' event, which takes the process down.
    client.on('error', (error: unknown) => {
      console.error('[rate-limit] redis client error:', error)
    })
    await client.connect()
    return client as unknown as RedisCommandClient
  })()

  // A failed connection must not be cached forever: the next request retries.
  connections.set(
    key,
    pending.catch((error) => {
      connections.delete(key)
      throw error
    }),
  )
  return connections.get(key)!
}

const connections = new Map<string, Promise<RedisCommandClient>>()

/** Drop cached connections. Tests only. */
export function resetRedisConnections(): void {
  connections.clear()
}

function parseReply(raw: unknown): RateLimitDecision | null {
  if (!Array.isArray(raw) || raw.length < 4) return null
  const [allowed, limit, remaining, reset] = raw.map((value) => Number(value))
  if (![allowed, limit, remaining, reset].every((value) => Number.isFinite(value))) {
    return null
  }
  return {
    success: allowed === 1,
    limit,
    remaining: Math.max(0, remaining),
    reset,
    pending: Promise.resolve(),
  }
}

export function createRedisLimiter(input: RedisLimiterInput): RateLimiter {
  const connect = input.connect ?? defaultConnect
  const keyPrefix = `${input.prefix}:${input.scope}`
  const fallback =
    input.fallback ??
    new InMemorySlidingWindow({ max: input.requests, windowMs: input.windowMs })

  return {
    async limit(identifier) {
      const key = `${keyPrefix}:${identifier}`
      try {
        const client = await connect(input.url)
        const reply = await client.eval(SLIDING_WINDOW_LUA, {
          keys: [key],
          arguments: [
            String(Date.now()),
            String(input.windowMs),
            String(input.requests),
            `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ],
        })
        const decision = parseReply(reply)
        if (!decision) {
          throw new Error(`unexpected reply from EVAL: ${JSON.stringify(reply)}`)
        }
        return decision
      } catch (error) {
        // Degrade, do not disappear: the fallback still enforces a limit.
        input.onError?.(error, 'rate-limit redis unavailable; using in-memory window')
        const decision = fallback.limit(identifier)
        return { ...decision, pending: Promise.resolve() }
      }
    },
  }
}
