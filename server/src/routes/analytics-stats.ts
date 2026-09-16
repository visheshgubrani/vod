import { Context, Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { db } from '../lib/database'
import {
  analyticsErrorDetail,
  escapeSqlString,
  getAnalyticsConfig,
  parseIntWithBounds,
  parseOptionalIntWithBounds,
  queryAnalyticsEngine,
} from '../lib/analytics-engine'
import {
  contentScoreSql,
  dailyViewsSql,
  demographicsSql,
  generalSql,
  orgDemographicsSql,
  orgGrowthSql,
  orgHeroStatsSql,
  retentionSql,
  techHealthSeekSql,
  techHealthSummarySql,
  techHealthTopErrorsSql,
  topVideosSql,
} from '../lib/playbackAnalyticsSql'
import { requireAuth } from '../middleware/auth'
import type { Bindings } from '../types'

const app = new Hono<{ Bindings: Bindings }>()
app.use('/*', requireAuth)

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateVideoId(videoId: string): boolean {
  return UUID_REGEX.test(videoId)
}

async function isVideoOwnedByOrganization(
  organizationId: string,
  videoId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: video.id })
    .from(video)
    .where(and(notDeleted, eq(video.id, videoId), eq(video.organizationId, organizationId)))
    .limit(1)

  return rows.length > 0
}

/**
 * The failure response for every endpoint below.
 *
 * Analytics Engine rejects a query at parse time with a 422 whose body is the
 * only description of what is wrong with it ("the 2nd and 3rd arguments to IF()
 * ..."). That text used to stay in the server console, so a dashboard consumer
 * saw an unexplained 500; `analyticsErrorDetail` carries it to the caller as
 * `detail`, which is the reason our own SQL was refused and contains no secret.
 */
function analyticsFailure(c: Context, error: unknown, message: string) {
  console.error(`${message}:`, error)
  return c.json({ error: message, ...analyticsErrorDetail(error) }, 500)
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

function getConfigOrError(c: Context) {
  const config = getAnalyticsConfig(c.var.runtime.config)
  if (!config) {
    return {
      config: null,
      errorResponse: c.json(
        {
          error: 'Playback analytics not configured',
          message: 'Missing ACCOUNT_ID or CLOUDFLARE_ANALYTICS_TOKEN',
        },
        501,
      ),
    }
  }
  return { config, errorResponse: null }
}

// =============================================================================
// 1. General Stats (Hero Cards)
// =============================================================================
app.get('/general', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  try {
    const videoId = escapeSqlString(validated.videoId)
    const rows = await queryAnalyticsEngine<{
      views: number
      unique_views: number
      total_watch_time: number
      error_events: number
      total_events: number
    }>(generalSql(videoId), config.accountId, config.apiToken)

    const row = rows[0] || {
      views: 0,
      unique_views: 0,
      total_watch_time: 0,
      error_events: 0,
      total_events: 0,
    }

    const views = Number(row.views) || 0
    const uniqueViews = Number(row.unique_views) || 0
    const totalWatchTime = Number(row.total_watch_time) || 0
    const totalEvents = Number(row.total_events) || 0
    const errorEvents = Number(row.error_events) || 0

    return c.json({
      views,
      uniqueViews,
      totalWatchTime,
      avgWatchTime: views > 0 ? totalWatchTime / views : 0,
      errorRate: totalEvents > 0 ? errorEvents / totalEvents : 0,
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch general stats')
  }
})

// =============================================================================
// 2. Retention Graph (simplified MVP — play events by time bucket)
// =============================================================================
app.get('/retention', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  try {
    const videoId = escapeSqlString(validated.videoId)
    const rows = await queryAnalyticsEngine<{
      bucket: number
      viewers: number
    }>(retentionSql(videoId), config.accountId, config.apiToken)

    return c.json(
      rows.map((r) => ({
        bucket: Number(r.bucket) || 0,
        viewers: Number(r.viewers) || 0,
      })),
    )
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch retention data')
  }
})

// =============================================================================
// 3. Views Over Time (Daily Trend)
// =============================================================================
app.get('/daily-views', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  try {
    const videoId = escapeSqlString(validated.videoId)
    const rows = await queryAnalyticsEngine<{
      date: string
      views: number
      total_watch_time: number
    }>(dailyViewsSql(videoId), config.accountId, config.apiToken)

    return c.json(
      rows.map((r) => ({
        date: r.date,
        views: Number(r.views) || 0,
        totalWatchTime: Number(r.total_watch_time) || 0,
      })),
    )
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch daily views')
  }
})

// =============================================================================
// 4. Demographics (Geo & Device)
// =============================================================================
app.get('/demographics', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  try {
    const videoId = escapeSqlString(validated.videoId)
    const { countries: countriesSql, devices: devicesSql } = demographicsSql(videoId)
    const [countries, devices] = await Promise.all([
      queryAnalyticsEngine<{ country: string; viewers: number }>(
        countriesSql,
        config.accountId,
        config.apiToken,
      ),
      queryAnalyticsEngine<{ device: string; viewers: number }>(
        devicesSql,
        config.accountId,
        config.apiToken,
      ),
    ])

    return c.json({
      countries: countries.map((r) => ({
        country: r.country || 'unknown',
        viewers: Number(r.viewers) || 0,
      })),
      devices: devices.map((r) => ({
        device: r.device || 'unknown',
        viewers: Number(r.viewers) || 0,
      })),
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch demographics')
  }
})

// =============================================================================
// 5. Video Content Score (MVP — no peak concurrents / completion rate)
// =============================================================================
app.get('/video/content-score', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  try {
    const videoRow = await db
      .select({ duration: video.duration })
      .from(video)
      .where(and(notDeleted, eq(video.id, validated.videoId)))
      .limit(1)

    const durationSeconds = Number(videoRow[0]?.duration) || 0
    const videoId = escapeSqlString(validated.videoId)

    const rows = await queryAnalyticsEngine<{
      total_sessions: number
      unique_viewers: number
      total_watch_seconds: number
      avg_watch_seconds: number
    }>(contentScoreSql(videoId), config.accountId, config.apiToken)

    const score = rows[0] || {
      total_sessions: 0,
      unique_viewers: 0,
      total_watch_seconds: 0,
      avg_watch_seconds: 0,
    }

    return c.json({
      totalSessions: Number(score.total_sessions) || 0,
      uniqueViewers: Number(score.unique_viewers) || 0,
      avgWatchSeconds: Number(score.avg_watch_seconds) || 0,
      totalWatchSeconds: Number(score.total_watch_seconds) || 0,
      completionRate: 0,
      completionRatePercent: 0,
      completionRateAvailable: false,
      peakConcurrents: 0,
      peakConcurrentsAvailable: false,
      durationSeconds,
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch video content score')
  }
})

// =============================================================================
// 6. Video Retention Curve (stub — requires ClickHouse/Tinybird later)
// =============================================================================
app.get('/video/retention-curve', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  return c.json({
    totalSessions: 0,
    curve: [],
    comingSoon: true,
    message: 'Detailed retention curves require advanced analytics (coming soon)',
  })
})

// =============================================================================
// 7. Video Tech Health (MVP)
// =============================================================================
app.get('/video/tech-health', async (c) => {
  const validated = await getValidatedOwnedVideoId(c)
  if (validated.errorResponse) return validated.errorResponse

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  try {
    const videoId = escapeSqlString(validated.videoId)

    const [summaryRows, seekRows, topErrorsRows] = await Promise.all([
      queryAnalyticsEngine<{
        total_sessions: number
        total_events: number
        error_events: number
        sessions_with_errors: number
      }>(techHealthSummarySql(videoId), config.accountId, config.apiToken),
      queryAnalyticsEngine<{
        seek_events: number
        sessions_with_seek: number
        raw_total_sessions: number
      }>(techHealthSeekSql(videoId), config.accountId, config.apiToken),
      queryAnalyticsEngine<{ error_code: string; count: number }>(
        techHealthTopErrorsSql(videoId),
        config.accountId,
        config.apiToken,
      ),
    ])

    const summary = summaryRows[0] || {
      total_sessions: 0,
      total_events: 0,
      error_events: 0,
      sessions_with_errors: 0,
    }
    const seek = seekRows[0] || {
      seek_events: 0,
      sessions_with_seek: 0,
      raw_total_sessions: 0,
    }

    const totalSessions = Number(summary.total_sessions) || 0
    const totalEvents = Number(summary.total_events) || 0
    const errorEvents = Number(summary.error_events) || 0
    const sessionsWithErrors = Number(summary.sessions_with_errors) || 0
    const sessionsWithSeek = Number(seek.sessions_with_seek) || 0
    const rawTotalSessions = Number(seek.raw_total_sessions) || 0
    const errorEventRate = totalEvents > 0 ? errorEvents / totalEvents : 0
    const sessionErrorRate =
      totalSessions > 0 ? sessionsWithErrors / totalSessions : 0
    const bufferingSessionRate =
      rawTotalSessions > 0 ? sessionsWithSeek / rawTotalSessions : 0

    return c.json({
      totalSessions,
      totalEvents,
      totalErrors: errorEvents,
      sessionsWithErrors,
      errorEventRate,
      errorEventRatePercent: errorEventRate * 100,
      sessionErrorRate,
      sessionErrorRatePercent: sessionErrorRate * 100,
      seekEvents: Number(seek.seek_events) || 0,
      sessionsWithSeek,
      bufferingSessionRate,
      bufferingSessionRatePercent: bufferingSessionRate * 100,
      topErrors: topErrorsRows.map((row) => ({
        code: row.error_code,
        count: Number(row.count) || 0,
      })),
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch video tech health')
  }
})

// =============================================================================
// 8. Organization Hero Stats
// =============================================================================
app.get('/organization/hero-stats', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  const days = parseOptionalIntWithBounds(c.req.query('days'), 7, 365)

  try {
    const orgId = escapeSqlString(organizationId)
    const rows = await queryAnalyticsEngine<{
      total_views: number
      total_watch_seconds: number
      unique_viewers: number
      error_events: number
      total_events: number
    }>(orgHeroStatsSql(orgId, days), config.accountId, config.apiToken)

    const row = rows[0] || {
      total_views: 0,
      total_watch_seconds: 0,
      unique_viewers: 0,
      error_events: 0,
      total_events: 0,
    }

    const totalWatchSeconds = Number(row.total_watch_seconds) || 0
    const totalEvents = Number(row.total_events) || 0
    const errorEvents = Number(row.error_events) || 0
    const errorRate = totalEvents > 0 ? errorEvents / totalEvents : 0

    return c.json({
      days,
      totalViews: Number(row.total_views) || 0,
      watchTimeHours: totalWatchSeconds / 3600,
      watchTimeSeconds: totalWatchSeconds,
      uniqueViewers: Number(row.unique_viewers) || 0,
      errorRate,
      errorRatePercent: errorRate * 100,
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch organization hero stats')
  }
})

// =============================================================================
// 9. Organization Growth
// =============================================================================
app.get('/organization/growth', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  const days = parseIntWithBounds(c.req.query('days'), 30, 7, 365)

  try {
    const orgId = escapeSqlString(organizationId)
    const rows = await queryAnalyticsEngine<{
      date: string
      views: number
      unique_viewers: number
      watch_seconds: number
    }>(orgGrowthSql(orgId, days), config.accountId, config.apiToken)

    return c.json({
      days,
      timeline: rows.map((row) => {
        const watchSeconds = Number(row.watch_seconds) || 0
        return {
          date: row.date,
          views: Number(row.views) || 0,
          uniqueViewers: Number(row.unique_viewers) || 0,
          watchTimeSeconds: watchSeconds,
          watchTimeHours: watchSeconds / 3600,
        }
      }),
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch organization growth data')
  }
})

// =============================================================================
// 10. Organization Demographics
// =============================================================================
app.get('/organization/demographics', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  const days = parseIntWithBounds(c.req.query('days'), 30, 7, 365)

  try {
    const orgId = escapeSqlString(organizationId)
    const { countries: countriesSql, devices: devicesSql } = orgDemographicsSql(orgId, days)
    const [countries, devices] = await Promise.all([
      queryAnalyticsEngine<{
        country: string
        viewers: number
        sessions: number
      }>(countriesSql, config.accountId, config.apiToken),
      queryAnalyticsEngine<{
        device_type: string
        viewers: number
        sessions: number
      }>(devicesSql, config.accountId, config.apiToken),
    ])

    return c.json({
      days,
      countries: countries.map((row) => ({
        country: row.country,
        viewers: Number(row.viewers) || 0,
        sessions: Number(row.sessions) || 0,
      })),
      devices: devices.map((row) => ({
        device: row.device_type || 'unknown',
        viewers: Number(row.viewers) || 0,
        sessions: Number(row.sessions) || 0,
      })),
    })
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch organization demographics')
  }
})

// =============================================================================
// 11. Top Videos Leaderboard
// =============================================================================
async function getTopVideosLeaderboard(
  organizationId: string,
  limit: number,
  days: number | null,
  accountId: string,
  apiToken: string,
) {
  const orgId = escapeSqlString(organizationId)
  const results = await queryAnalyticsEngine<{
    video_id: string
    views: number
    unique_viewers: number
    total_watch_seconds: number
    error_events: number
    total_events: number
  }>(topVideosSql(orgId, days, limit), accountId, apiToken)

  if (results.length === 0) return []

  const videoRows = await db
    .select({ id: video.id, title: video.title })
    .from(video)
    .where(and(notDeleted, eq(video.organizationId, organizationId)))

  const titleByVideoId = new Map<string, string>(
    videoRows.map((row) => [row.id, row.title] as const),
  )

  return results.map((row) => {
    const totalEvents = Number(row.total_events) || 0
    const errorEvents = Number(row.error_events) || 0
    const errorRate = totalEvents > 0 ? errorEvents / totalEvents : 0

    return {
      videoId: row.video_id,
      title: titleByVideoId.get(row.video_id) || 'Unknown',
      views: Number(row.views) || 0,
      uniqueViewers: Number(row.unique_viewers) || 0,
      totalWatchSeconds: Number(row.total_watch_seconds) || 0,
      totalWatchHours: (Number(row.total_watch_seconds) || 0) / 3600,
      errorRate,
      errorRatePercent: errorRate * 100,
    }
  })
}

app.get('/organization/top-videos', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  const limit = parseIntWithBounds(c.req.query('limit'), 10, 1, 50)
  const days = parseOptionalIntWithBounds(c.req.query('days'), 7, 365)

  try {
    const leaderboard = await getTopVideosLeaderboard(
      organizationId,
      limit,
      days,
      config.accountId,
      config.apiToken,
    )
    return c.json(leaderboard)
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch organization top videos')
  }
})

app.get('/top-videos', async (c) => {
  const organizationId = requireActiveOrganizationId(c)
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const { config, errorResponse } = getConfigOrError(c)
  if (errorResponse || !config) return errorResponse

  const limit = parseIntWithBounds(c.req.query('limit'), 10, 1, 50)
  const days = parseOptionalIntWithBounds(c.req.query('days'), 7, 365)

  try {
    const leaderboard = await getTopVideosLeaderboard(
      organizationId,
      limit,
      days,
      config.accountId,
      config.apiToken,
    )
    return c.json(leaderboard)
  } catch (error) {
    return analyticsFailure(c, error, 'Failed to fetch top videos')
  }
})

export default app
