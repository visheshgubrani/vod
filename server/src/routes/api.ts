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
import { video, uploadToken } from '../db/schema'
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

/**
 * PATCH /v1/video/:id
 * 
 * Update video details.
 * 
 * Headers:
 *   Authorization: Bearer sk_live_xxxxx
 * 
 * Body:
 *   { "title": "New Title", "playback_policy": "signed" }
 */
app.patch('/video/:id', async (c) => {
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

  const body = await c.req.json()

  const updates: { title?: string; playbackPolicy?: 'public' | 'signed' } = {}

  if (body.title?.trim()) {
    updates.title = body.title.trim()
  }

  // Accept both snake_case (API style) and camelCase
  const policy = body.playback_policy || body.playbackPolicy
  if (policy === 'public' || policy === 'signed') {
    updates.playbackPolicy = policy
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  await db
    .update(video)
    .set(updates)
    .where(eq(video.id, videoId))

  return c.json({
    id: videoId,
    title: updates.title || videoRecord.title,
    playback_policy: updates.playbackPolicy || videoRecord.playbackPolicy,
  })
})

/**
 * DELETE /v1/video/:id
 * 
 * Delete a video.
 * 
 * Headers:
 *   Authorization: Bearer sk_live_xxxxx
 */
app.delete('/video/:id', async (c) => {
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

  if (videos.length === 0) {
    return c.json({ error: 'Video not found' }, 404)
  }

  await db
    .delete(video)
    .where(eq(video.id, videoId))

  return c.json({
    deleted: true,
    id: videoId,
  })
})

// =========================================
// UPLOAD TOKEN GENERATION
// =========================================

/**
 * POST /v1/upload/token
 * 
 * Generate a short-lived upload token for frontend use.
 * Your customer's backend calls this with their API key,
 * then passes the token to their frontend for direct uploads.
 * 
 * Headers:
 *   Authorization: Bearer sk_live_xxxxx
 * 
 * Body (optional):
 *   {
 *     "expires_in": "1h",      // Token lifetime (default: 1h, max: 24h)
 *     "max_files": 1,          // Max uploads with this token (default: 1)
 *     "max_size_bytes": null   // Optional max file size in bytes
 *   }
 * 
 * Response:
 *   {
 *     "upload_token": "ut_abc123...",
 *     "expires_at": "2024-02-06T21:00:00Z",
 *     "max_files": 1,
 *     "max_size_bytes": null
 *   }
 */
app.post('/upload/token', async (c) => {
  const organizationId = c.var.organizationId
  const apiKeyId = c.var.apiKeyId

  let expiresIn = '1h'
  let maxFiles = 1
  let maxSizeBytes: number | null = null

  try {
    const body = await c.req.json()
    if (body.expires_in) {
      // Validate and cap at 24 hours
      const seconds = parseExpiration(body.expires_in)
      if (seconds > 86400) {
        return c.json({ error: 'expires_in cannot exceed 24h' }, 400)
      }
      expiresIn = body.expires_in
    }
    if (body.max_files !== undefined) {
      const mf = Number(body.max_files)
      if (!Number.isInteger(mf) || mf < 1 || mf > 100) {
        return c.json({ error: 'max_files must be an integer between 1 and 100' }, 400)
      }
      maxFiles = mf
    }
    if (body.max_size_bytes !== undefined && body.max_size_bytes !== null) {
      const msb = Number(body.max_size_bytes)
      if (!Number.isInteger(msb) || msb < 1) {
        return c.json({ error: 'max_size_bytes must be a positive integer' }, 400)
      }
      maxSizeBytes = msb
    }
  } catch {
    // No body or invalid JSON - use defaults
  }

  // Generate unique token ID and token value
  const tokenId = `ut_${crypto.randomUUID().replace(/-/g, '')}`
  const tokenValue = `${tokenId}_${crypto.randomUUID().replace(/-/g, '')}`

  // Calculate expiration
  const expiresAtMs = Date.now() + parseExpiration(expiresIn) * 1000
  const expiresAt = new Date(expiresAtMs)

  // Insert token into database
  await db.insert(uploadToken).values({
    id: tokenId,
    token: tokenValue,
    organizationId,
    apiKeyId,
    maxFiles,
    usedFiles: 0,
    maxSizeBytes,
    expiresAt,
  })

  return c.json({
    upload_token: tokenValue,
    expires_at: expiresAt.toISOString(),
    max_files: maxFiles,
    max_size_bytes: maxSizeBytes,
  })
})

export default app

