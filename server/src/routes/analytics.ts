import { Hono } from 'hono'

const app = new Hono()

// ClickHouse configuration
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123'
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'default'
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || ''

// Event type definition
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

// Parse User-Agent to extract device and browser info
function parseUserAgent(ua: string): { device: string; browser: string } {
    let device = 'unknown'
    let browser = 'unknown'

    // Device detection
    if (/mobile/i.test(ua)) {
        device = 'mobile'
    } else if (/tablet|ipad/i.test(ua)) {
        device = 'tablet'
    } else if (/smart-tv|smarttv|tv/i.test(ua)) {
        device = 'tv'
    } else {
        device = 'desktop'
    }

    // Browser detection
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

// POST /events - Accept analytics events from the player
app.post('/events', async (c) => {
    try {
        const events = await c.req.json<AnalyticsEvent[]>()

        if (!Array.isArray(events) || events.length === 0) {
            return c.json({ error: 'Invalid payload: expected non-empty array' }, 400)
        }

        // Extract headers for geo/device info
        const country = c.req.header('CF-IPCountry') || 'unknown'
        const userAgent = c.req.header('User-Agent') || ''
        const platform = c.req.header('Sec-CH-UA-Platform')?.replace(/"/g, '') || ''

        const { device: parsedDevice, browser } = parseUserAgent(userAgent)
        // Prefer Sec-CH-UA-Platform if available, otherwise use parsed UA
        const device = platform || parsedDevice

        const receivedAt = new Date().toISOString().replace('T', ' ').replace('Z', '')

        // Map events to ClickHouse snake_case format
        const rows = events.map((e) => {
            // Format timestamp for DateTime64(3) - expects 'YYYY-MM-DD HH:mm:ss.SSS' format
            const eventTs = e.ts
                ? new Date(e.ts).toISOString().replace('T', ' ').replace('Z', '')
                : receivedAt

            return {
                event: e.event || 'unknown',
                ts: eventTs,
                received_at: receivedAt,
                video_id: e.videoId,
                session_id: e.sessionId,
                user_id: e.userId || null,
                current_time: e.currentTime ?? 0,
                duration: e.duration ?? 0,
                watched_delta: e.watchedDelta ?? 0,
                country,
                device,
                browser,
                error_code: e.errorCode || '',
            }
        })

        // Convert to JSONEachRow format (newline-delimited JSON)
        const body = rows.map((row) => JSON.stringify(row)).join('\n')

        // Build ClickHouse URL with query params
        const url = new URL(CLICKHOUSE_URL)
        url.searchParams.set(
            'query',
            'INSERT INTO analytics.video_events_raw FORMAT JSONEachRow',
        )
        url.searchParams.set('async_insert', '1')

        // Send to ClickHouse via HTTP interface
        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(CLICKHOUSE_USER && {
                    'X-ClickHouse-User': CLICKHOUSE_USER,
                }),
                ...(CLICKHOUSE_PASSWORD && {
                    'X-ClickHouse-Key': CLICKHOUSE_PASSWORD,
                }),
            },
            body,
        })

        if (!response.ok) {
            const errorText = await response.text()
            console.error('ClickHouse insert error:', errorText)
            return c.json({ error: 'Failed to store events' }, 500)
        }

        return c.json({ success: true, count: events.length })
    } catch (error) {
        console.error('Analytics error:', error)
        return c.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500,
        )
    }
})

export default app
