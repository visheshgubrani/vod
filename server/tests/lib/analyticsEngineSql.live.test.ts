import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
} from '../../src/lib/playbackAnalyticsSql'

/**
 * The queries, sent to the real Analytics Engine SQL API.
 *
 * Why this exists next to the pure dialect suite: Analytics Engine rejects a
 * query at *parse* time, so the API is the only oracle for "does this SQL run".
 * The ClickHouse port that broke video content score and video tech health had
 * every other property of a working query — correct columns, correct aliases,
 * plausible SQL — and failed only when a request reached the parser. A few
 * seconds against the API is what catches that before a user does.
 *
 * Gated like the real-database suites: `ACCOUNT_ID` and
 * `CLOUDFLARE_ANALYTICS_TOKEN` come from the environment, falling back to
 * `server/.dev.vars` for a developer running this by hand. Without them the
 * suite skips, which is why CI cannot prove the dialect — see
 * docs/known-gaps.md.
 *
 * Every query filters on a fixed, non-existent id, so a run reads a bounded
 * slice of the dataset and never returns a tenant's data. That also means the
 * *result* cannot be predicted here (the dataset may legitimately be empty), so
 * the assertion is on what the API proves about the statement: it parsed, and it
 * came back under the expected column names. That is exactly the property the
 * port broke.
 *
 * Run it with:  pnpm --filter vod-api exec vitest run tests/lib/analyticsEngineSql
 */

const SQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts'

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const [, key, raw] = match
    out[key] = raw.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

// Only the two analytics variables are read: the rest of .dev.vars is none of
// this suite's business and must not reach the process environment.
const FILE_ENV = parseEnvFile(resolve(__dirname, '../../.dev.vars'))
const ACCOUNT_ID = process.env.ACCOUNT_ID || FILE_ENV.ACCOUNT_ID || ''
const API_TOKEN = process.env.CLOUDFLARE_ANALYTICS_TOKEN || FILE_ENV.CLOUDFLARE_ANALYTICS_TOKEN || ''

const hasAnalyticsCredentials = Boolean(ACCOUNT_ID && API_TOKEN)

const VIDEO = '995d687a-0435-4225-939e-2260f792474c'
const ORG = 'G1ct9tuZwIx7uXTGmGkYjVfyGYiuIqZu'

async function run(sql: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${SQL_ENDPOINT}/${ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: sql,
  })
  return { status: response.status, body: await response.text() }
}

describe.skipIf(!hasAnalyticsCredentials)('Analytics Engine SQL: live parse check', () => {
  it('still refuses the NULL-in-IF() idiom, so the checks below have teeth', async () => {
    const { status, body } = await run(
      `SELECT count(DISTINCT if(blob1 = 'seeking', blob3, NULL)) as x FROM playback_events`,
    )

    expect(status).toBe(422)
    expect(body).toContain('must have the same type')
  })

  const queries: Array<[string, string[]]> = [
    ['general', ['views', 'unique_views', 'total_watch_time', 'error_events', 'total_events']],
    ['retention', ['bucket', 'viewers']],
    ['daily-views', ['date', 'views', 'total_watch_time']],
    ['demographics/countries', ['country', 'viewers']],
    ['demographics/devices', ['device', 'viewers']],
    ['content-score', ['total_sessions', 'unique_viewers', 'avg_watch_seconds', 'total_watch_seconds']],
    ['tech-health/summary', ['total_sessions', 'total_events', 'sessions_with_errors']],
    ['tech-health/seek', ['seek_events', 'sessions_with_seek', 'raw_total_sessions']],
    ['tech-health/top-errors', ['error_code', 'count']],
    ['org/hero-stats', ['total_views', 'total_watch_seconds', 'unique_viewers']],
    ['org/growth', ['date', 'views', 'unique_viewers', 'watch_seconds']],
    ['org/demographics/countries', ['country', 'viewers', 'sessions']],
    ['org/demographics/devices', ['device_type', 'viewers', 'sessions']],
    ['top-videos', ['video_id', 'views', 'total_watch_seconds']],
  ]

  const sqlByLabel: Array<[string, string]> = [
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

  const expectedColumns = new Map(queries)

  for (const [label, sql] of sqlByLabel) {
    it(`parses and runs: ${label}`, async () => {
      const { status, body } = await run(sql)

      expect(status, `${label} was refused: ${body}`).toBe(200)

      // A query the API understood answers with a `data` array whose `meta`
      // names every alias the route reads. Grouped queries return no rows while
      // the dataset is empty — the column contract is still declared, which is
      // what proves the statement itself was accepted.
      const result = JSON.parse(body) as { data: unknown[]; meta?: Array<{ name: string }> }
      expect(Array.isArray(result.data), `${label} returned no data array: ${body}`).toBe(true)

      const columns = (result.meta ?? []).map((column) => column.name)
      const expected = expectedColumns.get(label.replace(' (unbounded)', '')) ?? []

      for (const column of expected) {
        expect(columns, `${label} is missing the '${column}' column`).toContain(column)
      }
    })
  }
})
