import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../lib/database'
import { video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { dispatchTranscodeJob } from './dispatchTranscode'
import type { SweepableVideo, SweepAdapters, SweepLimits } from './jobSweeper'
import type { Bindings } from '../types'

/**
 * Production sweep adapters — thin SQL/dispatch glue over the pure
 * jobSweeper core. Environment values come from the request/scheduled env
 * (c.env / bindings) so both Workers and tests can inject them.
 */

export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  processingStaleMs: 45 * 60_000,
  uploadingStaleMs: 24 * 60 * 60_000,
  maxJobAttempts: 3,
}

export function sweepLimitsFromEnv(env?: Bindings): SweepLimits {
  const readPositiveInt = (key: string, fallback: number): number => {
    const raw = env?.[key as keyof Bindings] as string | undefined
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

export function createSweepAdapters(env?: Bindings): SweepAdapters {
  return {
    async fetchStaleProcessing(before, limit) {
      const rows = await db
        .select()
        .from(video)
        .where(and(notDeleted, inArray(video.status, ['processing']), lt(ACTIVITY_EXPR, before)))
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
      // Reclaim only the attempt this sweep actually observed. If a newer
      // attempt has taken ownership since the rows were read, the claim is
      // refused and nothing is dispatched — see transcodeClaim.ts.
      const result = await dispatchTranscodeJob({
        videoId: sweepable.id,
        rawKey: sweepable.rawKey!,
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
