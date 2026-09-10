/**
 * Transcode attempt ownership.
 *
 * The problem this module exists to solve: dispatching a transcode job is not
 * idempotent, and the dispatcher retries. `queue.ts` retries the POST up to
 * `DIRECT_RETRIES` times on network errors and 5xx. If Modal accepts a request
 * and the response is lost, the retry makes Modal spawn a *second* GPU job for
 * the same video — two containers, both writing to the same prefix, both
 * calling back, and the tenant paying twice.
 *
 * A compare-and-swap on `video.status` alone does not fix that, and it cannot
 * express "this attempt owns the row". So every dispatch mints an **attempt id**
 * and claims the row with it:
 *
 * - The claim is one conditional `UPDATE`. Zero rows returned means the claim
 *   lost, and the caller **must not dispatch**.
 * - The attempt id travels in the dispatch payload and must come back on every
 *   callback and heartbeat. A callback naming any other attempt is rejected,
 *   which is what stops a stalled attempt A from mutating the row while
 *   attempt B owns it.
 * - The **lease** is the release mechanism. An attempt whose lease has expired
 *   stops counting against the organization's concurrency cap and becomes
 *   reclaimable — so a crashed container cannot hold a slot forever, and no
 *   reaper process is needed to notice.
 *
 * Reclaiming a stale `processing` row is deliberately narrower than a plain
 * retry: the claimer must name the attempt id it *observed*, and that attempt's
 * lease must have run out. A sweeper working from a stale read therefore cannot
 * steal ownership from an attempt that has since been superseded.
 *
 * The lease — not a coalesce over heartbeat/started/updated columns — is the
 * sole liveness signal here, for two concrete reasons:
 *
 * 1. `last_heartbeat_at`, `processing_started_at` and `updated_at` are naive
 *    `timestamp` columns, while `now()` is `timestamptz`. Comparing them makes
 *    the result depend on the session TimeZone, which is a silent skew rather
 *    than an error. `transcode_lease_expires_at` is `timestamptz`, so the
 *    comparison is unambiguous.
 * 2. Binding a JS `Date` through a raw `sql` template is broken on the
 *    installed postgres.js: Postgres reports the parameter as untyped, the
 *    driver takes its string path and calls `Buffer.byteLength(date)`, which
 *    throws `ERR_INVALID_ARG_TYPE`. Drizzle's typed query builder is unaffected
 *    (it knows the column types), but raw templates must not bind Dates.
 *
 * Heartbeats extend the lease; nothing else has to.
 *
 * The organization cap lives inside the same statement as the claim. A
 * "count, then spawn" check races under concurrent requests; this cannot.
 */

import { sql, type SQL } from 'drizzle-orm'
import {
  normalizeRows,
  runAtomically,
  supportsAtomicBatch,
  type AtomicBatchExecutor,
  type AtomicExecutor,
} from './atomicWrite'

export type TranscodeClaimRequest = {
  videoId: string
  /**
   * Minted by the caller, not here. A retry of an *uncertain* dispatch must
   * reuse the same id (that is what lets the transcoder suppress the duplicate);
   * only a confirmed-dead attempt gets a fresh one.
   */
  attemptId: string
  /** How long this attempt owns the row before it becomes reclaimable. */
  leaseMs: number
  /**
   * For reclaims only: the attempt id the caller observed as owning the row.
   * Omit for a fresh dispatch. A reclaim naming any other id is refused, so a
   * sweeper working from a stale read cannot steal a live attempt's ownership.
   */
  expectedAttemptId?: string | null
  /** Max concurrent live attempts per organization. Null/undefined = unlimited. */
  organizationCap?: number | null
}

export type ClaimRejection =
  | 'not-found'
  | 'deleted'
  | 'already-claimed'
  | 'at-capacity'

/**
 * How long one attempt owns a row before it becomes reclaimable.
 *
 * Must stay comfortably longer than the transcoder's heartbeat interval (30s)
 * so a healthy but slow job cannot lose its lease between beats. Heartbeats
 * extend it; nothing else has to.
 */
export const DEFAULT_TRANSCODE_LEASE_MS = 20 * 60_000

export type ClaimResult =
  | { claimed: true; attemptId: string; jobAttempts: number }
  | { claimed: false; reason: ClaimRejection }

/**
 * The claim statement. Exported so tests can assert the guards directly and so
 * callers can explain a rejection without re-deriving the rules.
 */
export function buildClaimStatement(request: TranscodeClaimRequest): SQL {
  const { videoId, attemptId, leaseMs, expectedAttemptId = null, organizationCap = null } =
    request

  return sql`
    UPDATE video
    SET transcode_attempt_id = ${attemptId},
        status = 'processing',
        processing_started_at = now(),
        job_attempts = COALESCE(job_attempts, 0) + 1,
        last_heartbeat_at = NULL,
        transcode_lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
        updated_at = now()
    WHERE id = ${videoId}
      AND deleted_at IS NULL
      AND (
        status IN ('uploading', 'failed')
        OR (
          status = 'processing'
          AND transcode_attempt_id IS NOT DISTINCT FROM ${expectedAttemptId}
          AND transcode_lease_expires_at < now()
        )
      )
      AND (
        ${organizationCap}::int IS NULL
        OR (
          SELECT count(*)
          FROM video AS cap
          WHERE cap.organization_id = video.organization_id
            AND cap.status = 'processing'
            AND cap.deleted_at IS NULL
            AND cap.transcode_lease_expires_at > now()
        ) < ${organizationCap}::int
      )
    RETURNING transcode_attempt_id, job_attempts
  `
}

export type ClaimFailureRow = {
  status: string
  deletedAt: Date | null
  actualAttemptId?: string | null
  /** Live attempts currently held by the same organization. */
  organizationInFlight?: number
}

/**
 * Explain a lost claim. Pure, so it is checked with literals.
 *
 * Only ever called *after* a claim has already failed, to pick an HTTP status
 * and a log line. It cannot influence whether work runs, so its extra read
 * cannot reintroduce the race the claim statement exists to close.
 */
export function classifyClaimFailure(
  row: ClaimFailureRow | null,
  options: { organizationCap: number | null },
): ClaimRejection {
  if (!row) return 'not-found'
  if (row.deletedAt) return 'deleted'
  const cap = options.organizationCap
  if (cap != null && (row.organizationInFlight ?? 0) >= cap) return 'at-capacity'
  return 'already-claimed'
}

export type AttemptDecision = { apply: true } | { apply: false; reason: string }

/**
 * Decide whether a callback or heartbeat may act on a row.
 *
 * Status alone is not enough. The sequence that breaks a status-only guard is:
 *
 *   attempt A stalls (lease expires) -> attempt B claims and starts
 *   -> A finishes and reports success -> the row is `processing`
 *   -> a status-only guard accepts A's callback and marks the row `ready`
 *      using A's outputs, while B is still writing different bytes.
 *
 * Naming the attempt closes that. The rule is strict exactly where it can be:
 *
 * - Row has an attempt id: the caller MUST name it, and it must match.
 * - Row has no attempt id: accept. This only happens for jobs dispatched by a
 *   build that predates attempt ownership, which tolerates a rolling upgrade
 *   instead of silently dropping every in-flight callback.
 */
export function decideAttemptOwnership(
  currentAttemptId: string | null | undefined,
  reportedAttemptId: unknown,
): AttemptDecision {
  if (!currentAttemptId) {
    return { apply: true }
  }

  if (typeof reportedAttemptId !== 'string' || reportedAttemptId.length === 0) {
    return {
      apply: false,
      reason: `callback did not identify its attempt (row is owned by ${currentAttemptId})`,
    }
  }

  if (reportedAttemptId !== currentAttemptId) {
    return {
      apply: false,
      reason: `callback for superseded attempt ${reportedAttemptId} ignored (current owner is ${currentAttemptId})`,
    }
  }

  return { apply: true }
}

/**
 * Lock the owning organization row for the rest of this transaction.
 *
 * Why a separate statement is required for the concurrency cap to mean
 * anything: the cap is a `count(*)` subquery inside the claim's `UPDATE`. Under
 * READ COMMITTED a statement sees the snapshot taken when it *started*, and two
 * claims for **different** videos update different rows, so they never block
 * each other. Both therefore read the same pre-state and both pass the count —
 * the cap is silently exceeded. (This is why the same-video race test proves
 * nothing about the organization-wide guarantee.)
 *
 * Taking the lock in an earlier statement fixes it, because each *statement* in
 * a READ COMMITTED transaction gets a fresh snapshot: a second claimer blocks
 * here, and once it proceeds its claim statement sees the first claimer's
 * committed row. Both drivers run the pair in one transaction — neon via
 * `batch`, postgres-js via `transaction`.
 *
 * Only taken when a cap is configured; an uncapped organization has nothing to
 * serialize and should not pay for it.
 */
export function buildOrganizationLockStatement(videoId: string): SQL {
  return sql`
    SELECT o.id
    FROM organization AS o
    WHERE o.id = (SELECT organization_id FROM video WHERE id = ${videoId})
    FOR UPDATE
  `
}

function buildDiagnosticStatement(videoId: string): SQL {  return sql`
    SELECT status,
           deleted_at AS "deletedAt",
           transcode_attempt_id AS "actualAttemptId",
           (
             SELECT count(*)
             FROM video AS cap
             WHERE cap.organization_id = video.organization_id
               AND cap.status = 'processing'
               AND cap.deleted_at IS NULL
               AND cap.transcode_lease_expires_at > now()
           )::int AS "organizationInFlight"
    FROM video
    WHERE id = ${videoId}
  `
}

/**
 * Claim a transcode attempt.
 *
 * On `{ claimed: true }` the caller owns the row and should dispatch with the
 * returned `attemptId`. On `{ claimed: false }` the caller **must not
 * dispatch** — the row is deleted, already owned by a live attempt, or the
 * organization is at its concurrency cap.
 */
export async function claimTranscodeAttempt(
  executor: AtomicExecutor,
  request: TranscodeClaimRequest,
): Promise<ClaimResult> {
  const cap = request.organizationCap ?? null

  // With a cap configured the claim must run behind an organization lock,
  // otherwise concurrent claims for different videos both satisfy the count.
  // Without one there is nothing to serialize.
  const rows =
    cap == null
      ? normalizeRows(await executor.execute(buildClaimStatement(request)))
      : await claimUnderOrganizationLock(executor, request)

  const winner = rows[0]
  if (winner) {
    return {
      claimed: true,
      attemptId: String(winner.transcode_attempt_id),
      jobAttempts: Number(winner.job_attempts ?? 1),
    }
  }

  // Lost the claim. A follow-up read only chooses the reason — it cannot flip
  // the outcome, so it is safe to run here.
  const diagnostic = normalizeRows(
    await executor.execute(buildDiagnosticStatement(request.videoId)),
  )[0]

  const row: ClaimFailureRow | null = diagnostic
    ? {
        status: String(diagnostic.status),
        deletedAt: (diagnostic.deletedAt as Date | null) ?? null,
        actualAttemptId: (diagnostic.actualAttemptId as string | null) ?? null,
        organizationInFlight: Number(diagnostic.organizationInFlight ?? 0),
      }
    : null

  return {
    claimed: false,
    reason: classifyClaimFailure(row, { organizationCap: cap }),
  }
}

/**
 * Run [lock organization, claim] inside one transaction and return the claim's
 * rows. The lock statement's own result is deliberately discarded.
 */
async function claimUnderOrganizationLock(
  executor: AtomicExecutor,
  request: TranscodeClaimRequest,
): Promise<Record<string, unknown>[]> {
  const atomic = executor as AtomicExecutor & AtomicBatchExecutor
  if (!supportsAtomicBatch(atomic)) {
    // A driver that can neither batch nor transact cannot order these two
    // statements, so the cap would not hold. Refuse rather than over-admit.
    throw new Error(
      'organization concurrency cap requires a driver with batch() or transaction()',
    )
  }

  const results = await runAtomically(atomic, (handle) => {
    const scoped = handle as unknown as AtomicExecutor
    return [
      scoped.execute(buildOrganizationLockStatement(request.videoId)),
      scoped.execute(buildClaimStatement(request)),
    ]
  })

  // Index 1 is the claim; index 0 is the lock.
  return normalizeRows(results[1])
}

/** Read the per-organization concurrency cap from the environment. */
export function organizationCapFromEnv(env?: Record<string, unknown>): number | null {
  const raw =
    (env?.['TRANSCODE_ORG_CONCURRENCY_CAP'] as unknown) ??
    (typeof process !== 'undefined'
      ? process.env?.TRANSCODE_ORG_CONCURRENCY_CAP
      : undefined)
  const parsed = Number(raw)
  // Unset or invalid means "no cap", which is the documented default: this is a
  // cost-control lever an operator opts into, not a limit we invent for them.
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}
