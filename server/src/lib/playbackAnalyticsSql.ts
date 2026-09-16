/**
 * Every read query the analytics dashboard runs against the Analytics Engine
 * SQL API, as pure functions.
 *
 * They live here rather than inline in `routes/analytics-stats.ts` because a
 * query string is only correct against *Cloudflare's* dialect, and nothing in
 * the route can prove that — an unparseable query looks exactly like a working
 * one until a request runs it. As exported builders the whole set is testable:
 * `tests/lib/playbackAnalyticsSql.test.ts` asserts the dialect rules that a
 * ClickHouse port breaks, and `tests/lib/analyticsEngineSql.live.test.ts` sends
 * each one to the real API.
 *
 * Three of these were ported from ClickHouse and were rejected by Analytics
 * Engine with a 422 (see the dialect note in `analytics-engine.ts`):
 * `contentScoreSql` (Integer vs Double), `techHealthSummarySql` and
 * `techHealthSeekSql` (String vs Null). The rest parsed unchanged.
 *
 * The field layout being read is documented in `analytics-engine.ts`; the write
 * side is `runtime/analytics.ts`. Callers pass ids through `escapeSqlString` and
 * ages through the bounded integer parsers, so the only interpolated strings
 * here are escaped literals and numbers.
 */

import { VIEWER_IDENTITY_SQL, sessionIdOrNone } from './analytics-engine'

/**
 * Age filter for the organization queries. `null` means "all retained data" and
 * omits the clause entirely — Analytics Engine has its own retention window, so
 * an unbounded query is still bounded by the platform.
 */
export function daysFilter(days: number | null): string {
  if (days === null) return ''
  return `AND timestamp > NOW() - INTERVAL '${days}' DAY`
}

// =============================================================================
// Per-video
// =============================================================================

/** Hero cards: views, unique viewers, watch time, error rate. */
export function generalSql(videoId: string): string {
  return `SELECT
        sum(if(blob1 = 'play', _sample_interval, 0)) as views,
        count(DISTINCT ${VIEWER_IDENTITY_SQL}) as unique_views,
        sum(_sample_interval * double1) as total_watch_time,
        sum(if(blob1 = 'error', _sample_interval, 0)) as error_events,
        sum(_sample_interval) as total_events
      FROM playback_events
      WHERE blob2 = '${videoId}'`
}

/**
 * Retention graph: watch-time buckets in 5-second steps, so this reads
 * `double2` (currentTime), not `double1` (watchedDelta).
 */
export function retentionSql(videoId: string): string {
  return `SELECT
        floor(double2 / 5) * 5 as bucket,
        count(DISTINCT blob3) as viewers
      FROM playback_events
      WHERE blob2 = '${videoId}'
        AND double1 > 0
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 200`
}

/** Daily view/watch-time trend for one video. */
export function dailyViewsSql(videoId: string): string {
  return `SELECT
        toStartOfDay(timestamp) as date,
        sum(if(blob1 = 'play', _sample_interval, 0)) as views,
        sum(_sample_interval * double1) as total_watch_time
      FROM playback_events
      WHERE blob2 = '${videoId}'
        AND timestamp > NOW() - INTERVAL '30' DAY
      GROUP BY date
      ORDER BY date ASC`
}

/** Top countries and devices for one video. */
export function demographicsSql(videoId: string): { countries: string; devices: string } {
  return {
    countries: `SELECT
          blob4 as country,
          count(DISTINCT ${VIEWER_IDENTITY_SQL}) as viewers
        FROM playback_events
        WHERE blob2 = '${videoId}'
        GROUP BY country
        ORDER BY viewers DESC
        LIMIT 5`,
    devices: `SELECT
          blob5 as device,
          count(DISTINCT ${VIEWER_IDENTITY_SQL}) as viewers
        FROM playback_events
        WHERE blob2 = '${videoId}'
        GROUP BY device
        ORDER BY viewers DESC
        LIMIT 5`,
  }
}

/**
 * Content score: sessions, viewers, watch seconds, average watch seconds.
 *
 * The zero guard is `0.0`, not `0`: `IF()` compares branch types before running,
 * and the division branch is a Double, so an Integer literal is a 422.
 */
export function contentScoreSql(videoId: string): string {
  return `SELECT
        count(DISTINCT blob3) as total_sessions,
        count(DISTINCT ${VIEWER_IDENTITY_SQL}) as unique_viewers,
        sum(_sample_interval * double1) as total_watch_seconds,
        if(count(DISTINCT blob3) = 0, 0.0, sum(_sample_interval * double1) / count(DISTINCT blob3)) as avg_watch_seconds
      FROM playback_events
      WHERE blob2 = '${videoId}'`
}

/**
 * Tech health summary.
 *
 * "Sessions with errors" counts sessions that produced an error event *or*
 * carried an error code, via the sentinel: the ported
 * `count(DISTINCT if(..., blob3, NULL))` is a 422 (String vs Null), and
 * ClickHouse's `nullIf` does not exist here. The sentinel contributes at most
 * one distinct value when nothing matched.
 */
export function techHealthSummarySql(videoId: string): string {
  return `SELECT
          count(DISTINCT blob3) as total_sessions,
          sum(_sample_interval) as total_events,
          sum(if(blob1 = 'error', _sample_interval, 0)) as error_events,
          count(DISTINCT ${sessionIdOrNone(`blob1 = 'error' OR blob7 != ''`)}) as sessions_with_errors
        FROM playback_events
        WHERE blob2 = '${videoId}'`
}

/** Seek/buffering signal, same sentinel rule as the summary. */
export function techHealthSeekSql(videoId: string): string {
  return `SELECT
          sum(if(blob1 = 'seeking', _sample_interval, 0)) as seek_events,
          count(DISTINCT ${sessionIdOrNone(`blob1 = 'seeking'`)}) as sessions_with_seek,
          count(DISTINCT blob3) as raw_total_sessions
        FROM playback_events
        WHERE blob2 = '${videoId}'`
}

/** Most frequent error codes; events without a code are grouped as 'unknown'. */
export function techHealthTopErrorsSql(videoId: string): string {
  return `SELECT
          if(blob7 = '', 'unknown', blob7) as error_code,
          sum(_sample_interval) as count
        FROM playback_events
        WHERE blob2 = '${videoId}'
          AND (blob1 = 'error' OR blob7 != '')
        GROUP BY error_code
        ORDER BY count DESC
        LIMIT 5`
}

// =============================================================================
// Per-organization
// =============================================================================

/** Hero cards for the organization over the last `days` days. */
export function orgHeroStatsSql(organizationId: string, days: number | null): string {
  return `SELECT
        sum(if(blob1 = 'play', _sample_interval, 0)) as total_views,
        sum(_sample_interval * double1) as total_watch_seconds,
        count(DISTINCT ${VIEWER_IDENTITY_SQL}) as unique_viewers,
        sum(if(blob1 = 'error', _sample_interval, 0)) as error_events,
        sum(_sample_interval) as total_events
      FROM playback_events
      WHERE index1 = '${organizationId}'
      ${daysFilter(days)}`
}

/** Daily views/viewers/watch-time for the organization growth chart. */
export function orgGrowthSql(organizationId: string, days: number): string {
  return `SELECT
        toStartOfDay(timestamp) as date,
        sum(if(blob1 = 'play', _sample_interval, 0)) as views,
        count(DISTINCT ${VIEWER_IDENTITY_SQL}) as unique_viewers,
        sum(_sample_interval * double1) as watch_seconds
      FROM playback_events
      WHERE index1 = '${organizationId}'
        AND timestamp > NOW() - INTERVAL '${days}' DAY
      GROUP BY date
      ORDER BY date ASC`
}

/**
 * Organization demographics. Empty country blobs are labelled 'Unknown' with a
 * string-to-string `IF()`; the device list keeps its empty bucket because the
 * route already maps it.
 */
export function orgDemographicsSql(
  organizationId: string,
  days: number,
): { countries: string; devices: string } {
  return {
    countries: `SELECT
          if(blob4 = '', 'Unknown', blob4) as country,
          count(DISTINCT ${VIEWER_IDENTITY_SQL}) as viewers,
          count(DISTINCT blob3) as sessions
        FROM playback_events
        WHERE index1 = '${organizationId}'
          AND timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY country
        ORDER BY viewers DESC
        LIMIT 8`,
    devices: `SELECT
          blob5 as device_type,
          count(DISTINCT ${VIEWER_IDENTITY_SQL}) as viewers,
          count(DISTINCT blob3) as sessions
        FROM playback_events
        WHERE index1 = '${organizationId}'
          AND timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY device_type
        ORDER BY viewers DESC`,
  }
}

/** Leaderboard by views; titles are joined from Postgres by the route. */
export function topVideosSql(
  organizationId: string,
  days: number | null,
  limit: number,
): string {
  return `SELECT
      blob2 as video_id,
      sum(if(blob1 = 'play', _sample_interval, 0)) as views,
      count(DISTINCT ${VIEWER_IDENTITY_SQL}) as unique_viewers,
      sum(_sample_interval * double1) as total_watch_seconds,
      sum(if(blob1 = 'error', _sample_interval, 0)) as error_events,
      sum(_sample_interval) as total_events
    FROM playback_events
    WHERE index1 = '${organizationId}'
    ${daysFilter(days)}
    GROUP BY video_id
    ORDER BY views DESC
    LIMIT ${limit}`
}
