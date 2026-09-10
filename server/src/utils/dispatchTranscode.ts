/**
 * Claim-then-dispatch: the only supported way to start a transcode job.
 *
 * Claiming and dispatching are two steps, and doing them out of order (or
 * skipping the claim) reintroduces the two failure modes the claim exists to
 * prevent: two GPU containers for one video, and a stalled attempt mutating a
 * row that a newer attempt owns. So they are packaged together here and every
 * call site — upload completion, the retry endpoint, the B2B upload API, and
 * the sweeper — goes through this function.
 *
 * Ordering, and why it changed:
 *
 * The previous code dispatched FIRST and flipped `uploading -> processing`
 * after the dispatch was accepted, so that a failed dispatch could not strand
 * a row in `processing`. That ordering cannot express attempt ownership, so it
 * is inverted: the claim is the compare-and-swap, and it both flips the status
 * and records the owner. A dispatch that then fails is marked `failed` here,
 * which is the same terminal state the old code produced.
 *
 * `job_attempts` is incremented by the claim, so an attempt that is claimed and
 * then fails to dispatch still counts — that is deliberate: it is a real
 * attempt that really consumed a slot, and counting it keeps the sweeper's
 * retry budget honest.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../lib/database'
import { video } from '../db/schema'
import {
  claimTranscodeAttempt,
  organizationCapFromEnv,
  DEFAULT_TRANSCODE_LEASE_MS,
  type ClaimRejection,
} from '../lib/transcodeClaim'
import type { AtomicExecutor } from '../lib/atomicWrite'
import {
  triggerTranscoding,
  DispatchError,
  isUncertainDispatch,
  type TranscodeDispatchRequest,
} from './queue'

export { DEFAULT_TRANSCODE_LEASE_MS } from '../lib/transcodeClaim'

export type DispatchFailureReason =
  | ClaimRejection
  /** The dispatch was definitively refused; the row was marked failed. */
  | 'dispatch-failed'
  /**
   * The outcome is unknown (network error, timeout, 5xx) — the request may have
   * been accepted. The attempt claim is deliberately left in place so the lease
   * expires and the sweeper reconciles, rather than marking a possibly-running
   * job failed.
   */
  | 'dispatch-uncertain'

export type DispatchTranscodeResult =
  | {
      dispatched: true
      attemptId: string
      jobAttempts: number
    }
  | {
      dispatched: false
      reason: DispatchFailureReason
      /** Present when `reason` is `dispatch-failed`. */
      error?: DispatchError
    }

export type DispatchTranscodeOptions = {
  videoId: string
  rawKey: string
  organizationId: string
  playbackPolicy?: 'public' | 'signed'
  generateSubtitle?: boolean
  generateChapters?: boolean
  env?: Parameters<typeof triggerTranscoding>[0]['env']
  /**
   * Reuse an existing attempt id when retrying a dispatch whose outcome is
   * unknown. Minting a fresh id on an uncertain retry is what turns a lost
   * response into a duplicate GPU run, so callers recovering from ambiguity
   * must pass the original id. Omit to mint a new one.
   */
  attemptId?: string
  leaseMs?: number
  organizationCap?: number | null
  /** Set only by the sweeper, reclaiming an attempt whose lease has expired. */
  expectedAttemptId?: string | null
  /** Injected for tests; defaults to the shared db handle. */
  executor?: AtomicExecutor
  /** Injected for tests; defaults to the real dispatcher. */
  dispatch?: (request: TranscodeDispatchRequest) => Promise<void>
  /** Injected for tests; defaults to crypto.randomUUID. */
  mintAttemptId?: () => string
  /** Injected for tests; defaults to marking the row failed in the database. */
  markVideoFailed?: (
    videoId: string,
    failureCode: string,
    attemptId: string,
  ) => Promise<unknown>
}

/**
 * Fail a video, but only if the attempt that failed still owns it.
 *
 * Updating by id alone let a delayed dispatch failure clobber a row that had
 * since completed, or been superseded by a newer attempt. The guards make the
 * write conditional on exactly the state the failure was observed in.
 */
function markFailedInDb(
  videoId: string,
  failureCode: string,
  attemptId: string,
): Promise<unknown> {
  return db
    .update(video)
    .set({ status: 'failed', failureCode, updatedAt: new Date() })
    .where(
      and(
        eq(video.id, videoId),
        eq(video.status, 'processing'),
        eq(video.transcodeAttemptId, attemptId),
        isNull(video.deletedAt),
      ),
    )
}

/**
 * Claim an attempt for `videoId`, then dispatch it.
 *
 * Never throws for a lost claim — a lost claim is an expected outcome under
 * concurrency, reported as `{ dispatched: false, reason }`. A dispatch failure
 * is also reported rather than thrown, after the row is marked `failed`.
 */
export async function dispatchTranscodeJob(
  options: DispatchTranscodeOptions,
): Promise<DispatchTranscodeResult> {
  const {
    videoId,
    rawKey,
    organizationId,
    playbackPolicy = 'public',
    generateSubtitle = false,
    generateChapters = false,
    env,
    leaseMs = DEFAULT_TRANSCODE_LEASE_MS,
    expectedAttemptId = null,
    executor,
    dispatch = triggerTranscoding,
    mintAttemptId = () => crypto.randomUUID(),
    markVideoFailed = markFailedInDb,
  } = options

  const attemptId = options.attemptId ?? mintAttemptId()

  // Resolve the cap from the environment when the caller does not name one.
  // Previously this defaulted straight to `null`, which meant every production
  // dispatch was unlimited no matter what an operator configured.
  const organizationCap =
    options.organizationCap !== undefined
      ? options.organizationCap
      : organizationCapFromEnv(env as Record<string, unknown> | undefined)

  const claim = await claimTranscodeAttempt(executor ?? db, {
    videoId,
    attemptId,
    leaseMs,
    expectedAttemptId,
    organizationCap,
  })

  if (!claim.claimed) {
    // Deleted, already owned by a live attempt, or the org is at capacity.
    // Dispatching here would be the duplicate-run bug, so we stop.
    return { dispatched: false, reason: claim.reason }
  }

  try {
    await dispatch({
      key: rawKey,
      fileId: videoId,
      organizationId,
      attemptId: claim.attemptId,
      playbackPolicy,
      generateSubtitle,
      generateChapters,
      env,
    })
  } catch (err) {
    const error =
      err instanceof DispatchError
        ? err
        : new DispatchError('NETWORK', err instanceof Error ? err.message : String(err))

    if (isUncertainDispatch(error)) {
      // Do NOT mark the row failed: the request may have been accepted and the
      // job may be running. Leaving the claim intact means its lease expires and
      // the sweeper reconciles — retrying the *same attempt id*, which the
      // transcoder suppresses if it already started.
      return { dispatched: false, reason: 'dispatch-uncertain', error }
    }

    await markVideoFailed(videoId, error.code, claim.attemptId)
    return { dispatched: false, reason: 'dispatch-failed', error }
  }

  return { dispatched: true, attemptId: claim.attemptId, jobAttempts: claim.jobAttempts }
}

/**
 * HTTP status for a refused dispatch, so every call site agrees.
 *
 * `503` for an uncertain outcome is deliberate: the caller should retry later,
 * and the job may well be running already.
 */
export type DispatchFailureStatus = 404 | 409 | 429 | 502 | 503

/** Literal union (not `number`) so Hono's typed `c.json` accepts it. */
export function dispatchFailureStatus(
  reason: DispatchFailureReason,
): DispatchFailureStatus {
  switch (reason) {
    case 'at-capacity':
      return 429
    case 'dispatch-uncertain':
      return 503
    case 'dispatch-failed':
      return 502
    case 'deleted':
    case 'not-found':
      return 404
    case 'already-claimed':
      return 409
    default:
      return 409
  }
}
