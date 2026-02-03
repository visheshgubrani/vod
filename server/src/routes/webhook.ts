import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { video } from '../db/schema'
import { dispatchWebhook } from '../utils/webhookDispatcher'

const app = new Hono()

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
  // 1) Webhook auth (MVP)
  const expected = process.env.MODAL_WEBHOOK_SECRET
  if (expected) {
    const got =
      c.req.header('x-webhook-secret') ||
      (c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '')
    if (!got || got !== expected) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  try {
    const payload = await c.req.json<any>()
    console.log('Transcode webhook received:', JSON.stringify(payload))

    const status = payload?.status
    if (status !== 'success' && status !== 'error') {
      return c.json({ error: 'Invalid status' }, 400)
    }

    const videoId = payload?.video_id || payload?.fileId
    if (!videoId || typeof videoId !== 'string') {
      return c.json({ error: 'Missing video_id or fileId' }, 400)
    }

    const rows = await db
      .select()
      .from(video)
      .where(eq(video.id, videoId))
      .limit(1)
    const videoRecord = rows[0]
    if (!videoRecord) {
      console.error(`Video not found: ${videoId}`)
      return c.json({ error: 'Video not found' }, 404)
    }

    // 2) Idempotency / state protection
    // If already ready, ignore any later callbacks (prevents out-of-order overwrite)
    if (videoRecord.status === 'ready') {
      return c.json({ success: true, status: 'ready', ignored: true })
    }

    const transcodedBucketUrl = process.env.DELIVERY_WORKER_URL || ''

    if (status === 'error') {
      const message =
        typeof payload?.message === 'string' ? payload.message : 'Unknown error'
      const prevMeta = safeJsonParse<Record<string, any>>(
        videoRecord.metadata,
        {},
      )

      await db
        .update(video)
        .set({
          status: 'failed',
          metadata: JSON.stringify({
            ...prevMeta,
            error: message,
            failed_at: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(eq(video.id, videoId))

      // Dispatch webhook event for failure
      dispatchWebhook(videoRecord.organizationId, 'video.failed', {
        videoId,
        title: videoRecord.title,
        error: message,
      })

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

    // Extract transcoded size for billing (in bytes)
    const transcodedSize =
      typeof processing?.transcoded_size === 'number'
        ? processing.transcoded_size
        : null

    // Extract transcoded time for analytics (in seconds)
    const transcodedTime =
      typeof processing?.transcode_time === 'number'
        ? Math.round(processing.transcode_time)
        : null

    await db
      .update(video)
      .set({
        status: 'ready',
        hlsUrl: master ? joinUrl(transcodedBucketUrl, master) : null,
        thumbnailUrl: thumb ? joinUrl(transcodedBucketUrl, thumb) : null,
        duration: duration != null ? Math.floor(duration) : null,
        resolutions: resolutions ? JSON.stringify(resolutions) : null,
        // Subtitle fields
        subtitleStatus: subtitleStatus,
        subtitleUrl: subtitleVtt
          ? joinUrl(transcodedBucketUrl, subtitleVtt)
          : null,
        // Chapters fields
        chaptersStatus: chaptersStatus,
        chapters: chaptersData,
        // Storage tracking for billing
        transcodedSize: transcodedSize,
        // Processing metrics
        transcodedTime: transcodedTime,
        metadata: JSON.stringify({
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
        }),
        updatedAt: new Date(),
      })
      .where(eq(video.id, videoId))

    // Dispatch webhook events
    const transcodedBucketUrlFinal = transcodedBucketUrl

    // video.ready event
    dispatchWebhook(videoRecord.organizationId, 'video.ready', {
      videoId,
      title: videoRecord.title,
      status: 'ready',
      duration,
      hlsUrl: master ? joinUrl(transcodedBucketUrlFinal, master) : null,
      thumbnailUrl: thumb ? joinUrl(transcodedBucketUrlFinal, thumb) : null,
    })

    // subtitle events
    if (subtitle?.requested) {
      if (subtitleStatus === 'completed') {
        dispatchWebhook(videoRecord.organizationId, 'subtitle.generated', {
          videoId,
          subtitleUrl: subtitleVtt
            ? joinUrl(transcodedBucketUrlFinal, subtitleVtt)
            : null,
        })
      } else if (subtitleStatus === 'failed') {
        dispatchWebhook(videoRecord.organizationId, 'subtitle.failed', {
          videoId,
        })
      }
    }

    // chapters events
    if (chapters?.requested) {
      if (chaptersStatus === 'completed') {
        dispatchWebhook(videoRecord.organizationId, 'chapters.generated', {
          videoId,
          chapters: chaptersData,
        })
      } else if (chaptersStatus === 'failed') {
        dispatchWebhook(videoRecord.organizationId, 'chapters.failed', {
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

export default app
