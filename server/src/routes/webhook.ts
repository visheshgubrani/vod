import { Hono, type Context } from 'hono'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../lib/database'
import { decideCallbackTransition, type VideoStatus } from '../lib/videoState'
import {
  decideAttemptOwnership,
  DEFAULT_TRANSCODE_LEASE_MS,
} from '../lib/transcodeClaim'
import { video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { dispatchWebhook, secretsMatch } from '../utils/webhookDispatcher'
import { writeLifecycleEvent } from '../lib/lifecycleOutbox'
import { drainOutbox } from '../lib/webhookDelivery'
import type { Bindings } from '../types'

/**
 * Run a task after the response without losing it, tolerating a runtime with no
 * ExecutionContext (the Node entry). A failure is logged, never propagated:
 * these tasks are best-effort by design, and the sweeper is the safety net.
 */
function runAfterResponse(
  executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  task: Promise<unknown>,
): void {
  const guarded = task.catch((err) => {
    console.error('[WEBHOOK] background task failed:', err)
  })
  if (executionCtx) {
    executionCtx.waitUntil(guarded)
    return
  }
  void guarded
}

const app = new Hono<{ Bindings: Bindings }>()

function joinUrl(base: string, path: string) {
  const b = (base || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\/+/, '')
  if (!b) return p // allow relative paths if no base
  return `${b}/${p}`
}

function safeJsonParse<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

app.post('/transcode-complete', async (c) => {
  console.log('[WEBHOOK] Received /api/webhook/transcode-complete callback request')
  
  // 1) Webhook auth — REQUIRED (fail-closed): an unconfigured secret is a
  // server misconfiguration, never a reason to accept unsigned callbacks.
  const authError = authenticateWebhook(c)
  if (authError) return authError

  try {
    const payload = await c.req.json<any>()
    console.log('[WEBHOOK PAYLOAD]', JSON.stringify({ status: payload?.status, video_id: payload?.video_id || payload?.fileId }))

    const status = payload?.status
    if (status !== 'success' && status !== 'error') {
      console.error(`[WEBHOOK ERROR] Invalid status received: ${status}`)
      return c.json({ error: 'Invalid status' }, 400)
    }

    const videoId = payload?.video_id || payload?.fileId
    if (!videoId || typeof videoId !== 'string') {
      console.error('[WEBHOOK ERROR] Missing video_id or fileId in payload')
      return c.json({ error: 'Missing video_id or fileId' }, 400)
    }

    console.log(`[WEBHOOK DB QUERY] Querying database for video ID: ${videoId}`)
    const rows = await db
      .select()
      .from(video)
      .where(and(notDeleted, eq(video.id, videoId)))
      .limit(1)
    const videoRecord = rows[0]
    if (!videoRecord) {
      console.error(`[WEBHOOK 404 ERROR] Video not found in database for ID: ${videoId}`)
      return c.json({ error: `Video not found: ${videoId}` }, 404)
    }
    console.log(`[WEBHOOK DB MATCH] Found video record: ${videoRecord.id}, current status: ${videoRecord.status}`)

    // 2) State-machine guard: late/duplicate/out-of-order callbacks must never
    // corrupt status — no resurrecting failed videos, no downgrading ready ones.
    const decision = decideCallbackTransition(
      videoRecord.status as VideoStatus,
      status === 'success' ? 'success' : 'error',
    )
    if (!decision.apply) {
      console.log(`[WEBHOOK GUARD] ${decision.reason}`)
      return c.json({ success: true, status: videoRecord.status, ignored: true })
    }

    // 3) Ownership guard: a status-only check cannot tell attempt A's callback
    // from attempt B's, and the row really is `processing` either way. An
    // attempt that has been superseded must not write its outputs.
    const reportedAttemptId = payload?.attempt_id ?? payload?.attemptId
    const ownership = decideAttemptOwnership(
      videoRecord.transcodeAttemptId,
      reportedAttemptId,
    )
    if (!ownership.apply) {
      console.log(`[WEBHOOK GUARD] ${ownership.reason}`)
      return c.json({ success: true, status: videoRecord.status, ignored: true })
    }

    // Re-asserted in the mutation below so a claim that lands between this read
    // and the write still wins.
    const ownerPredicate = videoRecord.transcodeAttemptId
      ? eq(video.transcodeAttemptId, videoRecord.transcodeAttemptId)
      : isNull(video.transcodeAttemptId)

    const transcodedBucketUrl = process.env.DELIVERY_WORKER_URL || ''

    if (status === 'error') {
      const message =
        typeof payload?.message === 'string' ? payload.message : 'Unknown error'
      const prevMeta = safeJsonParse<Record<string, any>>(
        videoRecord.metadata,
        {},
      )

      // Same outbox guarantee as the success path: the terminal state and its
      // event are one write, so a crash cannot strand a `failed` video whose
      // tenant is never told.
      const failed = await writeLifecycleEvent(db, {
        videoId,
        assignments: [
          sql`status = 'failed'`,
          sql`metadata = ${JSON.stringify({
            ...prevMeta,
            error: message,
            failed_at: new Date().toISOString(),
          })}`,
          // Ownership ends: the attempt is finished, successfully or not.
          sql`transcode_attempt_id = NULL`,
          sql`transcode_lease_expires_at = NULL`,
          sql`updated_at = now()`,
        ],
        guards: [sql`status IN ('uploading', 'processing')`, ownerPredicate],
        event: {
          organizationId: videoRecord.organizationId,
          event: 'video.failed',
          payload: { videoId, title: videoRecord.title, error: message },
        },
      })

      if (!failed.applied) {
        return c.json({ success: true, status: 'failed', ignored: true })
      }

      runAfterResponse(c.executionCtx, drainOutbox({ eventIds: [failed.eventId] }))

      return c.json({ success: true, status: 'failed', videoId })
    }

    // success - new payload structure from Modal
    // payload.outputs: { hls_playlist, dash_manifest, poster, subtitles, renditions }
    // payload.metadata: { width, height, duration, fps, has_audio, is_hdr, is_vertical, aspect_ratio }
    // payload.processing: { total_time, transcode_time, etc. }
    // payload.subtitle: { requested, generated, status, url }

    const outputs = payload?.outputs || {}
    const meta = payload?.metadata || {}
    const processing = payload?.processing || {}
    const subtitle = payload?.subtitle || {}
    const chapters = payload?.chapters || {}

    const master =
      typeof outputs?.hls_playlist === 'string' ? outputs.hls_playlist : null
    const thumb = typeof outputs?.poster === 'string' ? outputs.poster : null
    const subtitleVtt =
      typeof outputs?.subtitles === 'string' ? outputs.subtitles : null
    const duration =
      typeof meta?.duration === 'number' && meta.duration >= 0
        ? meta.duration
        : null
    const resolutions = Array.isArray(outputs?.renditions)
      ? outputs.renditions.filter((x: any) => typeof x === 'string')
      : null

    const prevMeta = safeJsonParse<Record<string, any>>(
      videoRecord.metadata,
      {},
    )

    // Determine subtitle status from webhook
    let subtitleStatus: string | null = null
    if (subtitle?.requested) {
      subtitleStatus =
        subtitle?.status || (subtitle?.generated ? 'completed' : 'failed')
    }

    // Determine chapters status and data from webhook
    let chaptersStatus: string | null = null
    let chaptersData: Array<{
      startTime: number
      endTime: number
      title: string
    }> | null = null
    if (chapters?.requested) {
      chaptersStatus =
        chapters?.status || (chapters?.generated ? 'completed' : 'failed')
      if (chapters?.generated && Array.isArray(chapters?.data)) {
        chaptersData = chapters.data
      }
    }

    // Extract transcoded size for usage metering (in bytes)
    const transcodedSize =
      typeof processing?.transcoded_size === 'number'
        ? processing.transcoded_size
        : null

    // Extract transcoded time for analytics (in seconds)
    const transcodedTime =
      typeof processing?.transcode_time === 'number'
        ? Math.round(processing.transcode_time)
        : null

    // The state change and its `video.ready` event are written together, so a
    // crash here cannot leave the video playable with no event ever emitted.
    // Previously the update and the dispatch were separate: dying in between
    // lost `video.ready` permanently, because the transcoder's callback retry
    // then found the row already `ready` and was ignored by the state guard.
    const nextMetadata = JSON.stringify({
      ...prevMeta,
      // Video info
      width: meta?.width,
      height: meta?.height,
      fps: meta?.fps,
      has_audio: meta?.has_audio,
      is_hdr: meta?.is_hdr,
      is_vertical: meta?.is_vertical,
      aspect_ratio: meta?.aspect_ratio,
      duration_exact: duration,
      // Processing stats
      processing_time: processing?.total_time,
      transcode_time: processing?.transcode_time,
      processing_speed: processing?.processing_speed,
      files_uploaded: processing?.files_uploaded,
      source_size_mb: processing?.source_size_mb,
      transcoded_size_mb: processing?.transcoded_size_mb,
      // Outputs
      dash_manifest: outputs?.dash_manifest,
      playback_policy: payload?.playback_policy,
      encrypted: payload?.encrypted,
      // Subtitle info
      subtitle_requested: subtitle?.requested,
      subtitle_generated: subtitle?.generated,
      // Chapters info
      chapters_requested: chapters?.requested,
      chapters_generated: chapters?.generated,
      transcoded_at: new Date().toISOString(),
    })

    const resolvedHlsUrl = master ? joinUrl(transcodedBucketUrl, master) : null
    const resolvedThumbUrl = thumb ? joinUrl(transcodedBucketUrl, thumb) : null

    const lifecycle = await writeLifecycleEvent(db, {
      videoId,
      assignments: [
        sql`status = 'ready'`,
        sql`hls_url = ${resolvedHlsUrl}`,
        sql`thumbnail_url = ${resolvedThumbUrl}`,
        sql`duration = ${duration != null ? Math.floor(duration) : null}`,
        sql`resolutions = ${resolutions ? JSON.stringify(resolutions) : null}`,
        sql`subtitle_status = ${subtitleStatus}`,
        sql`subtitle_url = ${
          subtitleVtt ? joinUrl(transcodedBucketUrl, subtitleVtt) : null
        }`,
        sql`chapters_status = ${chaptersStatus}`,
        sql`chapters = ${chaptersData ? JSON.stringify(chaptersData) : null}::jsonb`,
        sql`transcoded_size = ${transcodedSize}`,
        sql`transcoded_time = ${transcodedTime}`,
        sql`metadata = ${nextMetadata}`,
        // Ownership ends here: the attempt is complete.
        sql`transcode_attempt_id = NULL`,
        sql`transcode_lease_expires_at = NULL`,
        sql`failure_code = NULL`,
        sql`updated_at = now()`,
      ],
      guards: [
        sql`status IN ('uploading', 'processing')`,
        ownerPredicate,
      ],
      event: {
        organizationId: videoRecord.organizationId,
        event: 'video.ready',
        payload: {
          videoId,
          title: videoRecord.title,
          status: 'ready',
          duration,
          hlsUrl: resolvedHlsUrl,
          thumbnailUrl: resolvedThumbUrl,
        },
      },
    })

    if (!lifecycle.applied) {
      // A concurrent callback (or a newer attempt's claim) won the race. No
      // state changed, so no event was recorded either — nothing to dispatch.
      return c.json({ success: true, status: 'ready', ignored: true })
    }

    // Dispatch webhook events
    const transcodedBucketUrlFinal = transcodedBucketUrl

    // `video.ready` was already recorded by the atomic write above and is
    // claimed by this drain. Everything else below still dispatches directly.
    // The drain is fire-and-forget: if the process dies before it runs, the
    // sweeper picks the event up, so the event is late rather than lost.
    runAfterResponse(
      c.executionCtx,
      drainOutbox({ eventIds: [lifecycle.eventId] }),
    )

    // subtitle events
    if (subtitle?.requested) {
      if (subtitleStatus === 'completed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'subtitle.generated', {
          videoId,
          subtitleUrl: subtitleVtt
            ? joinUrl(transcodedBucketUrlFinal, subtitleVtt)
            : null,
        })
      } else if (subtitleStatus === 'failed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'subtitle.failed', {
          videoId,
        })
      }
    }

    // chapters events
    if (chapters?.requested) {
      if (chaptersStatus === 'completed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'chapters.generated', {
          videoId,
          chapters: chaptersData,
        })
      } else if (chaptersStatus === 'failed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'chapters.failed', {
          videoId,
        })
      }
    }

    return c.json({
      success: true,
      status: 'ready',
      videoId,
      hlsUrl: master ? joinUrl(transcodedBucketUrl, master) : null,
      thumbnailUrl: thumb ? joinUrl(transcodedBucketUrl, thumb) : null,
    })
  } catch (error) {
    console.error('Webhook error:', error)
    return c.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      500,
    )
  }
})
function authenticateWebhook(c: Context<{ Bindings: Bindings }>): Response | null {
  const expected =
    c.env?.MODAL_WEBHOOK_SECRET ||
    (typeof process !== 'undefined' ? process.env?.MODAL_WEBHOOK_SECRET : undefined) ||
    c.env?.TRANSCODE_INGEST_SECRET ||
    (typeof process !== 'undefined' ? process.env?.TRANSCODE_INGEST_SECRET : undefined)
  if (!expected) {
    return c.json({ error: 'Webhook secret not configured on server' }, 503)
  }
  const got =
    c.req.header('x-webhook-secret') ||
    (c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '')
  if (!got || !secretsMatch(got, expected)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

/**
 * POST /api/webhook/heartbeat
 * Transcoder liveness beats during long jobs. Non-fatal for the transcoder:
 * the worker swallows heartbeat failures; the server sweep uses these to keep
 * jobs alive past the stale window.
 */
app.post('/heartbeat', async (c) => {
  const authError = authenticateWebhook(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid payload' }, 400)

  const videoId = body?.video_id || body?.fileId || body?.videoId
  if (!videoId || typeof videoId !== 'string') {
    return c.json({ error: 'Missing video_id' }, 400)
  }

  const rows = await db
    .select({
      transcodeAttemptId: video.transcodeAttemptId,
    })
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId), isNull(video.deletedAt)))
    .limit(1)

  const record = rows[0]
  if (!record) {
    // Unknown or deleted video — acknowledge so the transcoder never treats a
    // heartbeat rejection as fatal.
    return c.json({ success: true, ignored: true })
  }

  // A heartbeat must name its attempt. An anonymous beat from a superseded
  // attempt would otherwise keep a dead job's lease alive and block recovery.
  const ownership = decideAttemptOwnership(
    record.transcodeAttemptId,
    body?.attempt_id ?? body?.attemptId,
  )
  if (!ownership.apply) {
    console.log(`[HEARTBEAT GUARD] ${ownership.reason}`)
    return c.json({ success: true, ignored: true })
  }

  // Extending the lease is the point of a beat: without it a long job would
  // lose its lease mid-encode and become reclaimable — exactly the duplicate
  // GPU run this mechanism exists to prevent.
  const updated = await db
    .update(video)
    .set({
      lastHeartbeatAt: new Date(),
      transcodeLeaseExpiresAt: new Date(Date.now() + DEFAULT_TRANSCODE_LEASE_MS),
    })
    .where(
      and(
        eq(video.id, videoId),
        inArray(video.status, ['processing', 'uploading']),
        isNull(video.deletedAt),
        record.transcodeAttemptId
          ? eq(video.transcodeAttemptId, record.transcodeAttemptId)
          : isNull(video.transcodeAttemptId),
      ),
    )
    .returning({ id: video.id })

  if (updated.length === 0) {
    // Terminal video — nothing to keep alive. Acknowledge so the transcoder
    // never treats a heartbeat rejection as fatal.
    return c.json({ success: true, ignored: true })
  }
  return c.json({ success: true })
})

export default app
