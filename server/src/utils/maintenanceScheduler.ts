/**
 * Process-local maintenance scheduler.
 *
 * One designated Node API instance runs this: an initial asynchronous pass
 * after startup, then the next pass is scheduled only after the previous one
 * completes. Timer ticks and `POST /api/internal/sweep` share the same
 * single-flight runner so two passes cannot overlap.
 *
 * A failed pass must not stop subsequent scheduling. `stop()` cancels the
 * timer and lets in-flight work finish.
 */

export type TimeoutHandle = { unref?: () => void }

export type MaintenanceClock = {
  now(): number
  setTimeout(fn: () => void, ms: number): TimeoutHandle
  clearTimeout(handle: TimeoutHandle): void
}

export const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 900
/** Node `setTimeout` clamps delays outside 1..2^31-1 ms to 1 ms. */
export const MAX_SET_TIMEOUT_MS = 2_147_483_647
export const MAX_MAINTENANCE_INTERVAL_SECONDS = Math.floor(MAX_SET_TIMEOUT_MS / 1000)

export type MaintenanceScheduler = {
  start(): void
  stop(): void
  runNow(): Promise<unknown>
  readonly inFlight: boolean
  waitForIdle(): Promise<void>
}

const systemClock: MaintenanceClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export function createMaintenanceScheduler(options: {
  enabled: boolean
  intervalMs: number
  run: () => Promise<unknown>
  clock?: MaintenanceClock
  onError?: (error: unknown) => void
}): MaintenanceScheduler {
  const clock = options.clock ?? systemClock
  let stopped = true
  let timer: TimeoutHandle | null = null
  let inFlight: Promise<unknown> | null = null

  const clearTimer = () => {
    if (timer) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  const scheduleNext = () => {
    if (stopped || !options.enabled) return
    clearTimer()
    timer = clock.setTimeout(() => {
      timer = null
      void runPass().catch(() => {
        // onError already recorded the failure; keep the schedule alive.
      })
    }, options.intervalMs)
  }

  const runPass = (): Promise<unknown> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        return await options.run()
      } catch (error) {
        options.onError?.(error)
        throw error
      } finally {
        inFlight = null
        if (!stopped) scheduleNext()
      }
    })()
    return inFlight
  }

  return {
    get inFlight() {
      return inFlight !== null
    },
    start() {
      if (!options.enabled) return
      stopped = false
      void runPass().catch(() => {
        // onError already recorded the failure; keep the schedule alive.
      })
    },
    stop() {
      stopped = true
      clearTimer()
    },
    runNow() {
      return runPass()
    },
    async waitForIdle() {
      if (inFlight) await inFlight.catch(() => undefined)
    },
  }
}

export function maintenanceIntervalMs(env: { MAINTENANCE_INTERVAL_SECONDS?: string }): number {
  const raw = env.MAINTENANCE_INTERVAL_SECONDS?.trim() ?? ''
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return DEFAULT_MAINTENANCE_INTERVAL_SECONDS * 1000
  }
  const seconds = Number(raw)
  if (!Number.isSafeInteger(seconds) || seconds > MAX_MAINTENANCE_INTERVAL_SECONDS) {
    return DEFAULT_MAINTENANCE_INTERVAL_SECONDS * 1000
  }
  return seconds * 1000
}
