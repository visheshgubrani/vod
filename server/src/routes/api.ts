/**
 * Public API Routes
 * 
 * These routes are for your B2B customers (external developers) to integrate
 * with your video platform. They authenticate using API keys, not sessions.
 * 
 * Base path: /v1
 */

import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import * as jose from 'jose'
import { requireApiKey } from '../middleware/apiKey'
import { db } from '../lib/database'
import { video } from '../db/schema'
import type { ApiKeyVariables } from '../types'

const app = new Hono<{ Variables: ApiKeyVariables }>()

// JWT token expiration (customizable per request)
const DEFAULT_EXPIRATION = '1h'

/**
 * Generate a signed JWT for video playback
 */
async function generatePlaybackToken(
  videoId: string, 
  expiresIn: string = DEFAULT_EXPIRATION
): Promise<{ token: string; expiresAt: number }> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET)
  const exp = Math.floor(Date.now() / 1000) + parseExpiration(expiresIn)
  
  const token = await new jose.SignJWT({ video_id: videoId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret)
  
  return { token, expiresAt: exp }
}

/**
 * Parse expiration string to seconds
 */
function parseExpiration(exp: string): number {
  const match = exp.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 3600 // Default 1 hour
  
  const value = parseInt(match[1], 10)
  const unit = match[2]
  
  switch (unit) {
    case 's': return value
    case 'm': return value * 60
    case 'h': return value * 3600
    case 'd': return value * 86400
    default: return 3600
  }
}

// All routes require API key authentication
app.use('/*', requireApiKey)

/**
 * POST /v1/video/:id/playback-token
 * 
 * Request a signed playback token for a video.
 * Your customer's backend calls this to get a token for their end user.
 * 
 * Headers:
 *   Authorization: Bearer sk_live_xxxxx
 * 
 * Body (optional):
 *   { "expires_in": "2h" }  // Token expiration (default: 1h)
 * 
 * Response:
 *   {
 *     "playback_url": "https://delivery.../videos/uuid/playlist.m3u8?token=...",
 *     "token": "eyJ...",
 *     "expires_at": 1234567890
 *   }
 */
app.post('/video/:id/playback-token', async (c) => {
  const organizationId = c.var.organizationId
  const videoId = c.req.param('id')
  
  let expiresIn = DEFAULT_EXPIRATION
  try {
    const body = await c.req.json()
    if (body.expires_in) {
      expiresIn = body.expires_in
    }
  } catch {
    // No body or invalid JSON - use defaults
  }

  // Get video and verify ownership
  const videos = await db
    .select()
    .from(video)
    .where(
      and(
        eq(video.id, videoId),
        eq(video.organizationId, organizationId)
      )
    )
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  if (videoRecord.status !== 'ready') {
    return c.json({ 
      error: 'Video not ready for playback',
      status: videoRecord.status 
    }, 400)
  }

  // For public videos, no token needed
  if (videoRecord.playbackPolicy === 'public') {
    const deliveryUrl = process.env.DELIVERY_URL || 'https://delivery.example.com'
    return c.json({
      playback_url: `${deliveryUrl}/${videoRecord.hlsUrl}`,
      token: null,
      expires_at: null,
      playback_policy: 'public',
    })
  }

  // Generate signed token
  const { token, expiresAt } = await generatePlaybackToken(videoId, expiresIn)
  const deliveryUrl = process.env.DELIVERY_URL || 'https://delivery.example.com'

  return c.json({
    playback_url: `${deliveryUrl}/${videoRecord.hlsUrl}?token=${token}`,
    token,
    expires_at: expiresAt,
    playback_policy: 'signed',
  })
})

/**
 * GET /v1/video/:id
 * 
 * Get video details (without playback token).
 * Use POST /v1/video/:id/playback-token to get a playback URL.
 * 
 * Headers:
 *   Authorization: Bearer sk_live_xxxxx
 */
app.get('/video/:id', async (c) => {
  const organizationId = c.var.organizationId
  const videoId = c.req.param('id')

  const videos = await db
    .select()
    .from(video)
    .where(
      and(
        eq(video.id, videoId),
        eq(video.organizationId, organizationId)
      )
    )
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  const deliveryUrl = process.env.DELIVERY_URL || 'https://delivery.example.com'

  return c.json({
    id: videoRecord.id,
    title: videoRecord.title,
    status: videoRecord.status,
    playback_policy: videoRecord.playbackPolicy,
    duration: videoRecord.duration,
    thumbnail_url: videoRecord.thumbnailUrl 
      ? `${deliveryUrl}/${videoRecord.thumbnailUrl}`
      : null,
    created_at: videoRecord.createdAt,
  })
})

/**
 * GET /v1/videos
 * 
 * List all videos for this organization.
 * 
 * Headers:
 *   Authorization: Bearer sk_live_xxxxx
 * 
 * Query params:
 *   status - Filter by status (pending, processing, ready, failed)
 *   limit - Max results (default: 50)
 */
app.get('/videos', async (c) => {
  const organizationId = c.var.organizationId
  const statusFilter = c.req.query('status')
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)

  let query = db
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
    .limit(limit)
    .orderBy(video.createdAt)

  const videos = await query

  const deliveryUrl = process.env.DELIVERY_URL || 'https://delivery.example.com'

  return c.json({
    data: videos.map(v => ({
      id: v.id,
      title: v.title,
      status: v.status,
      playback_policy: v.playbackPolicy,
      duration: v.duration,
      thumbnail_url: v.thumbnailUrl ? `${deliveryUrl}/${v.thumbnailUrl}` : null,
      created_at: v.createdAt,
    })),
  })
})

export default app
