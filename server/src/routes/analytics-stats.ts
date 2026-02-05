import { Hono } from 'hono'
import { video } from '../db/schema'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'

const app = new Hono()

// ClickHouse configuration
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123'
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'default'
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || ''

/**
 * Helper to query ClickHouse via HTTP interface
 * Returns parsed JSON array from JSONEachRow format
 */
async function queryClickHouse<T = Record<string, unknown>>(
    sql: string,
): Promise<T[]> {
    const url = new URL(CLICKHOUSE_URL)
    url.searchParams.set('query', `${sql} FORMAT JSONEachRow`)

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            ...(CLICKHOUSE_USER && { 'X-ClickHouse-User': CLICKHOUSE_USER }),
            ...(CLICKHOUSE_PASSWORD && { 'X-ClickHouse-Key': CLICKHOUSE_PASSWORD }),
        },
    })

    if (!response.ok) {
        const errorText = await response.text()
        console.error('ClickHouse query error:', errorText)
        throw new Error(`ClickHouse query failed: ${response.status}`)
    }

    const text = await response.text()
    if (!text.trim()) return []

    // Parse newline-delimited JSON
    return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as T)
}

// =============================================================================
// 1. General Stats (Hero Cards)
// =============================================================================
app.get('/general', async (c) => {
    const videoId = c.req.query('videoId')
    if (!videoId) {
        return c.json({ error: 'Missing videoId parameter' }, 400)
    }

    try {
        const sql = `
      SELECT
        count() as views,
        uniq(session_id) as unique_views,
        sum(watch_seconds) as total_watch_time,
        avg(watch_seconds) as avg_watch_time,
        countIf(error_count > 0) / count() as error_rate
      FROM analytics.video_session_summary
      WHERE video_id = '${videoId}'
    `

        const results = await queryClickHouse<{
            views: string
            unique_views: string
            total_watch_time: string
            avg_watch_time: string
            error_rate: string
        }>(sql)

        const row = results[0] || {
            views: '0',
            unique_views: '0',
            total_watch_time: '0',
            avg_watch_time: '0',
            error_rate: '0',
        }

        return c.json({
            views: parseInt(row.views, 10),
            uniqueViews: parseInt(row.unique_views, 10),
            totalWatchTime: parseFloat(row.total_watch_time),
            avgWatchTime: parseFloat(row.avg_watch_time),
            errorRate: parseFloat(row.error_rate),
        })
    } catch (error) {
        console.error('General stats error:', error)
        return c.json({ error: 'Failed to fetch general stats' }, 500)
    }
})

// =============================================================================
// 2. Retention Graph (Line Chart)
// =============================================================================
app.get('/retention', async (c) => {
    const videoId = c.req.query('videoId')
    if (!videoId) {
        return c.json({ error: 'Missing videoId parameter' }, 400)
    }

    try {
        const sql = `
      SELECT
        floor(current_time / 5) * 5 as bucket,
        uniq(session_id) as viewers
      FROM analytics.video_events_raw
      WHERE video_id = '${videoId}'
        AND watched_delta > 0
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 200
    `

        const results = await queryClickHouse<{
            bucket: string
            viewers: string
        }>(sql)

        return c.json(
            results.map((r) => ({
                bucket: parseFloat(r.bucket),
                viewers: parseInt(r.viewers, 10),
            })),
        )
    } catch (error) {
        console.error('Retention graph error:', error)
        return c.json({ error: 'Failed to fetch retention data' }, 500)
    }
})

// =============================================================================
// 3. Views Over Time (Daily Trend)
// =============================================================================
app.get('/daily-views', async (c) => {
    const videoId = c.req.query('videoId')
    if (!videoId) {
        return c.json({ error: 'Missing videoId parameter' }, 400)
    }

    try {
        const sql = `
      SELECT
        toStartOfDay(started_at) as date,
        count() as views,
        sum(watch_seconds) as total_watch_time
      FROM analytics.video_session_summary
      WHERE video_id = '${videoId}'
        AND started_at >= now() - INTERVAL 30 DAY
      GROUP BY date
      ORDER BY date ASC
    `

        const results = await queryClickHouse<{
            date: string
            views: string
            total_watch_time: string
        }>(sql)

        return c.json(
            results.map((r) => ({
                date: r.date,
                views: parseInt(r.views, 10),
                totalWatchTime: parseFloat(r.total_watch_time),
            })),
        )
    } catch (error) {
        console.error('Daily views error:', error)
        return c.json({ error: 'Failed to fetch daily views' }, 500)
    }
})

// =============================================================================
// 4. Demographics (Geo & Device)
// =============================================================================
app.get('/demographics', async (c) => {
    const videoId = c.req.query('videoId')
    if (!videoId) {
        return c.json({ error: 'Missing videoId parameter' }, 400)
    }

    try {
        // Run both queries in parallel
        const [countries, devices] = await Promise.all([
            queryClickHouse<{ country: string; viewers: string }>(`
        SELECT
          country,
          uniq(session_id) as viewers
        FROM analytics.video_events_raw
        WHERE video_id = '${videoId}'
        GROUP BY country
        ORDER BY viewers DESC
        LIMIT 5
      `),
            queryClickHouse<{ device: string; viewers: string }>(`
        SELECT
          device,
          uniq(session_id) as viewers
        FROM analytics.video_events_raw
        WHERE video_id = '${videoId}'
        GROUP BY device
        ORDER BY viewers DESC
        LIMIT 5
      `),
        ])

        return c.json({
            countries: countries.map((r) => ({
                country: r.country,
                viewers: parseInt(r.viewers, 10),
            })),
            devices: devices.map((r) => ({
                device: r.device,
                viewers: parseInt(r.viewers, 10),
            })),
        })
    } catch (error) {
        console.error('Demographics error:', error)
        return c.json({ error: 'Failed to fetch demographics' }, 500)
    }
})

// =============================================================================
// 5. Top Videos (Leaderboard) - Videos OWNED by the creator/organization
// =============================================================================
app.get('/top-videos', async (c) => {
    const organizationId = c.req.query('organizationId')

    if (!organizationId) {
        return c.json({ error: 'Missing organizationId parameter' }, 400)
    }

    try {
        // 1. First, query Postgres to get all video IDs owned by this organization
        const ownedVideos = await db
            .select({ id: video.id, title: video.title })
            .from(video)
            .where(eq(video.organizationId, organizationId))

        if (ownedVideos.length === 0) {
            return c.json([])
        }

        // 2. Build the IN clause for ClickHouse with the video IDs
        const videoIds = ownedVideos.map((v) => `'${v.id}'`).join(', ')

        const sql = `
      SELECT
        video_id,
        count() as views,
        uniq(session_id) as unique_views,
        sum(watch_seconds) as total_watch_time
      FROM analytics.video_session_summary
      WHERE video_id IN (${videoIds})
      GROUP BY video_id
      ORDER BY views DESC
      LIMIT 10
    `

        const results = await queryClickHouse<{
            video_id: string
            views: string
            unique_views: string
            total_watch_time: string
        }>(sql)

        // 3. Merge with video titles from Postgres
        const videoTitleMap = new Map(ownedVideos.map((v) => [v.id, v.title]))

        return c.json(
            results.map((r) => ({
                videoId: r.video_id,
                title: videoTitleMap.get(r.video_id) || 'Unknown',
                views: parseInt(r.views, 10),
                uniqueViews: parseInt(r.unique_views, 10),
                totalWatchTime: parseFloat(r.total_watch_time),
            })),
        )
    } catch (error) {
        console.error('Top videos error:', error)
        return c.json({ error: 'Failed to fetch top videos' }, 500)
    }
})

export default app
