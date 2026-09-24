import { and, asc, eq, inArray, lt, notExists, sql } from 'drizzle-orm'
import { db } from '../lib/database'
import { transcodeJob, video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { dispatchTranscodeJob } from './dispatchTranscode'
import type { SweepableVideo, SweepAdapters, SweepLimits } from './jobSweeper'
import type { EnvLike } from '../lib/config'

/**
 * Production sweep adapters — thin SQL/dispatch glue over the pure
 * jobSweeper core. Environment values come from the runtime env so tests can
 * inject them.
 */

export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  processingStaleMs: 45 * 60_000,
  uploadingStaleMs: 24 * 60 * 60_000,
  maxJobAttempts: 3,
}

export function sweepLimitsFromEnv(env: EnvLike = {}): SweepLimits {
  const readPositiveInt = (key: string, fallback: number): number => {
    const raw = env[key]
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const processingMin = readPositiveInt('SWEEP_PROCESSING_STALE_MIN', 45)
  const uploadingHours = readPositiveInt('SWEEP_UPLOADING_STALE_HOURS', 24)
  return {
    processingStaleMs: processingMin * 60_000,
    uploadingStaleMs: uploadingHours * 60 * 60_000,
    maxJobAttempts: readPositiveInt('SWEEP_MAX_ATTEMPTS', 3),
  }
}

const ACTIVITY_EXPR = sql`GREATEST(
  COALESCE(${video.updatedAt}, ${video.processingStartedAt}),
  COALESCE(${video.lastHeartbeatAt}, ${video.updatedAt}),
  COALESCE(${video.processingStartedAt}, ${video.updatedAt})
)`

function toSweepable(row: typeof video.$inferSelect): SweepableVideo {
  return {
    id: row.id,
    status: row.status ?? 'pending',
    updatedAt: row.updatedAt,
    processingStartedAt: row.processingStartedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    jobAttempts: row.jobAttempts,
    rawKey: row.rawKey,
    title: row.title,
    organizationId: row.organizationId,
    playbackPolicy: row.playbackPolicy ?? 'public',
    generateSubtitle: row.generateSubtitle ?? false,
    generateChapters: row.generateChapters ?? false,
    transcodeAttemptId: row.transcodeAttemptId,
  }
}

/**
 * Videos the local queue owns.
 *
 * The sweeper and the local job queue both reclaim stuck work, and they must not
 * reclaim the *same* work: the sweeper would re-dispatch through the Modal path
 * (which needs a `rawKey` a local import does not have), while the queue requeues
 * against the typed source. Excluding them here keeps the two reconcilers
 * disjoint, which is the only way "the job is stuck" has one owner.
 *
 * A job row in a terminal state is *not* excluded: the video is then genuinely
 * the sweeper's problem, and that is exactly the case where a `processing` video
 * whose job already failed should be caught.
 */
function notOwnedByLocalQueue() {
  // Built inside the function, not at module scope: this module is imported by
  // `maintenance.ts`, which `/health/config` imports, and reaching for a
  // database handle at import time would make health depend on a live database.
  return notExists(
    db
      .select({ one: sql`1` })
      .from(transcodeJob)
      .where(
        and(
          eq(transcodeJob.videoId, video.id),
          inArray(transcodeJob.state, ['queued', 'claimed', 'running', 'publishing']),
        ),
      ),
  )
}

export function createSweepAdapters(env: EnvLike = {}): SweepAdapters {
  return {
    async fetchStaleProcessing(before, limit) {
      const rows = await db
        .select()
        .from(video)
        .where(
          and(
            notDeleted,
            inArray(video.status, ['processing']),
            lt(ACTIVITY_EXPR, before),
            notOwnedByLocalQueue(),
          ),
        )
        .orderBy(asc(video.updatedAt))
        .limit(limit)
      return rows.map(toSweepable)
    },

    async fetchStaleUploading(before, limit) {
      const rows = await db
        .select()
        .from(video)
        .where(and(notDeleted, eq(video.status, 'uploading'), lt(video.updatedAt, before)))
        .orderBy(asc(video.updatedAt))
        .limit(limit)
      return rows.map(toSweepable)
    },

    async dispatchRetry(sweepable) {
      // A video with no raw object cannot be re-dispatched to Modal, and it is
      // not this sweeper's to reclaim: local imports are owned by the job queue
      // (see `notOwnedByLocalQueue`). Reaching here means the job row is gone —
      // a delete raced the sweep — so the honest outcome is to leave the row for
      // the next pass rather than fail it with a misleading code.
      if (!sweepable.rawKey) {
        throw new Error('processing job has no rawKey to re-dispatch')
      }

      // Reclaim only the attempt this sweep actually observed. If a newer
      // attempt has taken ownership since the rows were read, the claim is
      // refused and nothing is dispatched — see transcodeClaim.ts.
      const result = await dispatchTranscodeJob({
        videoId: sweepable.id,
        rawKey: sweepable.rawKey,
        organizationId: sweepable.organizationId,
        playbackPolicy: sweepable.playbackPolicy,
        generateSubtitle: sweepable.generateSubtitle,
        generateChapters: sweepable.generateChapters,
        expectedAttemptId: sweepable.transcodeAttemptId,
        env,
      })

      if (!result.dispatched) {
        // A refused reclaim must not be counted as a retry: throwing here lets
        // runSweep leave the row for a later pass instead of claiming progress.
        throw new Error(`transcode reclaim refused: ${result.reason}`)
      }
    },

    async markFailed(videoId, failureCode) {
      await db
        .update(video)
        .set({
          status: 'failed',
          failureCode,
          lastHeartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(eq(video.id, videoId))
    },

    async markAbandoned(videoId) {
      await db
        .update(video)
        .set({
          status: 'failed',
          failureCode: 'UPLOAD_ABANDONED',
          updatedAt: new Date(),
        })
        .where(eq(video.id, videoId))
    },
  }
}
