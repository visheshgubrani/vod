/**
 * Job sweeper — detects and plans recovery for videos stuck mid-pipeline.
 *
 * Deep module: `planSweep` is pure (clock + rows in, plan out); the runner
 * applies the plan with injected adapters (db queries/updates + dispatch),
 * which keeps every decision rule unit-testable at the seam.
 */

export type SweepableVideo = {
  id: string
  status: string
  updatedAt: Date | null
  processingStartedAt: Date | null
  lastHeartbeatAt: Date | null
  jobAttempts: number | null
  rawKey: string | null
  title: string
  organizationId: string
  playbackPolicy: 'public' | 'signed'
  generateSubtitle: boolean
  generateChapters: boolean
  /**
   * Attempt that currently owns the row. The sweeper must reclaim *this*
   * attempt; if a newer one has taken ownership since the row was read, the
   * reclaim is refused (see lib/transcodeClaim.ts).
   */
  transcodeAttemptId: string | null
}

export type SweepLimits = {
  /** A processing job with no activity for this long is stale. */
  processingStaleMs: number
  /** An uploading row untouched for this long is abandoned. */
  uploadingStaleMs: number
  /** Retry cap before a stale processing job is failed for good. */
  maxJobAttempts: number
}

export type SweepAction =
  | { video: SweepableVideo; action: 'retry'; reason: string }
  | { video: SweepableVideo; action: 'fail'; failureCode: string; reason: string }
  | { video: SweepableVideo; action: 'abortUpload'; reason: string }

function lastActivity(video: SweepableVideo): Date {
  const candidates = [video.updatedAt, video.processingStartedAt, video.lastHeartbeatAt].filter(
    (d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()),
  )
  if (candidates.length === 0) return new Date(0)
  return new Date(Math.max(...candidates.map((d) => d.getTime())))
}

/**
 * Decide what (if anything) the sweeper should do with each video.
 * Returns retry candidates oldest-first.
 */
export function planSweep(now: Date, videos: SweepableVideo[], limits: SweepLimits): SweepAction[] {
  const nowMs = now.getTime()
  const actions: SweepAction[] = []

  for (const video of videos) {
    const attempts = video.jobAttempts ?? 0

    if (video.status === 'uploading') {
      const activityMs = lastActivity(video).getTime()
      if (nowMs - activityMs >= limits.uploadingStaleMs) {
        actions.push({
          video,
          action: 'abortUpload',
          reason: `uploading row inactive for ${Math.round((nowMs - activityMs) / 60000)} minutes`,
        })
      }
      continue
    }

    if (video.status !== 'processing') continue

    const activityMs = lastActivity(video).getTime()
    const staleMs = nowMs - activityMs
    if (staleMs < limits.processingStaleMs) continue // heartbeat keeps it fresh

    if (!video.rawKey) {
      actions.push({
        video,
        action: 'fail',
        failureCode: 'RAW_KEY_MISSING',
        reason: 'processing job has no rawKey to re-dispatch',
      })
      continue
    }

    if (attempts >= limits.maxJobAttempts) {
      actions.push({
        video,
        action: 'fail',
        failureCode: 'JOB_TIMEOUT',
        reason: `no activity for ${Math.round(staleMs / 60000)} minutes after ${attempts} attempts`,
      })
      continue
    }

    actions.push({
      video,
      action: 'retry',
      reason: `processing job stale for ${Math.round(staleMs / 60000)} minutes (attempt ${attempts + 1}/${limits.maxJobAttempts})`,
    })
  }

  actions.sort((a, b) => lastActivity(a.video).getTime() - lastActivity(b.video).getTime())
  return actions
}

export type SweepStats = {
  retried: number
  failed: number
  aborted: number
}

/**
 * Adapters the runner needs. Production adapters live in the Worker entry /
 * scheduled handler; tests inject fakes.
 */
export interface SweepAdapters {
  fetchStaleProcessing: (before: Date, limit: number) => Promise<SweepableVideo[]>
  fetchStaleUploading: (before: Date, limit: number) => Promise<SweepableVideo[]>
  /**
   * Reclaim and re-dispatch the transcode job for a video.
   *
   * This owns recording the attempt: the reclaim is a compare-and-swap that
   * bumps `job_attempts` and sets the new owner, so the runner must NOT also
   * record it. Doing both would double-count attempts and halve the retry
   * budget. Throw to signal a refused reclaim; the runner then fails the row.
   */
  dispatchRetry: (video: SweepableVideo) => Promise<void>
  markFailed: (videoId: string, failureCode: string, reason?: string) => Promise<void>
  markAbandoned: (videoId: string) => Promise<void>
}

/**
 * Run one sweep pass: fetch stale rows, plan actions, apply them.
 * A failing action for one row never aborts the rest of the pass.
 */
export async function runSweep(
  now: Date,
  limits: SweepLimits,
  adapters: SweepAdapters,
  batchSize = 50,
): Promise<SweepStats> {
  const staleProcessing = await adapters.fetchStaleProcessing(
    new Date(now.getTime() - limits.processingStaleMs),
    batchSize,
  )
  const staleUploading = await adapters.fetchStaleUploading(
    new Date(now.getTime() - limits.uploadingStaleMs),
    batchSize,
  )
  const plan = planSweep(now, [...staleProcessing, ...staleUploading], limits)

  const stats: SweepStats = { retried: 0, failed: 0, aborted: 0 }

  for (const action of plan) {
    try {
      switch (action.action) {
        case 'retry': {
          // dispatchRetry reclaims the attempt, which records the attempt bump
          // itself. Nothing to record here afterwards.
          await adapters.dispatchRetry(action.video)
          stats.retried += 1
          break
        }
        case 'fail': {
          // Count the intent; a failing markFailed leaves the row for the
          // next pass and must not silently drop the row from stats.
          stats.failed += 1
          await adapters.markFailed(action.video.id, action.failureCode, action.reason)
          break
        }
        case 'abortUpload': {
          await adapters.markAbandoned(action.video.id)
          stats.aborted += 1
          break
        }
      }
    } catch (err) {
      // A failed retry dispatch must not leave the video stuck: fail it.
      if (action.action === 'retry') {
        try {
          await adapters.markFailed(action.video.id, 'DISPATCH_FAILED', String(err))
          stats.failed += 1
        } catch {
          // last resort: log via console; next sweep pass will retry the row.
          console.error(`[SWEEP] failed to mark ${action.video.id} failed:`, err)
        }
      } else {
        console.error(
          `[SWEEP] action ${action.action} for ${action.video.id} failed:`,
          err,
        )
      }
    }
  }

  return stats
}
