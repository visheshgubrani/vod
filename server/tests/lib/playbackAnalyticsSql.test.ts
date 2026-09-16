import { describe, expect, it } from 'vitest'
import { NO_SESSION_SENTINEL, escapeSqlString, sessionIdOrNone } from '../../src/lib/analytics-engine'
import {
  contentScoreSql,
  dailyViewsSql,
  daysFilter,
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
} from '../../src/lib/playbackAnalyticsSql'

/**
 * Why this suite exists.
 *
 * The read path was ported from ClickHouse to Cloudflare Analytics Engine SQL,
 * and Analytics Engine is a *restricted* ClickHouse dialect: `IF()` demands that
 * its 2nd and 3rd arguments share a type. Three ported queries kept ClickHouse's
 * `NULL` idiom and every request for video content score and video tech health
 * failed with a 422 that no test could see, because the SQL was a string literal
 * inside a route handler:
 *
 *   Input was invalid: the 2nd and 3rd arguments to IF() function must have the
 *   same type but instead had String and Null:
 *   if("blob1" = 'seeking', "blob3", NULL)
 *
 * The repository forbids SQL-substring tests as a *substitute* for running a
 * query, and this is not one: there is no local Analytics Engine to run against.
 * It is the portable half of the guarantee — a parser-shaped rule that holds for
 * every possible result set, whatever the data. `analyticsEngineSql.live.test.ts`
 * covers the other half by sending each of these builders to the real API, and
 * skips when the credentials are absent, which is why this suite has to exist.
 */

const VIDEO = '995d687a-0435-4225-939e-2260f792474c'
const ORG = 'G1ct9tuZwIx7uXTGmGkYjVfyGYiuIqZu'
const VIEWER_IDENTITY = `if(blob8 = '', blob3, blob8)`

/**
 * Every builder the dashboard can run. Keep this list complete: the point of the
 * NULL scan below is that a *new* query cannot reintroduce the defect unnoticed.
 */
const ALL_BUILDERS: Array<[string, string]> = [
  ['general', generalSql(VIDEO)],
  ['retention', retentionSql(VIDEO)],
  ['daily-views', dailyViewsSql(VIDEO)],
  ['demographics/countries', demographicsSql(VIDEO).countries],
  ['demographics/devices', demographicsSql(VIDEO).devices],
  ['content-score', contentScoreSql(VIDEO)],
  ['tech-health/summary', techHealthSummarySql(VIDEO)],
  ['tech-health/seek', techHealthSeekSql(VIDEO)],
  ['tech-health/top-errors', techHealthTopErrorsSql(VIDEO)],
  ['org/hero-stats', orgHeroStatsSql(ORG, 7)],
  ['org/hero-stats (unbounded)', orgHeroStatsSql(ORG, null)],
  ['org/growth', orgGrowthSql(ORG, 30)],
  ['org/demographics/countries', orgDemographicsSql(ORG, 30).countries],
  ['org/demographics/devices', orgDemographicsSql(ORG, 30).devices],
  ['top-videos', topVideosSql(ORG, 7, 10)],
  ['top-videos (unbounded)', topVideosSql(ORG, null, 10)],
]

describe('playback analytics SQL: Cloudflare dialect rules', () => {
  it('never emits the NULL literal, which Analytics Engine rejects inside IF()', () => {
    for (const [name, sql] of ALL_BUILDERS) {
      // A word boundary keeps this from matching identifiers like `ifNull(`.
      expect(sql, `${name} contains a bare NULL`).not.toMatch(/\bNULL\b/)
    }
  })

  it('counts sessions that had an error with a typed sentinel, not NULL', () => {
    // The exact expression the live API accepted, and the one it rejected.
    expect(techHealthSummarySql(VIDEO)).toContain(
      `count(DISTINCT if(blob1 = 'error' OR blob7 != '', blob3, '${NO_SESSION_SENTINEL}')) as sessions_with_errors`,
    )
    expect(techHealthSummarySql(VIDEO)).not.toContain('blob3, NULL')
  })

  it('counts sessions that seeked with a typed sentinel, not NULL', () => {
    expect(techHealthSeekSql(VIDEO)).toContain(
      `count(DISTINCT if(blob1 = 'seeking', blob3, '${NO_SESSION_SENTINEL}')) as sessions_with_seek`,
    )
    expect(techHealthSeekSql(VIDEO)).not.toContain('blob3, NULL')
  })

  it('guards the average watch time with a Double literal, not an Integer', () => {
    // `if(count(...) = 0, 0, <Double>)` is exactly the 422 that broke
    // video content score: Integer and Double in the same IF().
    expect(contentScoreSql(VIDEO)).toContain(
      'if(count(DISTINCT blob3) = 0, 0.0, sum(_sample_interval * double1) / count(DISTINCT blob3)) as avg_watch_seconds',
    )
    expect(contentScoreSql(VIDEO)).not.toContain('= 0, 0, sum(')
  })

  it('keeps both branches of every IF() typed alike', () => {
    // The only IF() that needs a numeric branch is the content-score guard; the
    // rest are string-to-string. Assert the two literal shapes that are legal.
    for (const [name, sql] of ALL_BUILDERS) {
      for (const call of sql.match(/if\([^()]*(?:\([^()]*\)[^()]*)*\)/gi) ?? []) {
        expect(call, `${name}: ${call}`).not.toMatch(/\bNULL\b/)
      }
    }
    expect(techHealthTopErrorsSql(VIDEO)).toContain(`if(blob7 = '', 'unknown', blob7)`)
    expect(orgDemographicsSql(ORG, 30).countries).toContain(`if(blob4 = '', 'Unknown', blob4)`)
    expect(generalSql(VIDEO)).toContain(`count(DISTINCT ${VIEWER_IDENTITY}) as unique_views`)
  })

  it('reads the currentTime double for the retention buckets, not watchedDelta', () => {
    // double2 is currentTime; double1 is watchedDelta. Buckets are positions in
    // the video, so reading double1 would bucket by "seconds watched instead".
    expect(retentionSql(VIDEO)).toContain('floor(double2 / 5) * 5 as bucket')
    expect(retentionSql(VIDEO)).toContain('AND double1 > 0')
  })

  it('scales sampled counts by _sample_interval', () => {
    expect(generalSql(VIDEO)).toContain(`sum(if(blob1 = 'play', _sample_interval, 0)) as views`)
    expect(generalSql(VIDEO)).toContain('sum(_sample_interval * double1) as total_watch_time')
  })
})

describe('sessionIdOrNone', () => {
  it('produces the sentinel branch Analytics Engine accepts', () => {
    expect(sessionIdOrNone(`blob1 = 'error'`)).toBe(
      `if(blob1 = 'error', blob3, '${NO_SESSION_SENTINEL}')`,
    )
  })

  it('uses a sentinel a player-provided sessionId cannot collide with', () => {
    expect(NO_SESSION_SENTINEL).toBe('__cm_none__')
  })
})

describe('query parameters', () => {
  it('omits the age filter only when no window was requested', () => {
    expect(daysFilter(null)).toBe('')
    expect(daysFilter(7)).toBe(`AND timestamp > NOW() - INTERVAL '7' DAY`)
  })

  it('interpolates the limit as a number, never a quoted string', () => {
    expect(topVideosSql(ORG, 7, 10)).toContain('LIMIT 10')
    expect(topVideosSql(ORG, 7, 10)).not.toContain("LIMIT '10'")
  })

  it('escapes an id the way the routes do before interpolating it', () => {
    const hostile = escapeSqlString(`x' OR 1=1 --`)
    expect(hostile).toBe(`x'' OR 1=1 --`)
    expect(generalSql(hostile)).toContain(`WHERE blob2 = 'x'' OR 1=1 --'`)
    expect(generalSql(hostile)).not.toContain(`blob2 = 'x' OR 1=1`)
  })
})
