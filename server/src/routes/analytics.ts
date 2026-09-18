import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { db } from '../lib/database'
import { WAE_MAX_DATA_POINTS_PER_INVOCATION } from '../lib/analytics-engine'
import {
  JOURNAL_MAX_BODY_BYTES,
  isVideoUuid,
  parseJournalEvents,
  readTextWithLimit,
  toPlaybackRow,
} from '../lib/playbackJournal'
import type { PlaybackRow } from '../runtime/types'
import type { Bindings } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

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

async function resolveOrganizationIds(videoIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(videoIds.filter(isVideoUuid))]
  const ownership = new Map<string, string>()
  if (unique.length === 0) return ownership

  const rows = await db
    .select({ id: video.id, organizationId: video.organizationId })
    .from(video)
    .where(and(notDeleted, inArray(video.id, unique)))

  for (const row of rows) {
    ownership.set(row.id, row.organizationId)
  }
  return ownership
}

app.post('/journal', async (c) => {
  try {
    const limited = await readTextWithLimit(c.req.raw, JOURNAL_MAX_BODY_BYTES)
    if (!limited.ok) {
      return c.json(
        {
          error: limited.error,
          ...(limited.status === 413 ? { limitBytes: JOURNAL_MAX_BODY_BYTES } : {}),
        },
        limited.status,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(limited.text) as unknown
    } catch {
      return c.json({ error: 'Invalid payload: expected JSON array' }, 400)
    }

    const result = parseJournalEvents(parsed)
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }

    const truncated = result.truncated

    if (!c.var.runtime.analytics.canWritePlayback) {
      return c.json({
        success: true,
        count: 0,
        received: result.received,
        truncated,
        disabled: !c.var.runtime.shape.analyticsEnabled,
      })
    }

    const userAgent = c.req.header('User-Agent') || ''
    const platform = c.req.header('Sec-CH-UA-Platform')?.replace(/"/g, '') || ''
    const { device: parsedDevice, browser } = parseUserAgent(userAgent)
    const device = platform || parsedDevice
    // Geographic enrichment is out of scope: Node has no trusted client-country
    // source, and CF-IPCountry on this host would be the API's location.
    const country = 'unknown'

    const ownership = await resolveOrganizationIds(result.events.map((event) => event.videoId))
    const rows: PlaybackRow[] = []
    for (const event of result.events) {
      const organizationId = ownership.get(event.videoId)
      if (!organizationId) continue
      const row = toPlaybackRow(event, { organizationId, country, device, browser })
      if (row) rows.push(row)
    }

    const toWrite = rows.slice(0, WAE_MAX_DATA_POINTS_PER_INVOCATION)

    c.var.runtime.background(
      c.var.runtime.analytics.writePlayback(toWrite),
      'playback analytics forward',
    )

    return c.json({
      success: true,
      count: toWrite.length,
      received: result.received,
      truncated: result.truncated,
      ...(result.truncated
        ? {
            message: `Accepted ${toWrite.length} of ${result.received} events (WAE limit ${WAE_MAX_DATA_POINTS_PER_INVOCATION} per request)`,
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
