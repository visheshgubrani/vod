/**
 * The durable queue for self-hosted transcode work.
 *
 * Postgres is the authority. Not a broker, not an in-memory list: the video row
 * and the lifecycle outbox already live here, and a second system of record
 * would need its own reconciliation against them — which is exactly the class of
 * bug (two sources of truth disagreeing) this feature must not add.
 *
 * Four properties the statements below are built to hold:
 *
 * 1. **Claiming is atomic and exclusive.** `FOR UPDATE SKIP LOCKED` on the job
 *    row, with the video row updated in the same statement. Two agents polling
 *    simultaneously cannot both take one job, and a job cannot be taken while
 *    its video has been deleted or is owned by a live attempt.
 * 2. **Waiting is not failing.** `waiting_reason` is a separate column from
 *    `state`, and an offline agent or unavailable source increments
 *    `source_wait_count` instead of `attempts`. A laptop that is shut for a
 *    weekend has not failed three times.
 * 3. **Queue position costs nothing.** A queued job holds no attempt id and no
 *    lease, so it does not count against the organization concurrency cap or
 *    against `job_attempts`. The public status is still `processing`, because
 *    that is the vocabulary consumers already understand.
 * 4. **A local source is pinned to its agent.** `source.agent_id` is the machine
 *    holding the file; no other agent is eligible, and no amount of waiting will
 *    change that. The queue reports it rather than silently moving the job.
 */

import { sql, type SQL } from 'drizzle-orm'
import {
  normalizeRows,
  runAtomically,
  supportsAtomicBatch,
  type AtomicBatchExecutor,
  type AtomicExecutor,
} from './atomicWrite'
import { attemptPrefix } from './lifecycleFinalize'

export const JOB_STATE_QUEUED = 'queued'
export const JOB_STATE_CLAIMED = 'claimed'
export const JOB_STATE_RUNNING = 'running'
export const JOB_STATE_PUBLISHING = 'publishing'
export const JOB_STATE_SUCCEEDED = 'succeeded'
export const JOB_STATE_FAILED = 'failed'
export const JOB_STATE_CANCELLED = 'cancelled'

export type JobState =
  | typeof JOB_STATE_QUEUED
  | typeof JOB_STATE_CLAIMED
  | typeof JOB_STATE_RUNNING
  | typeof JOB_STATE_PUBLISHING
  | typeof JOB_STATE_SUCCEEDED
  | typeof JOB_STATE_FAILED
  | typeof JOB_STATE_CANCELLED

/** States in which a job holds a lease and counts against capacity. */
export const ACTIVE_JOB_STATES: JobState[] = [
  JOB_STATE_CLAIMED,
  JOB_STATE_RUNNING,
  JOB_STATE_PUBLISHING,
]

export type WaitingReason =
  | 'agent-offline'
  | 'agent-busy'
  | 'source-missing'
  | 'source-changed'
  | 'capacity'
  | 'retry-backoff'
  | 'no-eligible-agent'

export const WAITING_REASONS: WaitingReason[] = [
  'agent-offline',
  'agent-busy',
  'source-missing',
  'source-changed',
  'capacity',
  'retry-backoff',
  'no-eligible-agent',
]

/** Existing public status for queued work; the plan pins this vocabulary. */
export const PUBLIC_STATUS_PROCESSING = 'processing'

export const DEFAULT_JOB_LEASE_MS = 20 * 60_000
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Retry backoff, as a pure function.
 *
 * Attempt 1 -> 30s, 2 -> 2m, 3 -> 10m. Jittered to avoid a thundering herd of
 * agents all waking on the same second after a provider outage.
 *
 * `sourceWait` short-circuits the whole thing: waiting for an offline agent or
 * an unmounted drive is not an attempt, so it never escalates the backoff.
 */
export function nextAttemptDelayMs(
  attempts: number,
  options: { jitter?: number; sourceWait?: boolean } = {},
): number {
  if (options.sourceWait) return 60_000
  const base = attempts <= 1 ? 30_000 : attempts === 2 ? 120_000 : 600_000
  const jitter = options.jitter ?? 0
  const bounded = Math.min(1, Math.max(0, jitter))
  return Math.round(base * (1 + bounded * 0.25))
}

/**
 * How a failure is classified, and what follows from it.
 *
 * Three categories, not two, and the third is the one that was missing:
 *
 * - **source-condition** — the file is gone, changed, or unreadable *right now*.
 *   This is a property of the machine, not a defect in the job, so it never
 *   fails the job and never consumes the attempt budget. The job returns to the
 *   queue with an explicit `waiting_reason`, because a course creator who
 *   unplugged an SSD must not lose their import after three tries — and because
 *   a laptop that is shut for a weekend has not failed three times.
 * - **retryable** — an encoder or transfer failure. Retried until the attempt
 *   budget is spent, then terminal.
 * - **terminal** — the media is unusable. Retrying changes nothing.
 */
export type FailureClass = 'source-condition' | 'retryable' | 'terminal'

/** Failures that describe the machine, not the job. */
export const SOURCE_CONDITION_CODES = [
  'SOURCE_MISSING',
  'SOURCE_CHANGED',
  'SOURCE_UNREADABLE',
] as const

/** The waiting reason a source condition is surfaced as. */
export function sourceWaitingReason(failureCode: string | null | undefined): WaitingReason {
  switch (failureCode) {
    case 'SOURCE_CHANGED':
      return 'source-changed'
    case 'SOURCE_UNREADABLE':
      // Surfaced as "missing" rather than a separate reason: from the owner's
      // point of view an unreadable file is one they cannot currently use, and
      // the message carries the distinction.
      return 'source-missing'
    default:
      return 'source-missing'
  }
}

/**
 * Classify a failure code. Pure, so the retry policy is checkable with literals
 * rather than inferred from behaviour under a real database.
 */
export function classifyFailure(failureCode: string | null | undefined): FailureClass {
  if (!failureCode) return 'retryable'
  if ((SOURCE_CONDITION_CODES as readonly string[]).includes(failureCode)) {
    return 'source-condition'
  }
  // Media defects: re-running on the same bytes produces the same result.
  if (
    failureCode === 'INVALID_CONTAINER' ||
    failureCode === 'EMPTY_FILE' ||
    failureCode === 'INVALID_METADATA' ||
    failureCode === 'UNSUPPORTED_HDR' ||
    failureCode === 'AUDIO_ONLY_UNSUPPORTED' ||
    failureCode === 'MISSING_RENDITION'
  ) {
    return 'terminal'
  }
  return 'retryable'
}

/**
 * Whether a failure should consume a retry at all.
 *
 * Kept as a thin wrapper over `classifyFailure` so the two cannot disagree —
 * they previously could, and the disagreement was the bug: this returned `false`
 * for a missing source, which the SQL read as "do not return to the queue" and
 * therefore failed the job on its first attempt.
 */
export function consumesRetry(failureCode: string | null | undefined): boolean {
  return classifyFailure(failureCode) === 'retryable'
}

/** Attempt prefix an agent writes into. Stored, never re-derived at publish. */
export function prefixForAttempt(videoId: string, attemptId: string): string {
  return attemptPrefix(videoId, attemptId)
}

// ── enqueue ──────────────────────────────────────────────────────────────────

export type EnqueueLocalJobInput = {
  videoId: string
  organizationId: string
  /** Source row already created by a browse/register control request. */
  sourceId: string
  /** Bound agent for a local source. Null for an R2 source (any agent may run it). */
  agentId: string | null
  /** Frozen ProcessingOptions blob. */
  options: Record<string, unknown>
  provider?: string
  maxAttempts?: number
}

export type EnqueueResult = { jobId: string }

/**
 * Queue a job and move the video to `processing`, in one statement.
 *
 * The video is deliberately left **without** an attempt id and lease. That is
 * what "queue waiting does not consume a processing attempt or a concurrency
 * slot" means concretely: the attempt is minted when an agent claims the job, not
 * when it is queued. A job that sits behind an offline agent for a day therefore
 * never blocks the organization's other work.
 *
 * The `video.ready`/`failed` outbox is untouched: queuing is not a lifecycle
 * transition consumers were promised an event for, and emitting one would make
 * `video.processing` fire twice for a retried job.
 */
export function buildEnqueueStatement(input: EnqueueJobRow): SQL {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  return sql`
    WITH queued_video AS (
      UPDATE video
      SET status = 'processing',
          processing_started_at = now(),
          updated_at = now()
      WHERE id = ${input.videoId}
        AND deleted_at IS NULL
        AND status IN ('uploading', 'processing', 'failed', 'pending')
      RETURNING id
    )
    INSERT INTO transcode_job (
      video_id, organization_id, provider, source_id, agent_id, options,
      state, max_attempts
    )
    SELECT ${input.videoId}::uuid,
           ${input.organizationId},
           ${input.provider ?? 'self-hosted'},
           ${input.sourceId}::uuid,
           ${input.agentId},
           ${JSON.stringify(input.options)}::jsonb,
           'queued',
           ${maxAttempts}::int
    FROM queued_video
    RETURNING id
  `
}

type EnqueueJobRow = EnqueueLocalJobInput

export async function enqueueLocalJob(
  executor: AtomicExecutor,
  input: EnqueueLocalJobInput,
): Promise<EnqueueResult | null> {
  const rows = normalizeRows(await executor.execute(buildEnqueueStatement(input)))
  const row = rows[0]
  return row ? { jobId: String(row.id) } : null
}

export type CreateLocalImportInput = {
  organizationId: string
  userId: string
  sourceId: string
  /** Bound agent for a local source; null for an r2 source. */
  agentId: string | null
  title: string
  playbackPolicy: string
  generateSubtitle: boolean
  generateChapters: boolean
  options: Record<string, unknown>
  idempotencyKey: string | null
  maxAttempts?: number
  provider?: string
}

/**
 * Create the video and queue its job in **one statement**, carrying the
 * idempotency key.
 *
 * The previous shape checked the key, created the video, queued the job, and
 * only then wrote the key — four steps with three windows. A concurrent request
 * could pass the check before the first one wrote the key, so both created a
 * video and both queued a job; the loser then failed its own video on the unique
 * violation but left its job queued, and claims deliberately accept failed
 * videos. The net effect was two encodes of one file.
 *
 * Writing the key in the same statement as the job means the database decides,
 * once. The unique index on `(organization_id, idempotency_key)` is the
 * authority; the caller's pre-check under an organization lock is an
 * optimisation that turns the common duplicate into a cheap read.
 *
 * `queued_video` is guarded on the video's own state and deletion, so this
 * cannot queue work for a row that has since been removed.
 */
export function buildCreateLocalImportStatement(input: CreateLocalImportInput): SQL {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const subtitleStatus = input.generateSubtitle ? 'pending' : null
  const chaptersStatus = input.generateChapters ? 'pending' : null

  return sql`
    WITH created_video AS (
      INSERT INTO video (
        organization_id, title, status, playback_policy, uploaded_by,
        generate_subtitle, generate_chapters, subtitle_status, chapters_status,
        processing_started_at
      )
      VALUES (
        ${input.organizationId}, ${input.title}, 'processing', ${input.playbackPolicy}::playback_policy,
        ${input.userId}, ${input.generateSubtitle}, ${input.generateChapters},
        ${subtitleStatus}, ${chaptersStatus}, now()
      )
      RETURNING id
    ),
    queued AS (
      INSERT INTO transcode_job (
        video_id, organization_id, provider, source_id, agent_id, options,
        state, max_attempts, idempotency_key
      )
      SELECT id,
             ${input.organizationId},
             ${input.provider ?? 'self-hosted'},
             ${input.sourceId}::uuid,
             ${input.agentId},
             ${JSON.stringify(input.options)}::jsonb,
             'queued',
             ${maxAttempts}::int,
             ${input.idempotencyKey}
      FROM created_video
      RETURNING id, video_id
    )
    SELECT id, video_id FROM queued
  `
}

export async function createLocalImportJob(
  executor: AtomicExecutor,
  input: CreateLocalImportInput,
): Promise<{ jobId: string; videoId: string } | null> {
  const rows = normalizeRows(await executor.execute(buildCreateLocalImportStatement(input)))
  const row = rows[0]
  return row ? { jobId: String(row.id), videoId: String(row.video_id) } : null
}

/**
 * Re-open a terminal job for a retry, and retire the failed attempt's artifacts.
 *
 * One statement, so a retry cannot half-happen: a job moved back to `queued`
 * while its video stayed `failed` would be claimed and immediately refused by
 * the video's state guard, and a video reopened without the job would sit in
 * `processing` forever.
 *
 * The inventory is retired here rather than in the caller because the reason is
 * the same one: the attempt that owned it is over.
 */
export function buildRequeueStatement(input: {
  jobId: string
  videoId: string
  organizationId: string
}): SQL {
  return sql`
    WITH reopened AS (
      UPDATE transcode_job
      SET state = 'queued',
          attempts = 0,
          failure_code = NULL,
          last_error = NULL,
          waiting_reason = NULL,
          next_attempt_at = NULL,
          attempt_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          finished_at = NULL,
          updated_at = now()
      WHERE id = ${input.jobId}::uuid
        AND organization_id = ${input.organizationId}
        AND state IN ('failed', 'cancelled')
      RETURNING id, video_id
    ),
    retired AS (
      UPDATE artifact_inventory
      SET status = 'superseded', updated_at = now()
      WHERE video_id IN (SELECT video_id FROM reopened)
        AND status <> 'superseded'
      RETURNING id
    ),
    video_state AS (
      UPDATE video
      SET status = 'processing',
          failure_code = NULL,
          processing_started_at = now(),
          transcode_attempt_id = NULL,
          transcode_lease_expires_at = NULL,
          updated_at = now()
      WHERE id IN (SELECT video_id FROM reopened)
        AND deleted_at IS NULL
      RETURNING id
    )
    SELECT id, video_id FROM reopened
  `
}

export async function requeueJob(
  executor: AtomicExecutor,
  input: { jobId: string; videoId: string; organizationId: string },
): Promise<{ jobId: string; videoId: string } | null> {
  const rows = normalizeRows(await executor.execute(buildRequeueStatement(input)))
  const row = rows[0]
  return row ? { jobId: String(row.id), videoId: String(row.video_id) } : null
}

/** An existing job for an idempotency key, if one exists. */
export function buildFindByIdempotencyKeyStatement(input: {
  organizationId: string
  idempotencyKey: string
}): SQL {
  return sql`
    SELECT j.id AS job_id, j.video_id, j.waiting_reason, v.title
    FROM transcode_job AS j
    JOIN video AS v ON v.id = j.video_id
    WHERE j.organization_id = ${input.organizationId}
      AND j.idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `
}

// ── claim ────────────────────────────────────────────────────────────────────

export type ClaimJobInput = {
  jobId: string
  agentId: string
  /**
   * The claiming agent's organization. **Required**, and enforced in SQL.
   *
   * Without it a named claim is an authorization hole: an `r2` source has
   * `agent_id = NULL` by design (any eligible machine may read an uploaded
   * object), so the source-affinity predicate `(j.agent_id IS NULL OR
   * j.agent_id = $agent)` is satisfied by *any* agent in *any* tenant that knows
   * the job UUID. The named branch is exercised by the agent's `jobId` claim and
   * must therefore carry the same tenant binding the automatic branch does.
   */
  organizationId: string
  attemptId: string
  leaseMs?: number
  /** This agent's job budget. Enforced against live ownership, not `agent_id`. */
  agentCapacity?: number | null
  /** The organization's job budget. */
  organizationCapacity?: number | null
}

/**
 * Count live attempts, by *ownership*.
 *
 * `transcode_job.agent_id` is source affinity, not ownership: it names the
 * machine a **local** source is pinned to, and is deliberately NULL for an `r2`
 * source so any eligible agent may take it. Counting capacity on that column
 * therefore misses exactly the jobs an upload produces — the common case — and
 * the cap is silently unenforced. Live ownership is `lease_owner` plus an
 * unexpired lease, which is what this counts.
 */
function liveOwnershipPredicate(scope: SQL, capacity: SQL | null): SQL {
  return sql`AND (
    ${capacity}::int IS NULL
    OR (
      SELECT count(*)
      FROM transcode_job AS active
      WHERE active.lease_owner IS NOT NULL
        AND active.lease_expires_at > now()
        AND active.state IN ('claimed', 'running', 'publishing')
        AND ${scope}
    ) < ${capacity}::int
  )`
}

/**
 * Admission locks.
 *
 * A count subquery inside the claim is not a cap on its own: two claims for
 * **different** jobs take `FOR UPDATE` on different job rows, so they never
 * block each other and both read the same pre-state. Under READ COMMITTED that
 * is unavoidable within one statement — the snapshot is taken when the statement
 * starts, before any lock it takes is granted.
 *
 * So admission is serialized on a *shared* row first, in a preceding statement
 * of the same transaction. Each statement in a READ COMMITTED transaction gets a
 * fresh snapshot, so the second claimer's count sees the first one's committed
 * row. The order (organization, then agent) is fixed so two claimers cannot
 * deadlock.
 *
 * Only taken when a cap is actually configured.
 */
export function buildAdmissionLockStatements(input: {
  organizationId: string
  agentId: string
  lockOrganization: boolean
  lockAgent: boolean
}): SQL[] {
  const statements: SQL[] = []
  if (input.lockOrganization) {
    statements.push(sql`
      SELECT o.id FROM organization AS o
      WHERE o.id = ${input.organizationId}
      FOR UPDATE
    `)
  }
  if (input.lockAgent) {
    statements.push(sql`
      SELECT a.id FROM transcoder_agent AS a
      WHERE a.id = ${input.agentId}
      FOR UPDATE
    `)
  }
  return statements
}

/**
 * Claim one named job for one agent, inside its organization.
 *
 * A named claim is the `jobId` variant an agent uses, and it applies **the same
 * rules** as an automatic claim: organization, source affinity, source
 * availability and capacity. Anything less makes the named path a way around the
 * checks the automatic path enforces.
 *
 * `attempt_id` is taken from `claimed_video`'s `RETURNING`, never re-read from
 * `video`: a data-modifying CTE's changes are invisible to the rest of the same
 * statement, so `SELECT transcode_attempt_id FROM video` would return the *old*
 * value and the job would be claimed with a NULL attempt — leaving a running job
 * the agent cannot report against.
 */
export function buildClaimJobStatement(input: ClaimJobInput): SQL {
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS
  const agentCap = input.agentCapacity ?? null
  const orgCap = input.organizationCapacity ?? null

  return sql`
    WITH candidate AS (
      SELECT j.id, j.video_id, j.organization_id
      FROM transcode_job AS j
      LEFT JOIN transcode_source AS s ON s.id = j.source_id
      WHERE j.id = ${input.jobId}::uuid
        AND j.organization_id = ${input.organizationId}
        AND j.state = 'queued'
        AND (j.agent_id IS NULL OR j.agent_id = ${input.agentId})
        AND (s.id IS NULL OR s.kind <> 'local' OR s.agent_id = ${input.agentId})
        AND (s.id IS NULL OR s.availability = 'available')
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
        ${liveOwnershipPredicate(sql`active.lease_owner = ${input.agentId}`, sql`${agentCap}`)}
        ${liveOwnershipPredicate(sql`active.organization_id = j.organization_id`, sql`${orgCap}`)}
      ORDER BY j.created_at ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    ),
    claimed_video AS (
      UPDATE video
      SET transcode_attempt_id = ${input.attemptId},
          status = 'processing',
          processing_started_at = now(),
          job_attempts = COALESCE(job_attempts, 0) + 1,
          last_heartbeat_at = NULL,
          transcode_lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
          failure_code = NULL,
          updated_at = now()
      WHERE id = (SELECT video_id FROM candidate)
        AND deleted_at IS NULL
        AND organization_id = ${input.organizationId}
        AND status IN ('processing', 'uploading', 'failed', 'pending')
      RETURNING id, transcode_attempt_id AS attempt_id
    )
    UPDATE transcode_job AS j
    SET state = 'claimed',
        attempt_id = v.attempt_id,
        attempts = j.attempts + 1,
        lease_owner = ${input.agentId},
        lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
        waiting_reason = NULL,
        started_at = COALESCE(j.started_at, now()),
        updated_at = now()
    FROM candidate AS c, claimed_video AS v
    WHERE j.id = c.id
      AND v.id = c.video_id
    RETURNING j.id, j.video_id, j.organization_id, j.source_id, j.options, j.attempt_id, j.attempts
  `
}

export type ClaimedJob = {
  jobId: string
  videoId: string
  organizationId: string
  sourceId: string | null
  options: Record<string, unknown>
  attemptId: string
  attempts: number
}

function toClaimedJob(row: Record<string, unknown>): ClaimedJob {
  return {
    jobId: String(row.id),
    videoId: String(row.video_id),
    organizationId: String(row.organization_id),
    sourceId: row.source_id ? String(row.source_id) : null,
    options: (row.options ?? {}) as Record<string, unknown>,
    attemptId: String(row.attempt_id),
    attempts: Number(row.attempts ?? 1),
  }
}

/**
 * Run [admission locks..., claim] atomically and return the claim's rows.
 *
 * The lock statements' own results are discarded; they exist to serialize
 * admission so the capacity subquery in the claim sees a committed world.
 */
async function claimUnderAdmissionLocks(
  executor: AtomicExecutor,
  input: { organizationId: string; agentId: string; needsOrgLock: boolean; needsAgentLock: boolean },
  claim: () => SQL,
): Promise<Record<string, unknown>[]> {
  const atomic = executor as AtomicExecutor & AtomicBatchExecutor
  if (!supportsAtomicBatch(atomic)) {
    // A driver that can neither batch nor transact cannot order the lock ahead
    // of the claim, so the cap would not hold. Refuse rather than over-admit.
    throw new Error(
      'capacity-limited job claims require a driver with batch() or transaction()',
    )
  }

  const locks = buildAdmissionLockStatements({
    organizationId: input.organizationId,
    agentId: input.agentId,
    lockOrganization: input.needsOrgLock,
    lockAgent: input.needsAgentLock,
  })

  const results = await runAtomically(atomic, (handle) => {
    const scoped = handle as unknown as AtomicExecutor
    return [...locks.map((lock) => scoped.execute(lock)), scoped.execute(claim())]
  })

  return normalizeRows(results[results.length - 1])
}

/**
 * Find and claim the oldest job this agent is eligible for, in one statement.
 *
 * Eligibility is where source affinity lives: a `local` source names the machine
 * that holds the file, and any other agent is excluded outright. An `r2` source
 * has no agent, so every eligible machine in the **organization** may take it.
 *
 * `FOR UPDATE OF j` is not optional. The `LEFT JOIN transcode_source` makes `s`
 * the nullable side of an outer join, and PostgreSQL rejects an unqualified
 * `FOR UPDATE` there with "FOR UPDATE cannot be applied to the nullable side of
 * an outer join" — so the unqualified form is not a subtly different lock, it is
 * a statement that never runs.
 *
 * `attempt_id` comes from `claimed_video`'s `RETURNING`: a data-modifying CTE's
 * changes are invisible to the rest of the same statement, so re-reading `video`
 * would yield the pre-update value and claim the job with a NULL attempt.
 */
export function buildClaimNextJobStatement(input: {
  agentId: string
  organizationId: string
  agentCapacity?: number
  organizationCapacity?: number | null
  leaseMs?: number
  jobId?: string
  /** Minted by the caller when it needs to know the id before claiming. */
  attemptId?: string
}): SQL {
  const agentCap = Math.max(1, input.agentCapacity ?? 1)
  const orgCap = input.organizationCapacity ?? null
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS
  // The attempt id is generated in SQL when the caller has no reason to know it
  // in advance, which keeps the common claim to a single round trip.
  const attemptId = input.attemptId
    ? sql`${input.attemptId}`
    : sql`${input.agentId} || ':' || gen_random_uuid()::text`

  return sql`
    WITH candidate AS (
      SELECT j.id, j.video_id, j.organization_id
      FROM transcode_job AS j
      LEFT JOIN transcode_source AS s ON s.id = j.source_id
      WHERE j.organization_id = ${input.organizationId}
        AND j.state = 'queued'
        AND (j.agent_id IS NULL OR j.agent_id = ${input.agentId})
        AND (s.id IS NULL OR s.kind <> 'local' OR s.agent_id = ${input.agentId})
        AND (s.id IS NULL OR s.availability = 'available')
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
        AND (${input.jobId ?? null}::uuid IS NULL OR j.id = ${input.jobId ?? null}::uuid)
        ${liveOwnershipPredicate(sql`active.lease_owner = ${input.agentId}`, sql`${agentCap}`)}
        ${liveOwnershipPredicate(sql`active.organization_id = j.organization_id`, sql`${orgCap}`)}
      ORDER BY j.created_at ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    ),
    claimed_video AS (
      UPDATE video
      SET transcode_attempt_id = ${attemptId},
          status = 'processing',
          processing_started_at = now(),
          job_attempts = COALESCE(job_attempts, 0) + 1,
          last_heartbeat_at = NULL,
          transcode_lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
          failure_code = NULL,
          updated_at = now()
      WHERE id = (SELECT video_id FROM candidate)
        AND deleted_at IS NULL
        AND organization_id = ${input.organizationId}
        AND status IN ('processing', 'uploading', 'failed', 'pending')
      RETURNING id, transcode_attempt_id AS attempt_id
    )
    UPDATE transcode_job AS j
    SET state = 'claimed',
        attempt_id = v.attempt_id,
        attempts = j.attempts + 1,
        lease_owner = ${input.agentId},
        lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
        waiting_reason = NULL,
        started_at = COALESCE(j.started_at, now()),
        updated_at = now()
    FROM candidate AS c, claimed_video AS v
    WHERE j.id = c.id
      AND v.id = c.video_id
    RETURNING j.id, j.video_id, j.organization_id, j.source_id, j.options,
              j.attempt_id, j.attempts
  `
}

export async function claimJob(
  executor: AtomicExecutor,
  input: ClaimJobInput,
): Promise<ClaimedJob | null> {
  const needsAgentLock = (input.agentCapacity ?? null) !== null
  const needsOrgLock = (input.organizationCapacity ?? null) !== null

  const rows =
    needsAgentLock || needsOrgLock
      ? await claimUnderAdmissionLocks(
          executor,
          {
            organizationId: input.organizationId,
            agentId: input.agentId,
            needsOrgLock,
            needsAgentLock,
          },
          () => buildClaimJobStatement(input),
        )
      : normalizeRows(await executor.execute(buildClaimJobStatement(input)))

  const row = rows[0]
  return row && row.attempt_id ? toClaimedJob(row) : null
}

/** Attempt ids minted in SQL are opaque; the protocol treats them as strings. */
export async function claimNextJob(
  executor: AtomicExecutor,
  input: {
    agentId: string
    organizationId: string
    capacity?: number
    organizationCapacity?: number | null
    leaseMs?: number
    jobId?: string
  },
): Promise<ClaimedJob | null> {
  const needsAgentLock = true // the agent cap defaults to 1, so it is always set
  const needsOrgLock = (input.organizationCapacity ?? null) !== null

  const rows =
    needsAgentLock || needsOrgLock
      ? await claimUnderAdmissionLocks(
          executor,
          {
            organizationId: input.organizationId,
            agentId: input.agentId,
            needsOrgLock,
            needsAgentLock,
          },
          () =>
            buildClaimNextJobStatement({
              ...input,
              agentCapacity: input.capacity,
            }),
        )
      : normalizeRows(
          await executor.execute(
            buildClaimNextJobStatement({ ...input, agentCapacity: input.capacity }),
          ),
        )

  const row = rows[0]
  return row && row.attempt_id ? toClaimedJob(row) : null
}

// ── state transitions ────────────────────────────────────────────────────────

export function buildJobStateStatement(input: {
  jobId: string
  agentId: string
  attemptId: string
  from: JobState[]
  to: JobState
  leaseMs?: number
}): SQL {
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS
  const fromList = sql.join(
    input.from.map((state) => sql`${state}`),
    sql`, `,
  )
  return sql`
    UPDATE transcode_job
    SET state = ${input.to},
        lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
        updated_at = now()
    WHERE id = ${input.jobId}::uuid
      AND attempt_id = ${input.attemptId}
      AND lease_owner = ${input.agentId}
      AND state IN (${fromList})
    RETURNING id, state
  `
}

export async function setJobState(
  executor: AtomicExecutor,
  input: Parameters<typeof buildJobStateStatement>[0],
): Promise<boolean> {
  const rows = normalizeRows(await executor.execute(buildJobStateStatement(input)))
  return rows.length > 0
}

/**
 * Terminal transition for a successful job.
 *
 * `succeeded` is written only after the inventory is verified and the video row
 * has been published. The guard on `publishing` means a late success from a
 * superseded attempt cannot mark the job done after a newer attempt took it.
 */
export function buildSucceedJobStatement(input: {
  jobId: string
  attemptId: string
}): SQL {
  return sql`
    UPDATE transcode_job
    SET state = 'succeeded',
        finished_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        failure_code = NULL,
        last_error = NULL,
        waiting_reason = NULL,
        updated_at = now()
    WHERE id = ${input.jobId}::uuid
      AND attempt_id = ${input.attemptId}
      AND state IN ('claimed', 'running', 'publishing')
    RETURNING id
  `
}

export type FailJobInput = {
  jobId: string
  attemptId: string
  failureCode: string
  message: string
}

/**
 * Record a failed attempt, and decide what happens to the job.
 *
 * The decision lives in SQL so it cannot disagree with the row it is based on:
 * the `CASE` reads `attempts` and `max_attempts` from the same row it writes.
 *
 * Three outcomes, and the third is the one that was wrong before:
 *
 * - **source-condition** (`SOURCE_MISSING` / `SOURCE_CHANGED` /
 *   `SOURCE_UNREADABLE`): back to `queued` with an explicit `waiting_reason`,
 *   *always*, however many times it has happened. The claim's increment of
 *   `attempts` is undone (`GREATEST(0, attempts - 1)`) so waiting does not spend
 *   the execution budget — otherwise a drive that was unmounted for a week would
 *   exhaust the budget and *then* fail the job the moment it came back.
 * - **retryable**: back to `queued` until the budget is spent, then terminal.
 * - **terminal**: failed immediately; re-running the same bytes changes nothing.
 *
 * The previous version collapsed "does not consume a retry" into "do not return
 * to the queue", which failed a job on its first attempt for a missing file — the
 * opposite of the documented behaviour, and reproduced against PostgreSQL.
 */
export function buildFailJobStatement(input: FailJobInput): SQL {
  const failureClass = classifyFailure(input.failureCode)
  const isSourceCondition = failureClass === 'source-condition'
  const isRetryable = failureClass === 'retryable'
  const waitingReason = isSourceCondition
    ? sourceWaitingReason(input.failureCode)
    : 'retry-backoff'

  return sql`
    UPDATE transcode_job
    SET failure_code = ${input.failureCode},
        last_error = ${input.message},
        state = CASE
          WHEN ${isSourceCondition}::boolean THEN 'queued'
          WHEN ${isRetryable}::boolean AND attempts < max_attempts THEN 'queued'
          ELSE 'failed'
        END,
        next_attempt_at = CASE
          WHEN ${isSourceCondition}::boolean
            THEN now() + interval '1 minute'
          WHEN ${isRetryable}::boolean AND attempts < max_attempts
            THEN now() + ((${nextAttemptDelayMs(1)}::int * attempts)::int * interval '1 millisecond')
          ELSE NULL
        END,
        waiting_reason = CASE
          WHEN ${isSourceCondition}::boolean THEN ${waitingReason}
          WHEN ${isRetryable}::boolean AND attempts < max_attempts THEN 'retry-backoff'
          ELSE NULL
        END,
        attempt_id = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        -- Waiting on a machine is not an attempt. Undoing the claim's increment
        -- is what keeps the budget about *execution* rather than about elapsed
        -- wall clock.
        attempts = CASE
          WHEN ${isSourceCondition}::boolean THEN GREATEST(0, attempts - 1)
          ELSE attempts
        END,
        source_wait_count = CASE
          WHEN ${isSourceCondition}::boolean THEN source_wait_count + 1
          ELSE source_wait_count
        END,
        finished_at = CASE
          WHEN ${isSourceCondition}::boolean THEN NULL
          WHEN ${isRetryable}::boolean AND attempts < max_attempts THEN NULL
          ELSE now()
        END,
        updated_at = now()
    WHERE id = ${input.jobId}::uuid
      AND attempt_id = ${input.attemptId}
      AND state IN ('claimed', 'running', 'publishing')
    RETURNING id, state, attempts, max_attempts, waiting_reason
  `
}

export type FailJobOutcome = {
  jobId: string
  state: JobState
  attempts: number
  willRetry: boolean
  waitingReason: string | null
}

export async function failJob(
  executor: AtomicExecutor,
  input: FailJobInput,
): Promise<FailJobOutcome | null> {
  const rows = normalizeRows(await executor.execute(buildFailJobStatement(input)))
  const row = rows[0]
  if (!row) return null
  // The attempt is over, so its upload grants must stop being renewable. The
  // authorization check also requires the job's current attempt id, so a stale
  // inventory is already unusable — this makes the retirement explicit and
  // visible rather than implied.
  await retireInventory(executor, input.jobId)
  if (String(row.state) === JOB_STATE_FAILED) {
    await retireAttemptPrefix(executor, input.jobId)
  }
  return {
    jobId: String(row.id),
    state: String(row.state) as JobState,
    attempts: Number(row.attempts ?? 0),
    willRetry: String(row.state) === JOB_STATE_QUEUED,
    waitingReason: row.waiting_reason ? String(row.waiting_reason) : null,
  }
}

export async function succeedJob(
  executor: AtomicExecutor,
  input: { jobId: string; attemptId: string },
): Promise<boolean> {
  const rows = normalizeRows(await executor.execute(buildSucceedJobStatement(input)))
  return rows.length > 0
}

/**
 * Cancel a job and release whatever it held — one statement.
 *
 * Also clears the video's attempt id and lease, so a cancelled job stops
 * counting against the organization cap immediately instead of waiting for a
 * lease to expire. A late completion from the cancelled attempt then fails the
 * ownership guard rather than publishing.
 */
export function buildCancelJobStatement(input: { jobId: string; organizationId: string; reason?: string }): SQL {
  return sql`
    WITH cancelled AS (
      UPDATE transcode_job
      SET state = 'cancelled',
          last_error = ${input.reason ?? 'cancelled by operator'},
          failure_code = 'CANCELLED',
          attempt_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_attempt_at = NULL,
          waiting_reason = NULL,
          finished_at = now(),
          updated_at = now()
      WHERE id = ${input.jobId}::uuid
        AND organization_id = ${input.organizationId}
        AND state IN ('queued', 'claimed', 'running', 'publishing', 'failed')
      RETURNING id, video_id
    ),
    released AS (
      UPDATE video
      SET transcode_attempt_id = NULL,
          transcode_lease_expires_at = NULL,
          updated_at = now()
      WHERE id IN (SELECT video_id FROM cancelled)
        AND transcode_attempt_id IS NOT NULL
      RETURNING id
    )
    SELECT id, video_id FROM cancelled
  `
}

export async function cancelJob(
  executor: AtomicExecutor,
  input: { jobId: string; organizationId: string; reason?: string },
): Promise<{ jobId: string; videoId: string } | null> {
  const rows = normalizeRows(await executor.execute(buildCancelJobStatement(input)))
  const row = rows[0]
  if (!row) return null
  await retireInventory(executor, input.jobId)
  await retireAttemptPrefix(executor, input.jobId)
  return { jobId: String(row.id), videoId: String(row.video_id) }
}

/** Reclaim the abandoned attempt's output prefix, once its writers retire. */
async function retireAttemptPrefix(executor: AtomicExecutor, jobId: string): Promise<void> {
  try {
    const rows = normalizeRows(
      await executor.execute(sql`
        SELECT video_id, organization_id, attempt_id
        FROM transcode_job
        WHERE id = ${jobId}::uuid AND attempt_id IS NOT NULL
        LIMIT 1
      `),
    )
    const row = rows[0]
    if (!row?.attempt_id) return
    await enqueueAttemptCleanup(executor, {
      videoId: String(row.video_id),
      organizationId: row.organization_id ? String(row.organization_id) : null,
      attemptId: String(row.attempt_id),
    })
  } catch (error) {
    console.error('[QUEUE] could not retire attempt prefix:', error)
  }
}

/**
 * Queue the reclamation of an abandoned attempt's output prefix.
 *
 * The video stays live; only `videos/<id>/attempts/<attempt>/` goes. Without
 * this a superseded or failed attempt keeps its segments forever — the
 * video-deletion cleanup reclaims `videos/<id>/` only when the video itself is
 * deleted, which for a permanently failed import is never.
 *
 * `not_before` is pushed past the longest-lived outstanding writer (a presigned
 * PUT is valid for an hour) so cleanup can never delete underneath an upload
 * that is still legitimately allowed to land.
 */
export function buildEnqueueAttemptCleanupStatement(input: {
  videoId: string
  organizationId: string | null
  attemptId: string
  prefix: string
}): SQL {
  return sql`
    INSERT INTO storage_cleanup_job (id, video_id, organization_id, raw_key, prefix, not_before)
    VALUES (
      'scj_' || gen_random_uuid()::text,
      ${input.videoId}::uuid,
      ${input.organizationId},
      NULL,
      ${input.prefix},
      now() + interval '2 hours'
    )
    ON CONFLICT (video_id, prefix) WHERE status <> 'reclaimed' DO NOTHING
    RETURNING id
  `
}

export async function enqueueAttemptCleanup(
  executor: AtomicExecutor,
  input: { videoId: string; organizationId: string | null; attemptId: string },
): Promise<boolean> {
  try {
    const rows = normalizeRows(
      await executor.execute(
        buildEnqueueAttemptCleanupStatement({
          ...input,
          prefix: attemptPrefix(input.videoId, input.attemptId),
        }),
      ),
    )
    return rows.length > 0
  } catch (error) {
    // Best-effort: an unqueued cleanup is a leak the next deletion pass will
    // catch, never a reason to fail the transition that triggered it.
    console.error('[QUEUE] could not enqueue attempt cleanup:', error)
    return false
  }
}

/**
 * Retire a job's inventories. Best-effort: the grant authorization independently
 * requires the job to still name the inventory's attempt, so a failure here
 * cannot authorize a stale write — it only leaves a row marked optimistically.
 */
async function retireInventory(executor: AtomicExecutor, jobId: string): Promise<void> {
  try {
    await executor.execute(sql`
      UPDATE artifact_inventory
      SET status = 'superseded', updated_at = now()
      WHERE job_id = ${jobId}::uuid
        AND status <> 'superseded'
    `)
  } catch (error) {
    console.error('[QUEUE] could not retire inventory:', error)
  }
}

/**
 * Reclaim jobs whose lease expired.
 *
 * Local jobs have no wall-clock deadline — a CPU encode of a lecture is
 * legitimately slow — so expiry of the *lease* (not of the work) is the only
 * liveness signal. An expired lease means the agent stopped beating, and the
 * attempt is retired so the job can be retried; the agent's own reconcile step
 * refuses to resume work whose attempt it no longer owns.
 */
export function buildReclaimExpiredJobsStatement(input: { limit?: number } = {}): SQL {
  const limit = Math.max(1, input.limit ?? 25)
  return sql`
    WITH expired AS (
      SELECT id, video_id, attempt_id, organization_id
      FROM transcode_job
      WHERE state IN ('claimed', 'running', 'publishing')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
      ORDER BY lease_expires_at ASC
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    ),
    requeued AS (
      UPDATE transcode_job AS j
      SET state = 'queued',
          waiting_reason = 'agent-offline',
          attempt_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          next_attempt_at = now() + interval '1 minute',
          source_wait_count = j.source_wait_count + 1,
          updated_at = now()
      WHERE j.id IN (SELECT id FROM expired)
      RETURNING j.id, j.video_id, j.attempt_id
    ),
    released AS (
      UPDATE video
      SET transcode_attempt_id = NULL,
          transcode_lease_expires_at = NULL,
          updated_at = now()
      WHERE id IN (SELECT video_id FROM expired)
        AND transcode_attempt_id IS NOT NULL
      RETURNING id
    )
    SELECT id, video_id FROM requeued
  `
}

export async function reclaimExpiredJobs(
  executor: AtomicExecutor,
  input: { limit?: number } = {},
): Promise<Array<{ jobId: string; videoId: string }>> {
  const rows = normalizeRows(await executor.execute(buildReclaimExpiredJobsStatement(input)))
  const reclaimed = rows.map((row) => ({ jobId: String(row.id), videoId: String(row.video_id) }))
  for (const job of reclaimed) {
    await retireInventory(executor, job.jobId)
    await retireAttemptPrefix(executor, job.jobId)
  }
  return reclaimed
}

/**
 * Explain why a queued job is not running.
 *
 * Pure, so the mapping is checkable with literals. The dashboard shows this
 * verbatim: "waiting for the agent that holds this file" and "waiting for the
 * agent to finish another job" call for completely different actions from the
 * owner, and a single "queued" tells them neither.
 */
export function classifyWaitingReason(input: {
  jobAgentId: string | null
  onlineAgentIds: Set<string>
  sourceKind: string | null
  sourceAvailability: string | null
  agentCapacityFree: boolean
  nextAttemptAt: Date | null
  now?: Date
}): WaitingReason | null {
  const now = input.now ?? new Date()

  // Ordered from "nothing can fix this" to "nothing is wrong", so the first
  // matching cause is also the most actionable one.
  if (input.sourceAvailability === 'missing') return 'source-missing'
  if (input.sourceAvailability === 'changed') return 'source-changed'

  // A local source with no bound agent can never run: no other machine holds the
  // file, so waiting will not help and the owner has to re-register it.
  if (input.sourceKind === 'local' && !input.jobAgentId) return 'no-eligible-agent'

  if (input.onlineAgentIds.size === 0) return 'agent-offline'
  if (input.sourceKind === 'local' && input.jobAgentId && !input.onlineAgentIds.has(input.jobAgentId)) {
    return 'agent-offline'
  }

  if (!input.agentCapacityFree) return 'agent-busy'

  // Checked after capacity: an agent that is both busy and in backoff is busy
  // now, and that is the state the owner can act on.
  if (input.nextAttemptAt && input.nextAttemptAt.getTime() > now.getTime()) {
    return 'retry-backoff'
  }
  return null
}

// ── reads for the protocol ───────────────────────────────────────────────────

/**
 * Re-acquire an attempt this agent already owns, after a restart.
 *
 * Distinct from a claim: a job this agent already holds is not `queued`, so
 * claiming it is impossible. Reporting that an attempt may be resumed and then
 * being unable to resume it is what left restarted agents idling until the lease
 * expired — the video stuck, the capacity slot consumed, and the recovery path
 * present only on paper.
 *
 * Extends both leases, because the inventory authorization reads the job's and
 * the completion path reads the video's.
 */
export function buildResumeAttemptStatement(input: {
  jobId: string
  attemptId: string
  agentId: string
  leaseMs?: number
}): SQL {
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS
  return sql`
    WITH owning AS (
      SELECT id, video_id FROM transcode_job
      WHERE id = ${input.jobId}::uuid
        AND attempt_id = ${input.attemptId}
        AND lease_owner = ${input.agentId}
        AND state IN ('claimed', 'running', 'publishing')
    ),
    extended_job AS (
      UPDATE transcode_job AS j
      SET lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
          updated_at = now()
      WHERE j.id IN (SELECT id FROM owning)
      RETURNING j.id, j.video_id, j.organization_id, j.source_id, j.options, j.attempts
    ),
    extended_video AS (
      UPDATE video AS v
      SET transcode_lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
          last_heartbeat_at = now()
      WHERE v.id IN (SELECT video_id FROM extended_job)
        AND v.transcode_attempt_id = ${input.attemptId}
        AND v.deleted_at IS NULL
      RETURNING v.id
    )
    SELECT id, video_id, organization_id, source_id, options, attempts
    FROM extended_job
    WHERE EXISTS (SELECT 1 FROM extended_video)
  `
}

export async function resumeOwnedAttempt(
  executor: AtomicExecutor,
  input: { jobId: string; attemptId: string; agentId: string; leaseMs?: number },
): Promise<ClaimedJob | null> {
  const rows = normalizeRows(await executor.execute(buildResumeAttemptStatement(input)))
  const row = rows[0]
  if (!row) return null
  return {
    jobId: input.jobId,
    videoId: String(row.video_id),
    organizationId: String(row.organization_id),
    sourceId: row.source_id ? String(row.source_id) : null,
    options: (row.options ?? {}) as Record<string, unknown>,
    attemptId: input.attemptId,
    attempts: Number(row.attempts ?? 0),
  }
}

export function buildOutstandingWorkStatement(input: { agentId: string }): SQL {
  return sql`
    SELECT
      (SELECT count(*) FROM agent_control_request
        WHERE agent_id = ${input.agentId} AND status = 'pending' AND expires_at > now())::int
        AS "pendingControls",
      (SELECT count(*) FROM transcode_job
        WHERE agent_id = ${input.agentId}
          AND state IN ('claimed', 'running', 'publishing'))::int
        AS "activeJobs"
  `
}

export async function readOutstandingWork(
  executor: AtomicExecutor,
  input: { agentId: string },
): Promise<{ pendingControls: number; activeJobs: number }> {
  const rows = normalizeRows(await executor.execute(buildOutstandingWorkStatement(input)))
  const row = rows[0] ?? {}
  return {
    pendingControls: Number(row.pendingControls ?? 0),
    activeJobs: Number(row.activeJobs ?? 0),
  }
}

export function buildAttemptStateStatement(input: {
  jobId: string
  attemptId: string
}): SQL {
  return sql`
    SELECT j.state, j.attempt_id, j.video_id, j.organization_id, j.failure_code,
           j.lease_expires_at,
           (SELECT status FROM video WHERE id = j.video_id) AS video_status,
           (SELECT transcode_attempt_id FROM video WHERE id = j.video_id) AS video_attempt_id
    FROM transcode_job AS j
    WHERE j.id = ${input.jobId}::uuid
      AND j.attempt_id = ${input.attemptId}
  `
}

export type AttemptState = {
  state: JobState | null
  videoStatus: string | null
  ownsAttempt: boolean
  failureCode: string | null
}

export async function readAttemptState(
  executor: AtomicExecutor,
  input: { jobId: string; attemptId: string },
): Promise<AttemptState> {
  const rows = normalizeRows(await executor.execute(buildAttemptStateStatement(input)))
  const row = rows[0]
  if (!row) return { state: null, videoStatus: null, ownsAttempt: false, failureCode: null }
  return {
    state: String(row.state) as JobState,
    videoStatus: row.video_status ? String(row.video_status) : null,
    // Ownership is asserted by the video row, which is the authority the
    // completion path guards on. The job row agreeing is not enough.
    ownsAttempt: row.video_attempt_id === input.attemptId,
    failureCode: row.failure_code ? String(row.failure_code) : null,
  }
}
