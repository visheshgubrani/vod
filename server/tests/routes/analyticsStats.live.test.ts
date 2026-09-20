import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installDb } from '../../src/lib/database'
import analyticsStats from '../../src/routes/analytics-stats'
import { createTestRuntime, fullyConfiguredEnv, withRuntime } from '../helpers/runtime'

/**
 * The two endpoints that failed in production, end to end.
 *
 * `playbackAnalyticsSql.test.ts` proves the SQL obeys the dialect's typing rules
 * and `analyticsEngineSql.live.test.ts` proves Analytics Engine accepts it. What
 * neither proves is the thing the dashboard actually experienced: a request to
 * `/api/analytics-stats/video/{content-score,tech-health}` answering **500**
 * because the query inside was rejected. That is a property of the whole route —
 * validation, ownership, query, mapping, response — so this suite runs the real
 * Hono app against the real Analytics Engine and asserts on the HTTP response.
 *
 * Only two things are faked, at seams the route already has:
 *
 * - **Postgres.** The route verifies video ownership and reads the duration
 *   before it queries, and a real database is not what is under test. The fake
 *   handle answers `select().from().where().limit()` with rows the suite chooses,
 *   which also lets one test drive the 404 path.
 * - **The session.** better-auth needs a database and a signed cookie; the
 *   middleware reads `c.var.session.activeOrganizationId`, and a stub returning
 *   exactly that is the contract it depends on.
 *
 * Gated on the analytics credentials like the live SQL suite, because without
 * them these routes answer 501 before they reach a query.
 */

const SQL_ENDPOINT_FRAGMENT = '/analytics_engine/sql'

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

const FILE_ENV = parseEnvFile(resolve(__dirname, '../../.dev.vars'))
const ACCOUNT_ID = process.env.ACCOUNT_ID || FILE_ENV.ACCOUNT_ID || ''
const API_TOKEN = process.env.CLOUDFLARE_ANALYTICS_TOKEN || FILE_ENV.CLOUDFLARE_ANALYTICS_TOKEN || ''

const PLACEHOLDER_ACCOUNT = 'your-cloudflare-account-id'
const PLACEHOLDER_TOKEN = 'your-analytics-api-token'

const hasAnalyticsCredentials = Boolean(
  ACCOUNT_ID &&
    API_TOKEN &&
    ACCOUNT_ID !== PLACEHOLDER_ACCOUNT &&
    API_TOKEN !== PLACEHOLDER_TOKEN,
)

const VIDEO = '995d687a-0435-4225-939e-2260f792474c'
const ORG = 'G1ct9tuZwIx7uXTGmGkYjVfyGYiuIqZu'

/** A drizzle-shaped handle whose terminal await yields `rows`. */
function fakeDb(rows: unknown[]) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'from', 'where', 'limit', 'orderBy']) {
    builder[method] = () => builder
  }
  builder.then = (resolvePromise: (value: unknown[]) => unknown) =>
    Promise.resolve(rows).then(resolvePromise)
  return builder
}

/**
 * A host around the real route app, with a fake `db` handle and a session.
 *
 * The route reads the module-level `db` proxy at call time, so installing the
 * handle immediately before `app.request` is enough — no module reload.
 */
function hostWith(videoRows: unknown[]) {
  installDb(fakeDb(videoRows) as never)

  const runtime = createTestRuntime(
    fullyConfiguredEnv({ ACCOUNT_ID, CLOUDFLARE_ANALYTICS_TOKEN: API_TOKEN }),
    { runtime: 'node' },
  )
  runtime.auth = {
    api: {
      getSession: async () => ({
        user: { id: 'user-1' },
        session: { activeOrganizationId: ORG },
      }),
    },
  } as never

  return withRuntime(analyticsStats, runtime, '/')
}

describe.skipIf(!hasAnalyticsCredentials)('analytics-stats routes against the live Analytics Engine', () => {
  it('answers 200 for video content score instead of 500', async () => {
    const response = await hostWith([{ id: VIDEO, duration: 120 }]).request(
      `/video/content-score?videoId=${VIDEO}`,
    )

    const body = (await response.json()) as Record<string, unknown>
    expect(response.status, JSON.stringify(body)).toBe(200)

    // The response contract the dashboard reads, not just a 200.
    expect(typeof body.totalSessions).toBe('number')
    expect(typeof body.uniqueViewers).toBe('number')
    expect(typeof body.avgWatchSeconds).toBe('number')
    expect(Number.isNaN(body.avgWatchSeconds as number)).toBe(false)
    expect(typeof body.totalWatchSeconds).toBe('number')
    expect(body.durationSeconds).toBe(120)
  })

  it('answers 200 for video tech health with every section populated', async () => {
    const response = await hostWith([{ id: VIDEO, duration: 120 }]).request(
      `/video/tech-health?videoId=${VIDEO}`,
    )

    const body = (await response.json()) as Record<string, unknown>
    expect(response.status, JSON.stringify(body)).toBe(200)

    expect(typeof body.totalSessions).toBe('number')
    expect(typeof body.totalEvents).toBe('number')
    expect(typeof body.sessionsWithErrors).toBe('number')
    expect(typeof body.seekEvents).toBe('number')
    expect(typeof body.bufferingSessionRate).toBe('number')
    expect(Number.isNaN(body.bufferingSessionRate as number)).toBe(false)
    expect(Array.isArray(body.topErrors)).toBe(true)
  })

  it('still refuses a video the organization does not own', async () => {
    // Proves the 200s above came from the analytics path rather than a stub that
    // never consulted ownership: with no owned row, the route stops at 404.
    const response = await hostWith([]).request(`/video/content-score?videoId=${VIDEO}`)

    expect(response.status).toBe(404)
  })

  it('reports a rejected query as a 500 with the upstream reason attached', async () => {
    const host = hostWith([{ id: VIDEO, duration: 120 }])

    // A deliberately refused query, to prove the reason survives to the caller —
    // the detail that used to exist only in the server console.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) =>
      String(url).includes(SQL_ENDPOINT_FRAGMENT)
        ? new Response('Input was invalid: the 2nd and 3rd arguments to IF()', { status: 422 })
        : originalFetch(url as never)) as typeof fetch

    try {
      const response = await host.request(`/video/tech-health?videoId=${VIDEO}`)
      const body = (await response.json()) as { error: string; detail?: string }

      expect(response.status).toBe(500)
      expect(body.error).toBe('Failed to fetch video tech health')
      expect(body.detail).toContain('the 2nd and 3rd arguments to IF()')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
