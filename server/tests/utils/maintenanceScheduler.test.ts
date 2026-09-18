import { describe, expect, it } from 'vitest'
import {
  createMaintenanceScheduler,
  maintenanceIntervalMs,
  type MaintenanceClock,
  type TimeoutHandle,
} from '../../src/utils/maintenanceScheduler'

class FakeClock implements MaintenanceClock {
  nowMs = 0
  private nextId = 1
  timers = new Map<number, { at: number; fn: () => void }>()

  now() {
    return this.nowMs
  }

  setTimeout(fn: () => void, ms: number): TimeoutHandle {
    const id = this.nextId++
    this.timers.set(id, { at: this.nowMs + ms, fn })
    return { unref() {}, id } as TimeoutHandle & { id: number }
  }

  clearTimeout(handle: TimeoutHandle) {
    const id = (handle as TimeoutHandle & { id?: number }).id
    if (id !== undefined) this.timers.delete(id)
  }

  async advance(ms: number) {
    this.nowMs += ms
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

describe('createMaintenanceScheduler', () => {
  it('does nothing when disabled', async () => {
    let runs = 0
    const clock = new FakeClock()
    const scheduler = createMaintenanceScheduler({
      enabled: false,
      intervalMs: 1_000,
      clock,
      run: async () => {
        runs += 1
      },
    })
    scheduler.start()
    await clock.advance(5_000)
    expect(runs).toBe(0)
    await scheduler.runNow()
    expect(runs).toBe(1)
  })

  it('runs an initial pass on start, then waits for the interval after completion', async () => {
    let runs = 0
    const clock = new FakeClock()
    const scheduler = createMaintenanceScheduler({
      enabled: true,
      intervalMs: 1_000,
      clock,
      run: async () => {
        runs += 1
      },
    })
    scheduler.start()
    await Promise.resolve()
    expect(runs).toBe(1)
    await clock.advance(999)
    expect(runs).toBe(1)
    await clock.advance(1)
    await Promise.resolve()
    expect(runs).toBe(2)
  })

  it('does not overlap timer and manual passes', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let releases: Array<() => void> = []
    const clock = new FakeClock()
    const scheduler = createMaintenanceScheduler({
      enabled: true,
      intervalMs: 5_000,
      clock,
      run: () =>
        new Promise<void>((resolve) => {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          releases.push(() => {
            concurrent -= 1
            resolve()
          })
        }),
    })
    scheduler.start()
    const manual = scheduler.runNow()
    expect(maxConcurrent).toBe(1)
    releases[0]!()
    await manual
    expect(maxConcurrent).toBe(1)
  })

  it('schedules the next pass after a failure', async () => {
    let attempts = 0
    const clock = new FakeClock()
    const scheduler = createMaintenanceScheduler({
      enabled: true,
      intervalMs: 100,
      clock,
      run: async () => {
        attempts += 1
        throw new Error('boom')
      },
    })
    scheduler.start()
    await Promise.resolve()
    expect(attempts).toBe(1)
    await clock.advance(100)
    await Promise.resolve()
    expect(attempts).toBe(2)
  })

  it('stops scheduling on shutdown and lets in-flight work finish', async () => {
    let finished = false
    let resolveRun: () => void = () => {}
    const clock = new FakeClock()
    const scheduler = createMaintenanceScheduler({
      enabled: true,
      intervalMs: 50,
      clock,
      run: () =>
        new Promise<void>((resolve) => {
          resolveRun = () => {
            finished = true
            resolve()
          }
        }),
    })
    scheduler.start()
    scheduler.stop()
    expect(finished).toBe(false)
    resolveRun()
    await scheduler.waitForIdle()
    expect(finished).toBe(true)
    await clock.advance(500)
    expect(clock.timers.size).toBe(0)
  })
})

describe('maintenanceIntervalMs', () => {
  it('defaults to 900 seconds', () => {
    expect(maintenanceIntervalMs({})).toBe(900_000)
    expect(maintenanceIntervalMs({ MAINTENANCE_INTERVAL_SECONDS: '30' })).toBe(30_000)
  })

  it('rejects fractions and values that overflow Node timers', () => {
    expect(maintenanceIntervalMs({ MAINTENANCE_INTERVAL_SECONDS: '0.5' })).toBe(900_000)
    expect(maintenanceIntervalMs({ MAINTENANCE_INTERVAL_SECONDS: '2592000' })).toBe(900_000)
    expect(maintenanceIntervalMs({ MAINTENANCE_INTERVAL_SECONDS: '0' })).toBe(900_000)
    expect(maintenanceIntervalMs({ MAINTENANCE_INTERVAL_SECONDS: '2147483' })).toBe(2_147_483_000)
  })
})
