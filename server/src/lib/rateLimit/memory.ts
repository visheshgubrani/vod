/**
 * In-memory sliding-window rate limiter.
 *
 * Zero-dependency default for single-instance deployments. Semantics mirror
 * the Upstash Ratelimit surface used by app.ts (success/limit/remaining/reset)
 * so the two can swap behind one seam. Per-isolate state: deployments with
 * multiple API instances must configure the Redis (Upstash) adapter instead —
 * documented in README/deploy docs.
 */

export type MemoryLimitResult = {
  success: boolean
  limit: number
  remaining: number
  /** Epoch ms at which the current window ends. */
  reset: number
}

export type MemoryLimiterOptions = {
  max: number
  windowMs: number
  /** Bounded LRU capacity. Default 10_000 keys. */
  maxKeys?: number
}

export class InMemorySlidingWindow {
  private readonly max: number
  private readonly windowMs: number
  private readonly maxKeys: number
  /** key -> request timestamps within the current window (insertion order). */
  private readonly buckets = new Map<string, number[]>()

  constructor(options: MemoryLimiterOptions) {
    this.max = options.max
    this.windowMs = options.windowMs
    this.maxKeys = options.maxKeys ?? 10_000
  }

  bucketCount(): number {
    return this.buckets.size
  }

  /**
   * Record a request at `nowMs` (defaults to Date.now()) and report whether
   * it fits in the window. Synchronous on purpose: the memory path has no I/O.
   */
  limit(key: string, nowMs: number = Date.now()): MemoryLimitResult {
    let timestamps = this.buckets.get(key)

    // Prune this key's expired timestamps.
    if (timestamps) {
      const cutoff = nowMs - this.windowMs
      const active = timestamps.filter((t) => t > cutoff)
      if (active.length === 0) {
        this.buckets.delete(key)
        timestamps = undefined
      } else {
        timestamps = active
        // LRU touch: reinsert to the end of iteration order.
        this.buckets.delete(key)
        this.buckets.set(key, timestamps)
      }
    }

    if (!timestamps) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the least-recently-used bucket (first in iteration order).
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) this.buckets.delete(oldest)
      }
      timestamps = []
      this.buckets.set(key, timestamps)
    }

    const windowStart = nowMs - this.windowMs
    // Drop expired entries again after possible eviction churn.
    const active = timestamps.filter((t) => t > windowStart)
    timestamps.length = 0
    timestamps.push(...active)

    const withinLimit = timestamps.length < this.max
    if (withinLimit) {
      timestamps.push(nowMs)
    }

    const firstTs = timestamps[0] ?? nowMs
    return {
      success: withinLimit,
      limit: this.max,
      remaining: Math.max(0, this.max - timestamps.length),
      reset: firstTs + this.windowMs,
    }
  }
}
