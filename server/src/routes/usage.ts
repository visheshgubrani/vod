import { Hono } from 'hono'
import { eq, sum, count, desc } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { db } from '../lib/database'
import { video, member } from '../db/schema'

const app = new Hono()

app.use('/*', requireAuth)

/**
 * GET /api/usage
 * Get storage usage summary for current organization
 */
app.get('/', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // Aggregate storage usage
  const result = await db
    .select({
      totalTranscodedSize: sum(video.transcodedSize),
      totalRawSize: sum(video.size),
      totalDuration: sum(video.duration),
      videoCount: count(video.id),
    })
    .from(video)
    .where(eq(video.organizationId, organizationId))

  const stats = result[0]

  // Convert to numbers (sum returns string in some DBs)
  const totalTranscodedBytes = Number(stats.totalTranscodedSize) || 0
  const totalRawBytes = Number(stats.totalRawSize) || 0
  const totalDurationSecs = Number(stats.totalDuration) || 0
  const totalVideos = Number(stats.videoCount) || 0

  return c.json({
    organizationId,
    storage: {
      // Billing is based on transcoded size
      billedBytes: totalTranscodedBytes,
      billedMB: Math.round(totalTranscodedBytes / (1024 * 1024) * 100) / 100,
      billedGB: Math.round(totalTranscodedBytes / (1024 * 1024 * 1024) * 1000) / 1000,
      
      // Raw upload size (for reference)
      uploadedBytes: totalRawBytes,
      uploadedMB: Math.round(totalRawBytes / (1024 * 1024) * 100) / 100,
      
      // Compression ratio
      compressionRatio: totalRawBytes > 0 
        ? Math.round((1 - totalTranscodedBytes / totalRawBytes) * 100) 
        : 0,
    },
    content: {
      totalVideos,
      totalDurationSeconds: totalDurationSecs,
      totalDurationMinutes: Math.round(totalDurationSecs / 60 * 10) / 10,
      totalDurationHours: Math.round(totalDurationSecs / 3600 * 100) / 100,
    },
  })
})

/**
 * GET /api/usage/breakdown
 * Get per-video storage breakdown for current organization
 */
app.get('/breakdown', async (c) => {
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
      duration: video.duration,
      rawSize: video.size,
      transcodedSize: video.transcodedSize,
      createdAt: video.createdAt,
    })
    .from(video)
    .where(eq(video.organizationId, organizationId))
    .orderBy(desc(video.createdAt))

  // Calculate totals
  let totalTranscoded = 0
  let totalRaw = 0

  const breakdown = videos.map((v) => {
    const transcoded = Number(v.transcodedSize) || 0
    const raw = Number(v.rawSize) || 0
    totalTranscoded += transcoded
    totalRaw += raw

    return {
      id: v.id,
      title: v.title,
      status: v.status,
      duration: v.duration,
      // Storage info
      transcodedBytes: transcoded,
      transcodedMB: Math.round(transcoded / (1024 * 1024) * 100) / 100,
      rawBytes: raw,
      rawMB: Math.round(raw / (1024 * 1024) * 100) / 100,
      // Compression
      compressionRatio: raw > 0 ? Math.round((1 - transcoded / raw) * 100) : 0,
      createdAt: v.createdAt,
    }
  })

  return c.json({
    organizationId,
    summary: {
      totalVideos: videos.length,
      totalTranscodedBytes: totalTranscoded,
      totalTranscodedMB: Math.round(totalTranscoded / (1024 * 1024) * 100) / 100,
      totalRawBytes: totalRaw,
      totalRawMB: Math.round(totalRaw / (1024 * 1024) * 100) / 100,
    },
    videos: breakdown,
  })
})

export default app
