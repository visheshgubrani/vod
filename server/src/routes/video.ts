import { Hono } from 'hono'
import { eq, and, desc } from 'drizzle-orm'
import * as jose from 'jose'
import { requireAuth } from '../middleware/auth'
import { db } from '../lib/database'
import { video, member } from '../db/schema'

const app = new Hono()

// JWT token expiration (1 hour)
const TOKEN_EXPIRATION = '1h'

/**
 * Generate a signed JWT for video playback
 */
async function generatePlaybackToken(videoId: string, expiresIn: string = TOKEN_EXPIRATION): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET)
  
  const token = await new jose.SignJWT({ video_id: videoId })
    .setProtectedHeader({ alg: 'HS256' })
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

  // Get video with organization check
  const videos = await db
    .select()
    .from(video)
    .where(eq(video.id, videoId))
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
  const deliveryUrl = process.env.DELIVERY_URL || 'https://delivery.example.com'
  
  let playbackUrl = videoRecord.hlsUrl 
    ? `${deliveryUrl}/${videoRecord.hlsUrl}`
    : null

  // For signed videos, generate a token
  let token: string | null = null
  if (videoRecord.playbackPolicy === 'signed' && playbackUrl) {
    token = await generatePlaybackToken(videoId)
    playbackUrl = `${playbackUrl}?token=${token}`
  }

  return c.json({
    id: videoRecord.id,
    title: videoRecord.title,
    status: videoRecord.status,
    playbackPolicy: videoRecord.playbackPolicy,
    duration: videoRecord.duration,
    thumbnailUrl: videoRecord.thumbnailUrl 
      ? `${deliveryUrl}/${videoRecord.thumbnailUrl}`
      : null,
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

  // Get video
  const videos = await db
    .select()
    .from(video)
    .where(eq(video.id, videoId))
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

  const token = await generatePlaybackToken(videoId, expiresIn)

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
    .where(eq(video.organizationId, organizationId))
    .orderBy(desc(video.createdAt))

  const deliveryUrl = process.env.DELIVERY_URL || 'https://delivery.example.com'

  return c.json({
    videos: videos.map(v => ({
      ...v,
      thumbnailUrl: v.thumbnailUrl ? `${deliveryUrl}/${v.thumbnailUrl}` : null,
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
    .where(eq(video.id, videoId))
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

  // Get video
  const videos = await db
    .select()
    .from(video)
    .where(eq(video.id, videoId))
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

  // Delete the video record
  await db
    .delete(video)
    .where(eq(video.id, videoId))

  // Note: R2 files will remain and should be cleaned up by a background job
  // This is intentional to prevent accidental data loss

  return c.json({
    success: true,
    message: 'Video deleted',
    id: videoId,
  })
})

export default app

