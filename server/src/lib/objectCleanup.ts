/**
 * Storage cleanup reconciler.
 *
 * Deleting a video is two independent operations in two systems: removing the
 * row, and reclaiming the bytes. This module owns the second one, and its whole
 * point is that the debt is durable — `storage_cleanup_job` is written by the
 * same operation as the deletion (or by the `AFTER DELETE` trigger, covering
 * cascades), so nothing is lost if the process dies mid-cleanup.
 *
 * ## When "reclaimed" may be claimed
 *
 * Deliberately *not* "we deleted some keys and the next listing was empty". A
 * transcoder can still write after we look:
 *
 *   delete objects -> listing empty -> mark reclaimed -> writer uploads -> nothing re-checks
 *
 * So a job only reaches `reclaimed` when both hold:
 *
 * 1. **Writers are retired.** `not_before` has passed — set past the longest
 *    outstanding writer (the presigned-upload TTL) — *and* no live transcode
 *    attempt holds the video row. Unfinished multipart uploads are aborted
 *    explicitly, because they hold parts that a listing cannot see.
 * 2. **Then** a listing comes back empty.
 *
 * Because (1) precedes (2), a later write should be impossible — and a
 * `reclaimed` job is not believed permanently either. It is re-verified once
 * after a delay, and a prefix that has grown again puts the job back to
 * `pending`. Cheap, and it makes the claim honest.
 */

import { randomBytes } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db } from './database'
import { normalizeRows, type AtomicExecutor } from './atomicWrite'
import type { ObjectStore } from '../utils/objectStore'

export type CleanupLimits = {
  /** Attempts before a job is declared failed and surfaced. */
  maxAttempts: number
  /** Lease duration; a runner must finish inside it or lose the job. */
  leaseMs: number
  /** How long after deletion before bytes are touched (presigned-URL TTL). */
  writerRetirementMs: number
  /** How long after reclaiming to re-verify the prefix is still empty. */
  reverifyAfterMs: number
}

export const DEFAULT_CLEANUP_LIMITS: CleanupLimits = {
  maxAttempts: 8,
  leaseMs: 120_000,
  // Presigned part URLs are valid for 1h (see upload-public.ts); 2h is a safe
  // margin beyond the longest-lived way a writer could still be permitted.
  writerRetirementMs: 2 * 60 * 60_000,
  reverifyAfterMs: 60 * 60_000,
}

export type CleanupDeps = {
  executor: AtomicExecutor
  objectStore: ObjectStore
  rawBucket: string
  transcodedBucket: string
  now: () => Date
  limits: CleanupLimits
}

export function newCleanupJobId(): string {
  return `scj_${randomBytes(12).toString('hex')}`
}

// ────────────────────────────────────────────────────────────────────────────
// Pure rules
// ────────────────────────────────────────────────────────────────────────────

export type CleanupOutcome =
  | { kind: 'reclaim' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fail'; reason: string }

/**
 * What to do after one cleanup pass over a job's prefixes.
 *
 * `remaining` is what a listing returned *after* the delete attempt, which is
 * the only evidence that counts.
 */
export function decideCleanupOutcome(input: {
  remaining: number
  attemptsMade: number
  limits?: CleanupLimits
  lastError?: string | null
}): CleanupOutcome {
  const limits = input.limits ?? DEFAULT_CLEANUP_LIMITS

  if (input.remaining === 0) {
    return { kind: 'reclaim' }
  }

  if (input.attemptsMade >= limits.maxAttempts) {
    return {
      kind: 'fail',
      reason:
        `gave up after ${input.attemptsMade} attempts with ${input.remaining} object(s) ` +
        `still present${input.lastError ? `: ${input.lastError}` : ''}`,
    }
  }

  // Backoff, capped, so a persistently failing delete does not spin.
  const delayMs = Math.min(60_000 * 2 ** input.attemptsMade, 60 * 60_000)
  return { kind: 'retry', delayMs }
}

/** Backoff before re-verifying a reclaimed job, capped. */
export function reverifyDelayMs(limits: CleanupLimits = DEFAULT_CLEANUP_LIMITS): number {
  return limits.reverifyAfterMs
}

// ────────────────────────────────────────────────────────────────────────────
// Claiming
// ────────────────────────────────────────────────────────────────────────────

export type ClaimedCleanupJob = {
  id: string
  videoId: string
  rawKey: string | null
  prefix: string
  attempts: number
  leaseOwner: string
}

type ClaimOptions = {
  /** `pending` acts on bytes; `reverify` re-checks an already-reclaimed job. */
  mode: 'pending' | 'reverify'
}

function buildClaimStatement(
  limit: number,
  leaseOwner: string,
  deps: CleanupDeps,
  mode: ClaimOptions['mode'],
): SQL {
  const selectable =
    mode === 'pending'
      ? sql`j.status = 'pending'
          AND j.not_before <= now()
          AND (j.lease_owner IS NULL OR j.lease_expires_at < now())
          -- Writers retired: no transcode attempt still holds the video row.
          -- A soft-deleted video whose attempt is live must not have its
          -- output deleted underneath it.
          AND NOT EXISTS (
            SELECT 1 FROM video AS v
            WHERE v.id = j.video_id
              AND v.transcode_attempt_id IS NOT NULL
              AND v.transcode_lease_expires_at > now()
          )`
      : sql`j.status = 'reclaimed'
          AND j.verified_at IS NULL
          AND j.reclaimed_at IS NOT NULL
          AND j.reclaimed_at + (${deps.limits.reverifyAfterMs}::int * interval '1 millisecond') <= now()`

  // Re-verification is not a new attempt, so it must not consume the budget.
  const attemptsExpr = mode === 'pending' ? sql`j.attempts + 1` : sql`j.attempts`

  return sql`
    WITH due AS (
      SELECT j.id FROM storage_cleanup_job AS j
      WHERE ${selectable}
      ORDER BY j.created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE storage_cleanup_job AS j
      SET lease_owner = ${leaseOwner},
          lease_expires_at = now() + (${deps.limits.leaseMs}::int * interval '1 millisecond'),
          attempts = ${attemptsExpr},
          updated_at = now()
      FROM due
      WHERE j.id = due.id
      RETURNING j.id, j.video_id, j.raw_key, j.prefix, j.attempts, j.lease_owner
    )
    SELECT * FROM claimed
  `
}

function newLeaseOwner(): string {
  return `cln_${randomBytes(8).toString('hex')}`
}

export async function claimCleanupJobs(
  limit: number,
  deps: CleanupDeps,
  mode: ClaimOptions['mode'] = 'pending',
): Promise<ClaimedCleanupJob[]> {
  const leaseOwner = newLeaseOwner()
  const rows = normalizeRows(
    await deps.executor.execute(buildClaimStatement(limit, leaseOwner, deps, mode)),
  )
  return rows.map((row) => ({
    id: String(row.id),
    videoId: String(row.video_id),
    rawKey: (row.raw_key as string | null) ?? null,
    prefix: String(row.prefix),
    attempts: Number(row.attempts ?? 0),
    leaseOwner: String(row.lease_owner ?? leaseOwner),
  }))
}

// ────────────────────────────────────────────────────────────────────────────
// Finalization (lease-guarded)
// ────────────────────────────────────────────────────────────────────────────

async function finalize(
  job: ClaimedCleanupJob,
  setClause: SQL,
  deps: CleanupDeps,
): Promise<boolean> {
  const rows = normalizeRows(
    await deps.executor.execute(sql`
      UPDATE storage_cleanup_job
      ${setClause}
      WHERE id = ${job.id}
        AND lease_owner = ${job.leaseOwner}
        AND lease_expires_at > now()
      RETURNING id
    `),
  )
  return rows.length > 0
}

function markReclaimed(job: ClaimedCleanupJob, objectsDeleted: number, deps: CleanupDeps) {
  return finalize(
    job,
    sql`SET status = 'reclaimed', reclaimed_at = now(), objects_deleted = ${objectsDeleted},
            lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()`,
    deps,
  )
}

function markVerified(job: ClaimedCleanupJob, deps: CleanupDeps) {
  return finalize(
    job,
    sql`SET verified_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()`,
    deps,
  )
}

function reopenReclaimed(job: ClaimedCleanupJob, seen: number, deps: CleanupDeps) {
  return finalize(
    job,
    sql`SET status = 'pending', verified_at = NULL, reclaimed_at = NULL,
            not_before = now(), objects_deleted = 0,
            last_error = ${`${seen} object(s) reappeared after reclaiming`},
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()`,
    deps,
  )
}

function scheduleRetry(job: ClaimedCleanupJob, delayMs: number, deps: CleanupDeps) {
  return finalize(
    job,
    sql`SET status = 'pending', not_before = now() + (${delayMs}::int * interval '1 millisecond'),
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()`,
    deps,
  )
}

function markCleanupFailed(job: ClaimedCleanupJob, reason: string, deps: CleanupDeps) {
  return finalize(
    job,
    sql`SET status = 'failed', last_error = ${reason},
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()`,
    deps,
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The reconciler
// ────────────────────────────────────────────────────────────────────────────

export type CleanupStats = {
  jobsReclaimed: number
  jobsVerified: number
  jobsReopened: number
  jobsFailed: number
  objectsDeleted: number
  multipartAborted: number
}

export function emptyCleanupStats(): CleanupStats {
  return {
    jobsReclaimed: 0,
    jobsVerified: 0,
    jobsReopened: 0,
    jobsFailed: 0,
    objectsDeleted: 0,
    multipartAborted: 0,
  }
}

/**
 * Run one reconciliation pass.
 *
 * Each job is independent: a bucket error on one must not stop the others, and
 * anything left unfinished stays `pending` with a later `not_before`, so the
 * next pass picks it up.
 */
export async function runObjectCleanup(
  deps: CleanupDeps,
  batchSize = 25,
): Promise<CleanupStats> {
  const stats = emptyCleanupStats()

  // 1. Re-verify previously reclaimed jobs. A prefix that grew again is a real
  //    anomaly (a late writer), so it goes back to pending rather than being
  //    silently believed.
  for (const job of await claimCleanupJobs(batchSize, deps, 'reverify')) {
    try {
      const remaining = await deps.objectStore.listKeys(
        deps.transcodedBucket,
        job.prefix,
      )
      const rawPresent = job.rawKey
        ? await deps.objectStore.listKeys(deps.rawBucket, job.rawKey)
        : []
      const seen = remaining.length + rawPresent.length

      if (seen === 0) {
        await markVerified(job, deps)
        stats.jobsVerified += 1
      } else {
        await reopenReclaimed(job, seen, deps)
        stats.jobsReopened += 1
      }
    } catch (err) {
      console.error(`[CLEANUP] re-verify failed for ${job.id}:`, err)
    }
  }

  // 2. Reclaim bytes for pending jobs whose writers have retired.
  for (const job of await claimCleanupJobs(batchSize, deps, 'pending')) {
    try {
      // Unfinished multipart uploads are invisible to listKeys but still billed.
      stats.multipartAborted += await deps.objectStore.abortMultipartUploads(
        deps.rawBucket,
        job.rawKey ?? job.prefix,
      )

      const keys = await deps.objectStore.listKeys(deps.transcodedBucket, job.prefix)
      const targets = job.rawKey ? [...keys, job.rawKey] : keys

      let deleted = 0
      if (targets.length > 0) {
        await deps.objectStore.deleteKeys(deps.transcodedBucket, keys)
        if (job.rawKey) {
          deleted += await deps.objectStore.deleteKeys(deps.rawBucket, [job.rawKey])
        }
        deleted += keys.length
      }
      stats.objectsDeleted += deleted

      // Only a fresh listing counts as evidence.
      const remaining =
        (await deps.objectStore.listKeys(deps.transcodedBucket, job.prefix)).length +
        (job.rawKey
          ? (await deps.objectStore.listKeys(deps.rawBucket, job.rawKey)).length
          : 0)

      const outcome = decideCleanupOutcome({
        remaining,
        attemptsMade: job.attempts,
        limits: deps.limits,
      })

      if (outcome.kind === 'reclaim') {
        await markReclaimed(job, deleted, deps)
        stats.jobsReclaimed += 1
      } else if (outcome.kind === 'retry') {
        await scheduleRetry(job, outcome.delayMs, deps)
      } else {
        await markCleanupFailed(job, outcome.reason, deps)
        stats.jobsFailed += 1
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[CLEANUP] job ${job.id} failed:`, err)
      const outcome = decideCleanupOutcome({
        // Treat a thrown error as "not proven empty": never reclaim on failure.
        remaining: Number.POSITIVE_INFINITY,
        attemptsMade: job.attempts,
        limits: deps.limits,
        lastError: message,
      })
      if (outcome.kind === 'fail') {
        await markCleanupFailed(job, outcome.reason, deps)
        stats.jobsFailed += 1
      } else if (outcome.kind === 'retry') {
        await scheduleRetry(job, outcome.delayMs, deps)
      }
    }
  }

  return stats
}

export function cleanupDepsFromEnv(
  env: Record<string, unknown> | undefined,
  objectStore: ObjectStore,
  executor: AtomicExecutor = db,
): CleanupDeps | null {
  const read = (key: string) => {
    const fromEnv = env?.[key]
    const value =
      typeof fromEnv === 'string'
        ? fromEnv
        : typeof process !== 'undefined'
          ? process.env?.[key]
          : undefined
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }

  const rawBucket = read('RAW_BUCKET_NAME')
  const transcodedBucket = read('TRANSCODED_BUCKET_NAME')
  if (!rawBucket || !transcodedBucket) return null

  return {
    executor,
    objectStore,
    rawBucket,
    transcodedBucket,
    now: () => new Date(),
    limits: DEFAULT_CLEANUP_LIMITS,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Deletion intent
// ────────────────────────────────────────────────────────────────────────────

/**
 * Soft-delete a video and enqueue its byte reclamation in one statement.
 *
 * The point is that the two cannot come apart: if the row is marked deleted,
 * the cleanup debt exists. The guarded CTE shape also makes repeated deletion
 * idempotent — the second call's guard does not match, so no second job is
 * queued and the caller learns the transition was already applied.
 *
 * `not_before` is set past the presigned-upload window so the reconciler does
 * not delete underneath a writer that is still legitimately allowed to write.
 */
export function buildDeletionIntentStatement(input: {
  videoId: string
  organizationId: string
  deletedBy?: string | null
  writerRetirementMs?: number
}): SQL {
  const writerRetirementMs = input.writerRetirementMs ?? DEFAULT_CLEANUP_LIMITS.writerRetirementMs

  return sql`
    WITH target AS (
      UPDATE video
      SET deleted_at = now(), deleted_by = ${input.deletedBy ?? null}, updated_at = now()
      WHERE id = ${input.videoId}
        AND organization_id = ${input.organizationId}
        AND deleted_at IS NULL
      RETURNING id, organization_id, raw_key
    ), job AS (
      INSERT INTO storage_cleanup_job (id, video_id, organization_id, raw_key, prefix, not_before)
      SELECT 'scj_' || gen_random_uuid()::text,
             t.id,
             t.organization_id,
             t.raw_key,
             'videos/' || t.id::text || '/',
             now() + (${writerRetirementMs}::int * interval '1 millisecond')
      FROM target AS t
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT (SELECT count(*) FROM target)::int AS soft_deleted,
           (SELECT count(*) FROM job)::int AS jobs_enqueued
  `
}

export type DeletionResult =
  | { deleted: true }
  /** Already deleted, not found, or owned by another organization. */
  | { deleted: false }

/**
 * Apply the deletion intent.
 *
 * Returns `{ deleted: false }` for a guard miss rather than throwing, because
 * from the caller's perspective "already deleted" and "not yours" are both
 * non-errors that resolve to the same response — and neither should queue work.
 */
export async function deleteVideoWithCleanup(
  deps: Pick<CleanupDeps, 'executor'> & {
    videoId: string
    organizationId: string
    deletedBy?: string | null
    writerRetirementMs?: number
  },
): Promise<DeletionResult> {
  const rows = normalizeRows(
    await deps.executor.execute(
      buildDeletionIntentStatement({
        videoId: deps.videoId,
        organizationId: deps.organizationId,
        deletedBy: deps.deletedBy,
        writerRetirementMs: deps.writerRetirementMs,
      }),
    ),
  )
  const applied = Number(rows[0]?.soft_deleted ?? 0) > 0
  return applied ? { deleted: true } : { deleted: false }
}
