import { Hono, type Context } from 'hono'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../lib/database'
import { decideCallbackTransition, type VideoStatus } from '../lib/videoState'
import {
  decideAttemptOwnership,
  decideHeartbeatThrottle,
  DEFAULT_TRANSCODE_LEASE_MS,
} from '../lib/transcodeClaim'
import { video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { dispatchWebhook, secretsMatch } from '../utils/webhookDispatcher'
import {
  finalizeVideoFailure,
  finalizeVideoSuccess,
  joinUrl,
  safeJsonParse,
} from '../lib/lifecycleFinalize'
import { drainOutbox } from '../lib/webhookDelivery'
import type { Bindings } from '../types'
import type { WaitUntilLike } from '../runtime/types'

/**
 * Run a task after the response without losing it. A failure is logged, never
 * propagated: these tasks are best-effort by design, and the sweeper is the
 * safety net.
 */
function runAfterResponse(
  executionCtx: WaitUntilLike | undefined,
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

    // The delivery base URL, from the same single source every other route uses.
    // This used to read only DELIVERY_WORKER_URL from process.env and never the
    // documented DELIVERY_URL, so an installation that set DELIVERY_URL got a
    // relative playback URL here while /api/video returned an absolute one.
    const transcodedBucketUrl = c.var.runtime.config.deliveryUrl ?? ''

    const prevMeta = safeJsonParse<Record<string, any>>(videoRecord.metadata, {})

    if (status === 'error') {
      const message =
        typeof payload?.message === 'string' ? payload.message : 'Unknown error'

      // Same outbox guarantee as the success path: the terminal state and its
      // event are one write, so a crash cannot strand a `failed` video whose
      // tenant is never told. Shared with the local worker path so both
      // providers produce identical rows and events.
      const failed = await finalizeVideoFailure(db, {
        videoId,
        organizationId: videoRecord.organizationId,
        title: videoRecord.title,
        attemptId: videoRecord.transcodeAttemptId,
        message,
        failureCode: typeof payload?.error_code === 'string' ? payload.error_code : null,
        prevMetadata: prevMeta,
      })

      if (!failed.applied) {
        return c.json({ success: true, status: 'failed', ignored: true })
      }

      runAfterResponse(c.executionCtx, drainOutbox({ eventIds: [failed.eventId] }))

      return c.json({ success: true, status: 'failed', videoId })
    }

    // success - payload structure from Modal (and, unchanged, from an agent)
    // payload.outputs: { hls_playlist, dash_manifest, poster, subtitles, renditions }
    // payload.metadata: { width, height, duration, fps, has_audio, is_hdr, ... }
    // payload.processing: { total_time, transcode_time, ... }
    // payload.subtitle / payload.chapters: { requested, generated, status, url }
    //
    // `outputPrefix` is null here on purpose: the Modal worker writes to the
    // legacy `videos/<id>/` layout, so its artifact paths are already complete
    // keys. A local worker passes its attempt prefix instead, and the same
    // code re-bases its relative paths onto it.
    const lifecycle = await finalizeVideoSuccess(db, {
      videoId,
      organizationId: videoRecord.organizationId,
      title: videoRecord.title,
      attemptId: videoRecord.transcodeAttemptId,
      payload: payload as Record<string, unknown>,
      outputPrefix: null,
      deliveryBaseUrl: transcodedBucketUrl,
      prevMetadata: prevMeta,
    })

    if (!lifecycle.applied) {
      // A concurrent callback (or a newer attempt's claim) won the race. No
      // state changed, so no event was recorded either — nothing to dispatch.
      return c.json({ success: true, status: 'ready', ignored: true })
    }

    // `video.ready` was already recorded by the atomic write above and is
    // claimed by this drain. Everything else below still dispatches directly.
    // The drain is fire-and-forget: if the process dies before it runs, the
    // sweeper picks the event up, so the event is late rather than lost.
    runAfterResponse(
      c.executionCtx,
      drainOutbox({ eventIds: [lifecycle.eventId] }),
    )

    const subtitle = (payload?.subtitle ?? {}) as Record<string, unknown>
    const chapters = (payload?.chapters ?? {}) as Record<string, unknown>

    // subtitle events
    if (subtitle.requested) {
      if (lifecycle.subtitleStatus === 'completed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'subtitle.generated', {
          videoId,
          subtitleUrl: lifecycle.subtitleUrl,
        })
      } else if (lifecycle.subtitleStatus === 'failed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'subtitle.failed', {
          videoId,
        })
      }
    }

    // chapters events
    if (chapters.requested) {
      if (lifecycle.chaptersStatus === 'completed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'chapters.generated', {
          videoId,
          chapters: lifecycle.chapters,
        })
      } else if (lifecycle.chaptersStatus === 'failed') {
        dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'chapters.failed', {
          videoId,
        })
      }
    }

    return c.json({
      success: true,
      status: 'ready',
      videoId,
      hlsUrl: lifecycle.hlsUrl,
      thumbnailUrl: lifecycle.thumbnailUrl,
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
  // One precedence, shared with the outbound dispatch in utils/queue.ts:
  // TRANSCODE_INGEST_SECRET wins, MODAL_WEBHOOK_SECRET is the documented alias.
  // Previously this verifier preferred the alias while dispatch signed with the
  // primary name, so a deployment that set both to different values rejected
  // every callback with a 401.
  const expected = c.var.runtime.config.ingestSecret
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
      lastHeartbeatAt: video.lastHeartbeatAt,
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
  // GPU run this mechanism exists to prevent. What the lease does *not* need is
  // a write per beat: the transcoder reports progress once a second per encoder,
  // so a beat that lands inside the coalescing window would only move
  // `last_heartbeat_at` forward by less than a second against a 20-minute lease.
  //
  // The ownership check above runs first, so a superseded attempt still answers
  // `ignored` rather than being coalesced into a success. This is the one place
  // the answer can differ from the pre-coalescing route: a beat against a
  // *terminal* row whose last beat is still recent answers `throttled` instead of
  // `ignored`. The row is not written either way, and the transcoder treats any
  // 2xx the same — which is why the terminal case is pinned by a test rather than
  // left to chance.
  //
  // What this delays: `last_heartbeat_at` can now be up to
  // HEARTBEAT_WRITE_MIN_INTERVAL_MS stale, and `planSweep` reads exactly that
  // column. At 10s against a 45-minute staleness window that is not measurable.
  const throttle = decideHeartbeatThrottle(record.lastHeartbeatAt, Date.now())
  if (throttle.skip) {
    return c.json({ success: true, throttled: true })
  }

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
