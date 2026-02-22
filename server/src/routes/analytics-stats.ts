import { Context, Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { video } from '../db/schema'
import { db } from '../lib/database'
import { requireAuth } from '../middleware/auth'

const app = new Hono()
app.use('/*', requireAuth)

// ClickHouse configuration
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123'
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'default'
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || ''
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ClickHouseParamValue = string | number | boolean

function validateVideoId(videoId: string): boolean {
  return UUID_REGEX.test(videoId)
}

function parseIntWithBounds(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!value) return defaultValue

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultValue
  }

  return Math.min(Math.max(parsed, min), max)
}

function parseOptionalIntWithBounds(
  value: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!value) return null

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return null
  }

  return Math.min(Math.max(parsed, min), max)
}



async function isVideoOwnedByOrganization(
  organizationId: string,
  videoId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: video.id })
    .from(video)
    .where(and(eq(video.id, videoId), eq(video.organizationId, organizationId)))
    .limit(1)

  return rows.length > 0
}

function requireActiveOrganizationId(c: Context): string | null {
  const organizationId = c.var.session.activeOrganizationId
  return organizationId || null
}

async function getValidatedOwnedVideoId(
  c: Context,
): Promise<
  | { videoId: string; errorResponse: null }
  | { videoId: null; errorResponse: Response }
> {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return {
      videoId: null,
      errorResponse: c.json({ error: 'No active organization' }, 400),
    }
  }

  const videoId = c.req.query('videoId')
  if (!videoId) {
    return {
      videoId: null,
      errorResponse: c.json({ error: 'Missing videoId parameter' }, 400),
    }
  }

  if (!validateVideoId(videoId)) {
    return {
      videoId: null,
      errorResponse: c.json({ error: 'Invalid videoId format' }, 400),
    }
  }

  const isOwned = await isVideoOwnedByOrganization(organizationId, videoId)
  if (!isOwned) {
    return {
      videoId: null,
      errorResponse: c.json(
        { error: 'Video not found for active organization' },
        404,
      ),
    }
  }

  return { videoId, errorResponse: null }
}

/**
 * Helper to query ClickHouse via HTTP interface
 * Returns parsed JSON array from JSONEachRow format
 */
async function queryClickHouse<T = Record<string, unknown>>(
  sql: string,
  params: Record<string, ClickHouseParamValue> = {},
): Promise<T[]> {
  const url = new URL(CLICKHOUSE_URL)
  url.searchParams.set('query', `${sql} FORMAT JSONEachRow`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, String(value))
  }

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
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    const sql = `
      SELECT
        count() as views,
        uniq(ifNull(user_id, toString(session_id))) as unique_views,
        coalesce(sum(watch_seconds), 0) as total_watch_time,
        coalesce(avg(watch_seconds), 0) as avg_watch_time,
        if(sum(event_count) = 0, 0, sum(error_count) / sum(event_count)) as error_rate
      FROM analytics.video_session_summary
      WHERE video_id = {videoId:UUID}
    `

    const results = await queryClickHouse<{
      views: string
      unique_views: string
      total_watch_time: string
      avg_watch_time: string
      error_rate: string
    }>(sql, { videoId: validated.videoId })

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
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    const sql = `
      SELECT
        floor(current_time / 5) * 5 as bucket,
        uniq(session_id) as viewers
      FROM analytics.video_events_raw
      WHERE video_id = {videoId:UUID}
        AND watched_delta > 0
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 200
    `

    const results = await queryClickHouse<{
      bucket: string
      viewers: string
    }>(sql, { videoId: validated.videoId })

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
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    const sql = `
      SELECT
        toStartOfDay(started_at) as date,
        count() as views,
        sum(watch_seconds) as total_watch_time
      FROM analytics.video_session_summary
      WHERE video_id = {videoId:UUID}
        AND started_at >= now() - INTERVAL 30 DAY
      GROUP BY date
      ORDER BY date ASC
    `

    const results = await queryClickHouse<{
      date: string
      views: string
      total_watch_time: string
    }>(sql, { videoId: validated.videoId })

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
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    // Run both queries in parallel
    const [countries, devices] = await Promise.all([
      queryClickHouse<{ country: string; viewers: string }>(
        `
        SELECT
          country,
          uniq(session_id) as viewers
        FROM analytics.video_events_raw
        WHERE video_id = {videoId:UUID}
        GROUP BY country
        ORDER BY viewers DESC
        LIMIT 5
      `,
        { videoId: validated.videoId },
      ),
      queryClickHouse<{ device: string; viewers: string }>(
        `
        SELECT
          device,
          uniq(session_id) as viewers
        FROM analytics.video_events_raw
        WHERE video_id = {videoId:UUID}
        GROUP BY device
        ORDER BY viewers DESC
        LIMIT 5
      `,
        { videoId: validated.videoId },
      ),
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
// 5. Video Content Score
// =============================================================================
app.get('/video/content-score', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    const videoRow = await db
      .select({ duration: video.duration })
      .from(video)
      .where(eq(video.id, validated.videoId))
      .limit(1)

    const durationSeconds = Number(videoRow[0]?.duration) || 0
    const completionThreshold = durationSeconds > 0 ? durationSeconds * 0.95 : 0

    const [scoreRows, peakRows] = await Promise.all([
      queryClickHouse<{
        total_sessions: string
        avg_watch_seconds: string
        total_watch_seconds: string
        unique_viewers: string
        completion_rate: string
      }>(
        `
          SELECT
            count() as total_sessions,
            coalesce(avg(watch_seconds), 0) as avg_watch_seconds,
            coalesce(sum(watch_seconds), 0) as total_watch_seconds,
            uniq(ifNull(user_id, toString(session_id))) as unique_viewers,
            if(
              count() = 0 OR {durationSeconds:Float64} <= 0,
              0,
              countIf(max_position >= {completionThreshold:Float64}) / count()
            ) as completion_rate
          FROM analytics.video_session_summary
          WHERE video_id = {videoId:UUID}
        `,
        {
          videoId: validated.videoId,
          durationSeconds,
          completionThreshold,
        },
      ),
      queryClickHouse<{ peak_concurrents: string }>(
        `
          SELECT
            coalesce(max(active_sessions), 0) as peak_concurrents
          FROM (
            SELECT
              toStartOfMinute(ts) as minute_bucket,
              uniq(session_id) as active_sessions
            FROM analytics.video_events_raw
            WHERE video_id = {videoId:UUID}
            GROUP BY minute_bucket
          )
        `,
        { videoId: validated.videoId },
      ),
    ])

    const score = scoreRows[0] || {
      total_sessions: '0',
      avg_watch_seconds: '0',
      total_watch_seconds: '0',
      unique_viewers: '0',
      completion_rate: '0',
    }

    const peak = peakRows[0] || { peak_concurrents: '0' }

    return c.json({
      totalSessions: parseInt(score.total_sessions, 10),
      uniqueViewers: parseInt(score.unique_viewers, 10),
      avgWatchSeconds: parseFloat(score.avg_watch_seconds),
      totalWatchSeconds: parseFloat(score.total_watch_seconds),
      completionRate: parseFloat(score.completion_rate),
      completionRatePercent: parseFloat(score.completion_rate) * 100,
      peakConcurrents: parseInt(peak.peak_concurrents, 10),
      durationSeconds,
    })
  } catch (error) {
    console.error('Video content score error:', error)
    return c.json({ error: 'Failed to fetch video content score' }, 500)
  }
})

// =============================================================================
// 6. Video Retention Curve (0%-100% progress)
// =============================================================================
app.get('/video/retention-curve', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    const rows = await queryClickHouse<{
      progress_percent: string
      viewers_percent: string
      viewers: string
      total_sessions: string
    }>(
      `
        WITH session_progress AS (
          SELECT
            session_id,
            greatest(0.0, least(100.0, max(
              if(duration > 0, (current_time / duration) * 100, 0)
            ))) as max_progress
          FROM analytics.video_events_raw
          WHERE video_id = {videoId:UUID}
          GROUP BY session_id
        )
        SELECT
          progress_percent,
          if(total_sessions = 0, 0, round(100.0 * viewers / total_sessions, 2)) as viewers_percent,
          viewers,
          total_sessions
        FROM (
          SELECT
            bucket as progress_percent,
            countIf(sp.max_progress >= bucket) as viewers,
            count() as total_sessions
          FROM session_progress as sp
          CROSS JOIN (
            SELECT number * 5 as bucket
            FROM numbers(21)
          ) as buckets
          GROUP BY bucket
        )
        ORDER BY progress_percent ASC
      `,
      { videoId: validated.videoId },
    )

    const totalSessions =
      rows.length > 0 ? parseInt(rows[0].total_sessions, 10) : 0

    return c.json({
      totalSessions,
      curve: rows.map((row) => ({
        progressPercent: parseFloat(row.progress_percent),
        viewersPercent: parseFloat(row.viewers_percent),
        viewers: parseInt(row.viewers, 10),
      })),
    })
  } catch (error) {
    console.error('Video retention curve error:', error)
    return c.json({ error: 'Failed to fetch retention curve' }, 500)
  }
})

// =============================================================================
// 7. Video Tech Health
// =============================================================================
app.get('/video/tech-health', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) {
    return validated.errorResponse
  }

  try {
    const [summaryRows, seekRows, topErrorsRows] = await Promise.all([
      queryClickHouse<{
        total_sessions: string
        total_errors: string
        sessions_with_errors: string
        total_events: string
        error_event_rate: string
        session_error_rate: string
      }>(
        `
          SELECT
            count() as total_sessions,
            coalesce(sum(error_count), 0) as total_errors,
            countIf(error_count > 0) as sessions_with_errors,
            coalesce(sum(event_count), 0) as total_events,
            if(sum(event_count) = 0, 0, sum(error_count) / sum(event_count)) as error_event_rate,
            if(count() = 0, 0, countIf(error_count > 0) / count()) as session_error_rate
          FROM analytics.video_session_summary
          WHERE video_id = {videoId:UUID}
        `,
        { videoId: validated.videoId },
      ),
      queryClickHouse<{
        seek_events: string
        sessions_with_seek: string
        raw_total_sessions: string
      }>(
        `
          SELECT
            countIf(event = 'seeking') as seek_events,
            uniqIf(session_id, event = 'seeking') as sessions_with_seek,
            uniq(session_id) as raw_total_sessions
          FROM analytics.video_events_raw
          WHERE video_id = {videoId:UUID}
        `,
        { videoId: validated.videoId },
      ),
      queryClickHouse<{ error_code: string; count: string }>(
        `
          SELECT
            if(error_code = '', 'unknown', error_code) as error_code,
            count() as count
          FROM analytics.video_events_raw
          WHERE video_id = {videoId:UUID}
            AND (event = 'error' OR error_code != '')
          GROUP BY error_code
          ORDER BY count DESC
          LIMIT 5
        `,
        { videoId: validated.videoId },
      ),
    ])

    const summary = summaryRows[0] || {
      total_sessions: '0',
      total_errors: '0',
      sessions_with_errors: '0',
      total_events: '0',
      error_event_rate: '0',
      session_error_rate: '0',
    }

    const seek = seekRows[0] || {
      seek_events: '0',
      sessions_with_seek: '0',
      raw_total_sessions: '0',
    }

    const rawTotalSessions = parseInt(seek.raw_total_sessions, 10)
    const sessionsWithSeek = parseInt(seek.sessions_with_seek, 10)
    const bufferingSessionRate =
      rawTotalSessions > 0 ? sessionsWithSeek / rawTotalSessions : 0

    return c.json({
      totalSessions: parseInt(summary.total_sessions, 10),
      totalEvents: parseInt(summary.total_events, 10),
      totalErrors: parseInt(summary.total_errors, 10),
      sessionsWithErrors: parseInt(summary.sessions_with_errors, 10),
      errorEventRate: parseFloat(summary.error_event_rate),
      errorEventRatePercent: parseFloat(summary.error_event_rate) * 100,
      sessionErrorRate: parseFloat(summary.session_error_rate),
      sessionErrorRatePercent: parseFloat(summary.session_error_rate) * 100,
      seekEvents: parseInt(seek.seek_events, 10),
      sessionsWithSeek,
      bufferingSessionRate,
      bufferingSessionRatePercent: bufferingSessionRate * 100,
      topErrors: topErrorsRows.map((row) => ({
        code: row.error_code,
        count: parseInt(row.count, 10),
      })),
    })
  } catch (error) {
    console.error('Video tech health error:', error)
    return c.json({ error: 'Failed to fetch video tech health' }, 500)
  }
})

// =============================================================================
// 8. Organization Hero Stats (account-wide KPI cards)
// =============================================================================
app.get('/organization/hero-stats', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }
  const days = parseOptionalIntWithBounds(c.req.query('days'), 7, 365)

  try {
    const sql = `
      SELECT
        count() as total_views,
        coalesce(sum(watch_seconds), 0) as total_watch_seconds,
        uniq(ifNull(user_id, toString(session_id))) as unique_viewers,
        if(sum(event_count) = 0, 0, sum(error_count) / sum(event_count)) as error_rate
      FROM analytics.video_session_summary
      WHERE organization_id = {orgId:String}
      ${days !== null ? 'AND started_at >= now() - INTERVAL {days:Int32} DAY' : ''}
    `

    const results = await queryClickHouse<{
      total_views: string
      total_watch_seconds: string
      unique_viewers: string
      error_rate: string
    }>(sql, {
      orgId: organizationId,
      ...(days !== null ? { days } : {}),
    })

    const row = results[0] || {
      total_views: '0',
      total_watch_seconds: '0',
      unique_viewers: '0',
      error_rate: '0',
    }

    const totalWatchSeconds = parseFloat(row.total_watch_seconds)
    const errorRate = parseFloat(row.error_rate)

    return c.json({
      days,
      totalViews: parseInt(row.total_views, 10),
      watchTimeHours: totalWatchSeconds / 3600,
      watchTimeSeconds: totalWatchSeconds,
      uniqueViewers: parseInt(row.unique_viewers, 10),
      errorRate,
      errorRatePercent: errorRate * 100,
    })
  } catch (error) {
    console.error('Organization hero stats error:', error)
    return c.json({ error: 'Failed to fetch organization hero stats' }, 500)
  }
})

// =============================================================================
// 6. Organization Growth (daily account timeline)
// =============================================================================
app.get('/organization/growth', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const days = parseIntWithBounds(c.req.query('days'), 30, 7, 365)

  try {
    const sql = `
      SELECT
        toDate(started_at) as date,
        count() as views,
        uniq(ifNull(user_id, toString(session_id))) as unique_viewers,
        coalesce(sum(watch_seconds), 0) as watch_seconds
      FROM analytics.video_session_summary
      WHERE organization_id = {orgId:String}
        AND started_at >= now() - INTERVAL {days:Int32} DAY
      GROUP BY date
      ORDER BY date ASC
    `

    const results = await queryClickHouse<{
      date: string
      views: string
      unique_viewers: string
      watch_seconds: string
    }>(sql, {
      orgId: organizationId,
      days,
    })

    return c.json({
      days,
      timeline: results.map((row) => {
        const watchSeconds = parseFloat(row.watch_seconds)
        return {
          date: row.date,
          views: parseInt(row.views, 10),
          uniqueViewers: parseInt(row.unique_viewers, 10),
          watchTimeSeconds: watchSeconds,
          watchTimeHours: watchSeconds / 3600,
        }
      }),
    })
  } catch (error) {
    console.error('Organization growth error:', error)
    return c.json({ error: 'Failed to fetch organization growth data' }, 500)
  }
})

// =============================================================================
// 7. Organization Demographics (countries + device split)
// =============================================================================
app.get('/organization/demographics', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const days = parseIntWithBounds(c.req.query('days'), 30, 7, 365)

  try {
    const [countries, devices] = await Promise.all([
      queryClickHouse<{
        country: string
        viewers: string
        sessions: string
      }>(
        `
          SELECT
            if(country = '', 'Unknown', country) as country,
            uniq(ifNull(user_id, toString(session_id))) as viewers,
            uniq(session_id) as sessions
          FROM analytics.video_events_raw
          WHERE organization_id = {orgId:String}
            AND ts >= now() - INTERVAL {days:Int32} DAY
          GROUP BY country
          ORDER BY viewers DESC
          LIMIT 8
        `,
        { orgId: organizationId, days },
      ),
      queryClickHouse<{
        device_type: string
        viewers: string
        sessions: string
      }>(
        `
          SELECT
            multiIf(
              positionCaseInsensitive(device, 'mobile') > 0
                OR positionCaseInsensitive(device, 'android') > 0
                OR positionCaseInsensitive(device, 'iphone') > 0, 'Mobile',
              positionCaseInsensitive(device, 'tablet') > 0
                OR positionCaseInsensitive(device, 'ipad') > 0, 'Tablet',
              positionCaseInsensitive(device, 'tv') > 0, 'TV',
              'Desktop'
            ) as device_type,
            uniq(ifNull(user_id, toString(session_id))) as viewers,
            uniq(session_id) as sessions
          FROM analytics.video_events_raw
          WHERE organization_id = {orgId:String}
            AND ts >= now() - INTERVAL {days:Int32} DAY
          GROUP BY device_type
          ORDER BY viewers DESC
        `,
        { orgId: organizationId, days },
      ),
    ])

    return c.json({
      days,
      countries: countries.map((row) => ({
        country: row.country,
        viewers: parseInt(row.viewers, 10),
        sessions: parseInt(row.sessions, 10),
      })),
      devices: devices.map((row) => ({
        device: row.device_type,
        viewers: parseInt(row.viewers, 10),
        sessions: parseInt(row.sessions, 10),
      })),
    })
  } catch (error) {
    console.error('Organization demographics error:', error)
    return c.json({ error: 'Failed to fetch organization demographics' }, 500)
  }
})

// =============================================================================
// 8. Top Videos Leaderboard (organization-wide)
// =============================================================================
async function getTopVideosLeaderboard(
  organizationId: string,
  limit: number,
  days: number | null,
) {
  const sql = `
    SELECT
      toString(video_id) as video_id,
      count() as views,
      uniq(ifNull(user_id, toString(session_id))) as unique_viewers,
      coalesce(sum(watch_seconds), 0) as total_watch_seconds,
      if(sum(event_count) = 0, 0, sum(error_count) / sum(event_count)) as error_rate
    FROM analytics.video_session_summary
    WHERE organization_id = {orgId:String}
    ${days !== null ? 'AND started_at >= now() - INTERVAL {days:Int32} DAY' : ''}
    GROUP BY video_id
    ORDER BY views DESC
    LIMIT {limit:UInt16}
  `

  const results = await queryClickHouse<{
    video_id: string
    views: string
    unique_viewers: string
    total_watch_seconds: string
    error_rate: string
  }>(sql, {
    orgId: organizationId,
    limit,
    ...(days !== null ? { days } : {}),
  })

  if (results.length === 0) return []

  // Fetch titles only for the videos that appear in results (small set)
  const videoRows = await db
    .select({ id: video.id, title: video.title })
    .from(video)
    .where(eq(video.organizationId, organizationId))

  const titleByVideoId = new Map(videoRows.map((row) => [row.id, row.title]))

  return results.map((row) => ({
    videoId: row.video_id,
    title: titleByVideoId.get(row.video_id) || 'Unknown',
    views: parseInt(row.views, 10),
    uniqueViewers: parseInt(row.unique_viewers, 10),
    totalWatchSeconds: parseFloat(row.total_watch_seconds),
    totalWatchHours: parseFloat(row.total_watch_seconds) / 3600,
    errorRate: parseFloat(row.error_rate),
    errorRatePercent: parseFloat(row.error_rate) * 100,
  }))
}

app.get('/organization/top-videos', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const limit = parseIntWithBounds(c.req.query('limit'), 10, 1, 50)
  const days = parseOptionalIntWithBounds(c.req.query('days'), 7, 365)

  try {
    const leaderboard = await getTopVideosLeaderboard(
      organizationId,
      limit,
      days,
    )
    return c.json(leaderboard)
  } catch (error) {
    console.error('Organization top videos error:', error)
    return c.json({ error: 'Failed to fetch organization top videos' }, 500)
  }
})

// Backward-compatible alias
app.get('/top-videos', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const limit = parseIntWithBounds(c.req.query('limit'), 10, 1, 50)
  const days = parseOptionalIntWithBounds(c.req.query('days'), 7, 365)

  try {
    const leaderboard = await getTopVideosLeaderboard(
      organizationId,
      limit,
      days,
    )
    return c.json(leaderboard)
  } catch (error) {
    console.error('Top videos error:', error)
    return c.json({ error: 'Failed to fetch top videos' }, 500)
  }
})

export default app

// CLickhouse schema (updated with organization_id)
/* -- 1. Create the Database
CREATE DATABASE IF NOT EXISTS analytics;

-- 2. Create the Raw Events Table (Ingest)
CREATE TABLE analytics.video_events_raw (
  -- Metadata
  event LowCardinality(String),
  ts DateTime64(3),
  received_at DateTime64(3) CODEC(Delta, ZSTD(1)),

  -- IDs
  video_id UUID,
  session_id UUID,
  user_id Nullable(String) CODEC(ZSTD(1)),
  organization_id String,

  -- Metrics
  current_time Float32 DEFAULT 0,
  duration Float32 DEFAULT 0,
  watched_delta Float32 DEFAULT 0,

  -- Dimensions
  country LowCardinality(String),
  device LowCardinality(String),
  browser LowCardinality(String),
  error_code LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (video_id, session_id, ts, received_at)
TTL ts + INTERVAL 3 MONTH;

-- 3. Create the Summary Table (Aggregates)
CREATE TABLE analytics.video_session_summary
(
    -- Primary Keys
    video_id UUID,
    session_id UUID,
    user_id Nullable(String),
    organization_id SimpleAggregateFunction(any, String),

    -- Aggregates
    started_at SimpleAggregateFunction(min, DateTime64(3)),
    ended_at SimpleAggregateFunction(max, DateTime64(3)),
    
    -- FIXED: Using Float64 to prevent mismatch errors
    watch_seconds SimpleAggregateFunction(sum, Float64),
    max_position SimpleAggregateFunction(max, Float32),
    
    event_count SimpleAggregateFunction(sum, UInt64),
    error_count SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (video_id, session_id);

-- 4. Create the Automation (Materialized View)
CREATE MATERIALIZED VIEW analytics.video_session_summary_mv 
TO analytics.video_session_summary
AS SELECT
    video_id,
    session_id,
    any(user_id) as user_id,
    any(organization_id) as organization_id,

    min(ts) as started_at,
    max(ts) as ended_at,
    
    -- Summing the deltas
    sum(watched_delta) as watch_seconds,
    max(current_time) as max_position,
    
    count() as event_count,
    countIf(error_code != '') as error_count

FROM analytics.video_events_raw
GROUP BY video_id, session_id; */

/* Video Analytics Page, the "Buffering Signals" card shows 66.7%.

    Context: This means 2 out of 3 sessions had a "seek" event (which you are using as a proxy for buffering or engagement).

    Refinement: "Seeking" isn't always "Buffering."

        Buffering: User waits for video to load (bad).

        Seeking: User skips ahead (neutral/behavioral).

        Correction: In the future, if your player emits a specific buffer_start / buffer_end event, log that separately in ClickHouse. For now, rename "Buffering Signals" to "Seek Rate" to be more precise, or keep it if you are sure your player only logs seek events during stalls. */
