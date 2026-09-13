import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { db } from '../lib/database'
import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from '../lib/analytics-engine'
import type { PlaybackRow } from '../runtime/types'
import type { Bindings } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

interface AnalyticsEvent {
  event: string
  ts: string
  videoId: string
  sessionId: string
  userId?: string | null
  currentTime?: number
  duration?: number
  watchedDelta?: number
  errorCode?: string
}

function parseUserAgent(ua: string): { device: string; browser: string } {
  let device = 'unknown'
  let browser = 'unknown'

  if (/mobile/i.test(ua)) {
    device = 'mobile'
  } else if (/tablet|ipad/i.test(ua)) {
    device = 'tablet'
  } else if (/smart-tv|smarttv|tv/i.test(ua)) {
    device = 'tv'
  } else {
    device = 'desktop'
  }

  if (/firefox/i.test(ua)) {
    browser = 'firefox'
  } else if (/edg/i.test(ua)) {
    browser = 'edge'
  } else if (/chrome/i.test(ua)) {
    browser = 'chrome'
  } else if (/safari/i.test(ua)) {
    browser = 'safari'
  } else if (/opera|opr/i.test(ua)) {
    browser = 'opera'
  }

  return { device, browser }
}

async function resolveOrganizationId(videoId: string): Promise<string> {
  try {
    const rows = await db
      .select({ organizationId: video.organizationId })
      .from(video)
      .where(and(notDeleted, eq(video.id, videoId)))
      .limit(1)

    return rows[0]?.organizationId || ''
  } catch {
    return ''
  }
}

app.post('/journal', async (c) => {
  try {
    const events = await c.req.json<AnalyticsEvent[]>()

    if (!Array.isArray(events) || events.length === 0) {
      return c.json({ error: 'Invalid payload: expected non-empty array' }, 400)
    }

    const country = c.req.header('CF-IPCountry') || 'unknown'
    const userAgent = c.req.header('User-Agent') || ''
    const platform = c.req.header('Sec-CH-UA-Platform')?.replace(/"/g, '') || ''

    const { device: parsedDevice, browser } = parseUserAgent(userAgent)
    const device = platform || parsedDevice

    const primaryVideoId = events[0]?.videoId || ''
    const organizationId = primaryVideoId
      ? await resolveOrganizationId(primaryVideoId)
      : ''

    const rows: PlaybackRow[] = events.map((e) => ({
      event: e.event || 'unknown',
      videoId: e.videoId,
      sessionId: e.sessionId,
      userId: e.userId || '',
      country,
      device,
      browser,
      errorCode: e.errorCode || '',
      watchedDelta: e.watchedDelta ?? 0,
      currentTime: e.currentTime ?? 0,
      duration: e.duration ?? 0,
    }))

    // The sink is a capability, not a binding lookup: Node has no Analytics
    // Engine binding at all, which is a fact about the runtime rather than a
    // per-request surprise.
    if (!c.var.runtime.analytics.canWritePlayback) {
      return c.json({ error: 'Playback analytics not configured' }, 501)
    }

    // Cap before scheduling so the response reflects what will actually be written
    const toWrite = rows.slice(0, WAE_MAX_DATA_POINTS_PER_INVOCATION)
    const truncated = rows.length > toWrite.length

    c.var.runtime.background(
      Promise.resolve().then(() => {
        c.var.runtime.analytics.writePlayback(organizationId, toWrite)
      }),
      'playback analytics write',
    )

    return c.json({
      success: true,
      count: toWrite.length,
      received: events.length,
      truncated,
      ...(truncated
        ? {
            message: `Accepted ${toWrite.length} of ${events.length} events (WAE limit ${WAE_MAX_DATA_POINTS_PER_INVOCATION} per request)`,
          }
        : {}),
    })
  } catch (error) {
    console.error('Analytics error:', error)
    return c.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      500,
    )
  }
})

export default app
