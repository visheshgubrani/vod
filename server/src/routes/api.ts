/**
 * Public API Routes
 * 
 * These routes are for your B2B customers (external developers) to integrate
 * with your video platform. They authenticate using API keys, not sessions.
 * 
 * Base path: /v1
 */

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import * as jose from 'jose'
import { requireApiKey } from '../middleware/apiKey'
import { db } from '../lib/database'
import { requirePlaybackJwtSecret } from '../lib/config'
import { uploadToken, video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { deleteVideoWithCleanup } from '../lib/objectCleanup'
import type { ApiKeyVariables } from '../types'
import {
  buildPlaybackBindingClaims,
  normalizePlaybackUserAgent,
  type PlaybackBindingClaims,
} from '../utils/playbackBinding'

const app = new Hono<{ Variables: ApiKeyVariables }>()

// JWT token expiration (customizable per request)
const DEFAULT_EXPIRATION = '4h'
const JWT_ISSUER = 'openvod'
const JWT_AUDIENCE = 'playback'
const DEFAULT_ALLOWED_DOMAINS = ['*']
const DEFAULT_ALLOW_NO_REFERRER = true

type PlaybackRestrictionsClaims = {
  allowed_domains: string[]
  allow_no_referrer: boolean
}

function normalizeDomainPattern(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed === '*') return '*'

  const isWildcard = trimmed.startsWith('*.')
  const candidate = isWildcard ? trimmed.slice(2) : trimmed
  if (!candidate) return null

  try {
    const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
    const hostname = url.hostname.toLowerCase()
    if (!hostname || hostname.includes('*')) return null
    return isWildcard ? `*.${hostname}` : hostname
  } catch {
    return null
  }
}

function parseAllowedDomains(value: unknown): { allowedDomains: string[]; error: string | null } {
  if (value === undefined) {
    return { allowedDomains: DEFAULT_ALLOWED_DOMAINS, error: null }
  }

  if (!Array.isArray(value)) {
    return { allowedDomains: DEFAULT_ALLOWED_DOMAINS, error: 'allowed_domains must be an array of domain patterns' }
  }

  const normalized: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      return { allowedDomains: DEFAULT_ALLOWED_DOMAINS, error: 'allowed_domains entries must be strings' }
    }

    const domainPattern = normalizeDomainPattern(item)
    if (!domainPattern) {
      return { allowedDomains: DEFAULT_ALLOWED_DOMAINS, error: `invalid allowed_domains entry: ${item}` }
    }

    if (domainPattern === '*') {
      return { allowedDomains: ['*'], error: null }
    }

    if (!seen.has(domainPattern)) {
      seen.add(domainPattern)
      normalized.push(domainPattern)
    }
  }

  if (normalized.length === 0) {
    return { allowedDomains: DEFAULT_ALLOWED_DOMAINS, error: null }
  }

  return { allowedDomains: normalized, error: null }
}

/**
 * Generate a signed JWT for video playback
 */
async function generatePlaybackToken(
  videoId: string,
  organizationId: string,
  expiresIn: string = DEFAULT_EXPIRATION,
  bindingClaims: PlaybackBindingClaims | null,
  restrictions: PlaybackRestrictionsClaims,
): Promise<{ token: string; expiresAt: number }> {
  const secret = new TextEncoder().encode(requirePlaybackJwtSecret())
  const exp = Math.floor(Date.now() / 1000) + parseExpiration(expiresIn)
  const claims = {
    ...(bindingClaims ?? {}),
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
    .setExpirationTime(exp)
    .sign(secret)

  return { token, expiresAt: exp }
}

/**
 * Parse expiration string to seconds
 */
function parseExpiration(exp: string): number {
  const match = exp.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 14400 // Default 4 hours

  const value = parseInt(match[1], 10)
  const unit = match[2]

  switch (unit) {
    case 's': return value
    case 'm': return value * 60
    case 'h': return value * 3600
    case 'd': return value * 86400
    default: return 14400
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
 *   {
 *     "expires_in": "2h",                // Token expiration (default: 4h)
 *     "viewer_user_agent": "Mozilla...", // Required for signed videos
 *     "allowed_domains": ["*.example.com", "app.example.com"], // Optional, default ["*"]
 *     "allow_no_referrer": true          // Optional, default true
 *   }
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
  let viewerUserAgent: string | undefined
  let rawAllowedDomains: unknown
  let allowNoReferrer = DEFAULT_ALLOW_NO_REFERRER

  try {
    const rawBody = await c.req.json<unknown>()
    if (rawBody && typeof rawBody === 'object') {
      const body = rawBody as Record<string, unknown>

      if (typeof body.expires_in === 'string' && body.expires_in.trim()) {
        expiresIn = body.expires_in
      }

      if (typeof body.viewer_user_agent === 'string' && body.viewer_user_agent.trim()) {
        viewerUserAgent = body.viewer_user_agent
      }

      if ('allowed_domains' in body) {
        rawAllowedDomains = body.allowed_domains
      }

      if (typeof body.allow_no_referrer === 'boolean') {
        allowNoReferrer = body.allow_no_referrer
      }
    }
  } catch {
    // No body or invalid JSON - use defaults
  }

  const headers = c.req.raw.headers
  const providedViewerUserAgent =
    viewerUserAgent || headers.get('x-viewer-user-agent')

  const { allowedDomains, error: allowedDomainsError } = parseAllowedDomains(rawAllowedDomains)
  if (allowedDomainsError) {
    return c.json({
      error: allowedDomainsError,
      hint: 'Use domain names like "example.com", wildcard subdomains like "*.example.com", or "*"',
    }, 400)
  }

  // Get video and verify ownership
  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId),
        eq(video.organizationId, organizationId)
      ))
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
    return c.json({
      playback_url: videoRecord.hlsUrl,
      token: null,
      expires_at: null,
      playback_policy: 'public',
      subtitle_url: videoRecord.subtitleUrl || null,
      chapters: videoRecord.chapters || null,
    })
  }

  if (!providedViewerUserAgent) {
    return c.json({
      error: 'viewer_user_agent is required for signed playback tokens',
      hint: 'Send it in JSON body or x-viewer-user-agent header',
    }, 400)
  }

  const bindingClaims: PlaybackBindingClaims = buildPlaybackBindingClaims(providedViewerUserAgent)
  const restrictions: PlaybackRestrictionsClaims = {
    allowed_domains: allowedDomains,
    allow_no_referrer: allowNoReferrer,
  }

  console.log('[playback-ip-debug] mint-token: api route', {
    videoId,
    organizationId,
    viewerUserAgentSource: viewerUserAgent ? 'body.viewer_user_agent' : 'x-viewer-user-agent header',
    providedViewerUserAgent,
    normalizedViewerUserAgent: normalizePlaybackUserAgent(providedViewerUserAgent),
    bindingClaims,
    restrictions,
  })

  // Generate signed token
  const { token, expiresAt } = await generatePlaybackToken(
    videoId,
    organizationId,
    expiresIn,
    bindingClaims,
    restrictions,
  )

  return c.json({
    playback_url: `${videoRecord.hlsUrl}?token=${token}`,
    token,
    expires_at: expiresAt,
    playback_policy: 'signed',
    subtitle_url: videoRecord.subtitleUrl
      ? `${videoRecord.subtitleUrl}?token=${token}`
      : null,
    chapters: videoRecord.chapters || null,
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
    .where(and(notDeleted, eq(video.id, videoId),
        eq(video.organizationId, organizationId)
      ))
    .limit(1)

  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  return c.json({
    id: videoRecord.id,
    title: videoRecord.title,
    status: videoRecord.status,
    playback_policy: videoRecord.playbackPolicy,
    duration: videoRecord.duration,
    thumbnail_url: videoRecord.thumbnailUrl,
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
    .where(and(notDeleted, eq(video.organizationId, organizationId)))
    .limit(limit)
    .orderBy(video.createdAt)

  const videos = await query

  return c.json({
    data: videos.map(v => ({
      id: v.id,
      title: v.title,
      status: v.status,
      playback_policy: v.playbackPolicy,
      duration: v.duration,
      thumbnail_url: v.thumbnailUrl,
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
    .where(and(notDeleted, eq(video.id, videoId),
        eq(video.organizationId, organizationId)
      ))
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

  // soft-delete-exempt: repeat delete must find the already-deleted row to
  // verify tenant ownership and answer idempotently.
  // Unfiltered lookup: deleting an already-deleted video is idempotent, and the
  // tenant check below still applies, so it must not 404 on a repeat call.
  const videos = await db
    .select()
    .from(video)
    .where(and(eq(video.id, videoId), eq(video.organizationId, organizationId)))
    .limit(1)

  const videoRecord = videos[0]
  if (!videoRecord || videoRecord.deletedAt) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Soft-delete + enqueue reclamation atomically (see objectCleanup.ts).
  await deleteVideoWithCleanup({
    executor: db,
    videoId,
    organizationId,
    deletedBy: null,
  })

  return c.json({
    deleted: true,
    id: videoId,
  })
})

export default app
