/**
 * The maintenance runner.
 *
 * Everything that reconciles durable state lives here, and both entry points
 * call it: the cron/scheduled trigger and `POST /api/internal/sweep`.
 *
 * They previously diverged — the scheduled handler ran only the transcode
 * sweep, so a deployment using the documented Workers cron never attempted a
 * single webhook retry. Sharing one function is what makes "the cron is
 * configured" mean the same thing as "retries happen".
 *
 * Each pass is independently guarded: a failure in one must not stop the other,
 * because they reconcile unrelated work (stuck transcode jobs vs undelivered
 * events), and a transient error in one would otherwise stall the other
 * indefinitely.
 */

import { runSweep, type SweepStats } from './jobSweeper'
import { createSweepAdapters, sweepLimitsFromEnv } from './sweepAdapters'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { maintenanceRun } from '../db/schema'
import { drainOutbox, type DrainResult } from '../lib/webhookDelivery'
import {
  cleanupDepsFromEnv,
  emptyCleanupStats,
  runObjectCleanup,
  type CleanupStats,
} from '../lib/objectCleanup'
import { s3ObjectStore } from './objectStore'
import type { Bindings } from '../types'

export type MaintenanceResult = {
  videos: SweepStats
  deliveries: DrainResult
  cleanup: CleanupStats
  durationMs: number
}

const HEARTBEAT_ID = 'singleton'

/**
 * Record that a pass ran. Best-effort: a heartbeat failure must never stop
 * maintenance, and the heartbeat is only useful if it reflects reality.
 */
async function recordHeartbeat(patch: {
  startedAt?: Date
  succeededAt?: Date
  durationMs?: number
  error?: string | null
}): Promise<void> {
  try {
    const values = {
      id: HEARTBEAT_ID,
      ...(patch.startedAt ? { lastStartedAt: patch.startedAt } : {}),
      ...(patch.succeededAt ? { lastSucceededAt: patch.succeededAt } : {}),
      ...(patch.durationMs != null ? { lastDurationMs: patch.durationMs } : {}),
      lastError: patch.error ?? null,
    }
    await db
      .insert(maintenanceRun)
      .values(values)
      .onConflictDoUpdate({ target: maintenanceRun.id, set: values })
  } catch (err) {
    console.error('[MAINTENANCE] could not record heartbeat:', err)
  }
}

export async function runMaintenance(env?: Bindings): Promise<MaintenanceResult> {
  const started = Date.now()
  await recordHeartbeat({ startedAt: new Date() })
  const limit = readPositiveInt(env, 'MAINTENANCE_BATCH_SIZE', 50)

  let videos: SweepStats = { retried: 0, failed: 0, aborted: 0 }
  try {
    videos = await runSweep(new Date(), sweepLimitsFromEnv(env), createSweepAdapters(env))
  } catch (err) {
    console.error('[MAINTENANCE] video sweep failed:', err)
  }

  let deliveries: DrainResult = {
    eventsDrained: 0,
    deliveriesQueued: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    recovered: 0,
  }
  try {
    // `drainOutbox` is the right entry point rather than sending alone: an event
    // whose inline drain never ran is still `pending`, so it has no delivery
    // rows yet. Draining fans those out and then sends, which is what makes a
    // process that died right after the atomic write recoverable.
    deliveries = await drainOutbox({ deliveryLimit: limit })
  } catch (err) {
    console.error('[MAINTENANCE] webhook delivery pass failed:', err)
  }

  let cleanup = emptyCleanupStats()
  try {
    const deps = cleanupDepsFromEnv(env as Record<string, unknown> | undefined, s3ObjectStore)
    if (deps) {
      cleanup = await runObjectCleanup(deps, limit)
    }
    // No buckets configured means storage is not set up yet; that is a
    // configuration state, not an error, and the jobs simply wait.
  } catch (err) {
    console.error('[MAINTENANCE] storage cleanup pass failed:', err)
  }

  const durationMs = Date.now() - started
  await recordHeartbeat({ succeededAt: new Date(), durationMs })

  return { videos, deliveries, cleanup, durationMs }
}

function readPositiveInt(env: Bindings | undefined, key: string, fallback: number): number {
  const raw = env?.[key as keyof Bindings] as string | undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Should the scheduled trigger run maintenance?
 *
 * Opt-in, because it is the cron trigger that must be configured — and the
 * consequence of leaving it off is not limited to stuck transcode jobs: webhook
 * retries stop too. `GET /health/config` reports whether this is on, so the
 * omission is visible rather than silent.
 */
export function isMaintenanceEnabled(env?: Record<string, unknown> | Bindings): boolean {
  return env?.SWEEP_ENABLED === 'true'
}

/** A pass older than this is treated as "not actually running". */
export const MAINTENANCE_STALE_MS = 60 * 60_000

export type MaintenanceStatus = {
  enabled: boolean
  lastStartedAt: string | null
  lastSucceededAt: string | null
  lastError: string | null
  /** True when enabled but no recent successful pass has been recorded. */
  stale: boolean
}

/**
 * Read the heartbeat. Best-effort: a health probe must not fail because the
 * database is briefly unreachable — it reports `stale` instead.
 */
export async function readMaintenanceStatus(
  env?: Record<string, unknown> | Bindings,
): Promise<MaintenanceStatus> {
  const enabled = isMaintenanceEnabled(env)
  try {
    const rows = await db.select().from(maintenanceRun).where(eq(maintenanceRun.id, HEARTBEAT_ID))
    const row = rows[0]
    const lastSucceededAt = row?.lastSucceededAt ?? null
    const fresh =
      lastSucceededAt != null &&
      Date.now() - new Date(lastSucceededAt).getTime() < MAINTENANCE_STALE_MS
    return {
      enabled,
      lastStartedAt: row?.lastStartedAt ? new Date(row.lastStartedAt).toISOString() : null,
      lastSucceededAt: lastSucceededAt ? new Date(lastSucceededAt).toISOString() : null,
      lastError: row?.lastError ?? null,
      stale: enabled && !fresh,
    }
  } catch {
    return {
      enabled,
      lastStartedAt: null,
      lastSucceededAt: null,
      lastError: null,
      stale: enabled,
    }
  }
}
