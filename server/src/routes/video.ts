import { Hono } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import * as jose from 'jose'
import { requireAuth } from '../middleware/auth'
import { db } from '../lib/database'
import { member, video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { deleteVideoWithCleanup } from '../lib/objectCleanup'
import { dispatchWebhook } from '../utils/webhookDispatcher'
import type { Bindings } from '../types'
import { dispatchTranscodeJob, dispatchFailureStatus } from '../utils/dispatchTranscode'
import {
  readDeliveryBaseUrl,
  requirePlaybackJwtSecret,
} from '../lib/config'
import {
  buildPlaybackBindingClaims,
  getUserAgentFromHeaders,
  normalizePlaybackUserAgent,
  type PlaybackBindingClaims,
} from '../utils/playbackBinding'

const app = new Hono<{ Bindings: Bindings }>()

// JWT token expiration (default)
const TOKEN_EXPIRATION = '4h'
const JWT_ISSUER = 'openvod'
const JWT_AUDIENCE = 'playback'
const DEFAULT_RESTRICTIONS = {
  allowed_domains: ['*'],
  allow_no_referrer: true,
}

type PlaybackRestrictionsClaims = {
  allowed_domains: string[]
  allow_no_referrer: boolean
}

function logPlaybackBindingDebug(
  context: string,
  videoId: string,
  organizationId: string,
  requestUserAgent: string | null,
  bindingClaims: PlaybackBindingClaims,
  restrictions: PlaybackRestrictionsClaims,
): void {
  console.log('[playback-ip-debug] mint-token: app route', {
    context,
    videoId,
    organizationId,
    requestUserAgent,
    normalizedRequestUserAgent: normalizePlaybackUserAgent(requestUserAgent),
    bindingClaims,
    restrictions,
  })
}

/**
 * Generate a signed JWT for video playback
 */
async function generatePlaybackToken(
  videoId: string,
  organizationId: string,
  expiresIn: string = TOKEN_EXPIRATION,
  bindingClaims: PlaybackBindingClaims,
  restrictions: PlaybackRestrictionsClaims = DEFAULT_RESTRICTIONS,
): Promise<string> {
  const secret = new TextEncoder().encode(requirePlaybackJwtSecret())
  const claims = {
    ...bindingClaims,
    ...restrictions,
  }
  
  const token = await new jose.SignJWT({
    video_id: videoId,
    org_id: organizationId,
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(videoId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
  
  return token
}

app.use('/*', requireAuth)

/**
 * GET /api/video/:id
 * Get video details including playback URL
 */
app.get('/:id', async (c) => {
  const session = c.var.session
  const videoId = c.req.param('id')
  const requestUserAgent = getUserAgentFromHeaders(c.req.raw.headers)
  const bindingClaims = buildPlaybackBindingClaims(requestUserAgent)
  const restrictions: PlaybackRestrictionsClaims = DEFAULT_RESTRICTIONS

  // Get video with organization check
  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId)))
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Verify user belongs to the organization that owns the video
  const members = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, videoRecord.organizationId)
      )
    )
    .limit(1)

  if (members.length === 0) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Build response
  // Never fabricate a placeholder host: relative URLs when unconfigured.
  const deliveryUrl = readDeliveryBaseUrl() ?? ''
  
  // Helper to resolve URLs - don't double-prefix if already absolute
  const resolveUrl = (url: string | null) => {
    if (!url) return null
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    return `${deliveryUrl}/${url}`
  }

  let playbackUrl = resolveUrl(videoRecord.hlsUrl)

  // For signed videos, generate a token
  let token: string | null = null
  if (videoRecord.playbackPolicy === 'signed' && playbackUrl) {
    logPlaybackBindingDebug(
      'GET /api/video/:id',
      videoId,
      videoRecord.organizationId,
      requestUserAgent,
      bindingClaims,
      restrictions,
    )

    token = await generatePlaybackToken(
      videoId,
      videoRecord.organizationId,
      TOKEN_EXPIRATION,
      bindingClaims,
      restrictions,
    )
    playbackUrl = `${playbackUrl}?token=${token}`
  }

  // For signed videos, append token to subtitle URL too (delivery worker requires it)
  let subtitleUrl = resolveUrl(videoRecord.subtitleUrl)
  if (videoRecord.playbackPolicy === 'signed' && subtitleUrl && token) {
    subtitleUrl = `${subtitleUrl}?token=${token}`
  }

  return c.json({
    id: videoRecord.id,
    title: videoRecord.title,
    status: videoRecord.status,
    playbackPolicy: videoRecord.playbackPolicy,
    duration: videoRecord.duration,
    thumbnailUrl: resolveUrl(videoRecord.thumbnailUrl),
    subtitleUrl,
    chapters: videoRecord.chapters, // AI-generated chapters array
    chaptersStatus: videoRecord.chaptersStatus,
    playbackUrl,
    token, // Include token separately for clients that need it
    createdAt: videoRecord.createdAt,
  })
})

/**
 * GET /api/video/:id/token
 * Generate a fresh playback token (for token refresh)
 */
app.get('/:id/token', async (c) => {
  const session = c.var.session
  const videoId = c.req.param('id')
  const expiresIn = c.req.query('expires') || TOKEN_EXPIRATION
  const requestUserAgent = getUserAgentFromHeaders(c.req.raw.headers)
  const bindingClaims = buildPlaybackBindingClaims(requestUserAgent)
  const restrictions: PlaybackRestrictionsClaims = DEFAULT_RESTRICTIONS

  // Get video
  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId)))
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Verify organization membership
  const members = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, videoRecord.organizationId)
      )
    )
    .limit(1)

  if (members.length === 0) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Only generate tokens for signed videos
  if (videoRecord.playbackPolicy !== 'signed') {
    return c.json({ error: 'Video does not require signed access' }, 400)
  }

  logPlaybackBindingDebug(
    'GET /api/video/:id/token',
    videoId,
    videoRecord.organizationId,
    requestUserAgent,
    bindingClaims,
    restrictions,
  )

  const token = await generatePlaybackToken(
    videoId,
    videoRecord.organizationId,
    expiresIn,
    bindingClaims,
    restrictions,
  )

  return c.json({
    token,
    expiresIn,
    videoId,
  })
})

/**
 * GET /api/video
 * List videos for current organization
 */
app.get('/', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const videos = await db
    .select({
      id: video.id,
      title: video.title,
      status: video.status,
      playbackPolicy: video.playbackPolicy,
      duration: video.duration,
      thumbnailUrl: video.thumbnailUrl,
      createdAt: video.createdAt,
    })
    .from(video)
    .where(and(notDeleted, eq(video.organizationId, organizationId)))
    .orderBy(desc(video.createdAt))

  // Never fabricate a placeholder host: relative URLs when unconfigured.
  const deliveryUrl = readDeliveryBaseUrl() ?? ''

  // Helper to resolve URLs - don't double-prefix if already absolute
  const resolveUrl = (url: string | null) => {
    if (!url) return null
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    return `${deliveryUrl}/${url}`
  }

  return c.json({
    videos: videos.map(v => ({
      ...v,
      thumbnailUrl: resolveUrl(v.thumbnailUrl),
    })),
  })
})

/**
 * PATCH /api/video/:id
 * Update video details (title, playbackPolicy)
 */
app.patch('/:id', async (c) => {
  const session = c.var.session
  const videoId = c.req.param('id')

  // Get video
  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId)))
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Verify organization membership
  const members = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, videoRecord.organizationId)
      )
    )
    .limit(1)

  if (members.length === 0) {
    return c.json({ error: 'Access denied' }, 403)
  }

  const body = await c.req.json()
  
  // Build update object
  const updates: { title?: string; playbackPolicy?: 'public' | 'signed' } = {}
  
  if (body.title?.trim()) {
    updates.title = body.title.trim()
  }
  
  if (body.playbackPolicy === 'public' || body.playbackPolicy === 'signed') {
    updates.playbackPolicy = body.playbackPolicy
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  await db
    .update(video)
    .set(updates)
    .where(eq(video.id, videoId))

  // Dispatch webhook event
  dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'video.updated', {
    videoId,
    title: updates.title || videoRecord.title,
    playbackPolicy: updates.playbackPolicy || videoRecord.playbackPolicy,
    changes: updates,
  })

  return c.json({
    success: true,
    id: videoId,
    ...updates,
  })
})

/**
 * DELETE /api/video/:id
 * Delete a video (soft delete - marks as deleted, cleanup can be handled separately)
 */
app.delete('/:id', async (c) => {
  const session = c.var.session
  const videoId = c.req.param('id')

  // soft-delete-exempt: repeat delete must find the already-deleted row to
  // verify ownership and answer idempotently.
  // Deliberately unfiltered: a repeat delete of an already soft-deleted video
  // must still find the row to verify ownership and answer idempotently, rather
  // than 404 on a video the caller genuinely owns.
  const videos = await db
    .select()
    .from(video)
    .where(eq(video.id, videoId))
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord || videoRecord.deletedAt) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Verify organization membership
  const members = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, videoRecord.organizationId)
      )
    )
    .limit(1)

  if (members.length === 0) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Soft-delete and enqueue byte reclamation in one statement, so the row can
  // never be marked deleted without the cleanup debt being recorded. Bytes are
  // reclaimed asynchronously once outstanding writers have retired — a logged
  // deletion is not the same thing as storage freed.
  await deleteVideoWithCleanup({
    executor: db,
    videoId,
    organizationId: videoRecord.organizationId,
    deletedBy: session.userId,
  })

  // Dispatch webhook event
  dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'video.deleted', {
    videoId,
    title: videoRecord.title,
  })

  return c.json({
    success: true,
    message: 'Video deleted',
    id: videoId,
  })
})

/**
 * POST /api/video/:id/transcribe
 * Trigger subtitle/caption generation for a video
 */
app.post('/:id/transcribe', async (c) => {
  const session = c.var.session
  const videoId = c.req.param('id')

  // Get video
  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId)))
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Verify organization membership
  const members = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, videoRecord.organizationId)
      )
    )
    .limit(1)

  if (members.length === 0) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Video must be ready to transcribe
  if (videoRecord.status !== 'ready') {
    return c.json({ error: 'Video must be fully processed before transcription' }, 400)
  }

  // Check if already transcribed or in progress
  if (videoRecord.subtitleStatus === 'processing') {
    return c.json({ error: 'Transcription already in progress' }, 400)
  }

  if (videoRecord.subtitleStatus === 'completed' && videoRecord.subtitleUrl) {
    return c.json({ 
      message: 'Video already has subtitles',
      subtitleUrl: videoRecord.subtitleUrl,
    })
  }

  // Update subtitle status to pending
  await db
    .update(video)
    .set({
      generateSubtitle: true,
      subtitleStatus: 'pending',
    })
    .where(eq(video.id, videoId))

  // TODO: Trigger actual transcription job here
  // For now, just mark as pending - transcription worker will pick it up

  return c.json({
    success: true,
    message: 'Transcription queued',
    videoId,
    subtitleStatus: 'pending',
  })
})

/**
 * POST /api/video/:id/retry
 * Re-dispatch transcoding for a failed (or stuck/stale processing) video.
 * Explicit retry is the only path that moves a video out of 'failed' —
 * the state machine forbids late callbacks from resurrecting it.
 */
app.post('/:id/retry', async (c) => {
  const session = c.var.session
  const videoId = c.req.param('id')

  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId)))
    .limit(1)
  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  const members = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, videoRecord.organizationId),
      ),
    )
    .limit(1)
  if (members.length === 0) {
    return c.json({ error: 'Access denied' }, 403)
  }

  if (videoRecord.status !== 'failed' && videoRecord.status !== 'processing') {
    return c.json(
      { error: `Only failed or stuck processing videos can be retried (current: ${videoRecord.status})` },
      400,
    )
  }
  if (!videoRecord.rawKey) {
    return c.json({ error: 'Video has no raw source object to re-transcode' }, 400)
  }

  // Retry goes through the claim, which owns the state transition, the attempt
  // id and the job_attempts bump. A stuck `processing` row is reclaimed by
  // naming the attempt we observed; if that attempt's lease is still live the
  // claim is refused, because dispatching would start a second GPU run for a
  // job that is still running.
  const dispatchResult = await dispatchTranscodeJob({
    videoId,
    rawKey: videoRecord.rawKey,
    organizationId: videoRecord.organizationId,
    playbackPolicy: videoRecord.playbackPolicy || 'public',
    generateSubtitle: videoRecord.generateSubtitle || false,
    generateChapters: videoRecord.generateChapters || false,
    expectedAttemptId:
      videoRecord.status === 'processing' ? videoRecord.transcodeAttemptId : null,
    env: c.env,
  })

  if (!dispatchResult.dispatched) {
    if (dispatchResult.reason === 'dispatch-failed') {
      console.error(`[RETRY] dispatch failed for ${videoId}:`, dispatchResult.error)
      await db
        .update(video)
        .set({ failureCode: 'DISPATCH_FAILED', updatedAt: new Date() })
        .where(eq(video.id, videoId))
      return c.json(
        {
          error: `Retry dispatch failed: ${dispatchResult.error?.message ?? 'unknown error'}`,
        },
        502,
      )
    }

    const status = dispatchFailureStatus(dispatchResult.reason)
    return c.json(
      { error: `Retry not started: ${dispatchResult.reason}`, reason: dispatchResult.reason },
      status,
    )
  }

  const updated = await db
    .update(video)
    .set({ failureCode: null, updatedAt: new Date() })
    .where(eq(video.id, videoId))
    .returning({ id: video.id, jobAttempts: video.jobAttempts })

  if (updated.length === 0) {
    return c.json({ error: 'Video changed state concurrently; retry again' }, 409)
  }

  dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'video.processing', {
    videoId,
    title: videoRecord.title,
    retried: true,
    attempts: updated[0].jobAttempts,
  })

  return c.json({
    success: true,
    status: 'processing',
    videoId,
    attempts: updated[0].jobAttempts,
  })
})

export default app
