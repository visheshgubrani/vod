import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { video } from '../db/schema'

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

    const transcodedBucketUrl = process.env.TRANSCODED_BUCKET_URL || ''

    if (status === 'error') {
      const message =
        typeof payload?.message === 'string' ? payload.message : 'Unknown error'
      const prevMeta = safeJsonParse<Record<string, any>>(
        videoRecord.metadata,
        {}
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

      return c.json({ success: true, status: 'failed', videoId })
    }

    // success - new payload structure from Modal
    // payload.outputs: { hls_playlist, dash_manifest, poster, renditions }
    // payload.metadata: { width, height, duration, fps, has_audio, is_hdr, is_vertical, aspect_ratio }
    // payload.processing: { total_time, transcode_time, etc. }
    
    const outputs = payload?.outputs || {}
    const meta = payload?.metadata || {}
    const processing = payload?.processing || {}
    
    const master = typeof outputs?.hls_playlist === 'string' ? outputs.hls_playlist : null
    const thumb = typeof outputs?.poster === 'string' ? outputs.poster : null
    const duration = typeof meta?.duration === 'number' && meta.duration >= 0 ? meta.duration : null
    const resolutions = Array.isArray(outputs?.renditions)
      ? outputs.renditions.filter((x: any) => typeof x === 'string')
      : null

    const prevMeta = safeJsonParse<Record<string, any>>(
      videoRecord.metadata,
      {}
    )

    await db
      .update(video)
      .set({
        status: 'ready',
        hlsUrl: master ? joinUrl(transcodedBucketUrl, master) : null,
        thumbnailUrl: thumb ? joinUrl(transcodedBucketUrl, thumb) : null,
        duration: duration != null ? Math.floor(duration) : null,
        resolutions: resolutions ? JSON.stringify(resolutions) : null,
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
          // Outputs
          dash_manifest: outputs?.dash_manifest,
          playback_policy: payload?.playback_policy,
          encrypted: payload?.encrypted,
          transcoded_at: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(eq(video.id, videoId))

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
      500
    )
  }
})

export default app
