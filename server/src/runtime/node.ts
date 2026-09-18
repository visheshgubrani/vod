/**
 * Node composition root (Docker / VPS / local development).
 *
 * Reads the environment exactly once, decides nothing, and wires the
 * capabilities the app asks for. Everything runtime-specific about Node lives
 * here:
 *
 *  - `process.env` is the binding source
 *  - background work is tracked instead of `ctx.waitUntil`
 *  - playback telemetry is forwarded to the delivery worker when analytics is
 *    enabled and the ingest secret is present
 *
 * The database and R2 clients are installed (not handed around) because ~30
 * existing call sites import the `db`/`r2` handles; installing removes the
 * ambient-environment fallback that made those handles resolve credentials from
 * the wrong place, without rewriting every call site. When credentials are
 * absent the handle is still the handle — the first query throws a clear error,
 * which is what "the API boots without a database" has always meant.
 */

import type { Hono } from 'hono'
import { createLogger } from '../lib/logger'
import { createAuth } from '../lib/auth'
import { createDb, db, installDb, unconfiguredDb } from '../lib/database'
import { createR2Client, installR2, r2 } from '../utils/R2'
import { createRateLimiterFactory } from '../lib/rateLimit'
import type { EnvLike } from '../lib/config'
import { fatalProblems, resolveDeployment } from './deployment'
import { nodeBackground, nodeExecutionContext } from './background'
import { deliveryAnalyticsForwarder, nullAnalytics } from './analytics'
import type { RuntimeCapabilities } from './types'
import type { Bindings } from '../types'

/** The Node capabilities, including the boot log the entrypoint prints. */
export type NodeRuntime = RuntimeCapabilities

function trimmed(env: EnvLike, key: string): string | null {
  const raw = env[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export function createNodeRuntime(env: EnvLike): NodeRuntime {
  const resolution = resolveDeployment(env)
  const { config, shape, logLevel, rateLimit, problems, advisories } = resolution
  const logger = createLogger({ level: logLevel })

  // Always install: better-auth's drizzle adapter reads the handle while the
  // auth instance is constructed, so "no database configured" needs a handle
  // that constructs and fails precisely on first use — see `unconfiguredDb`.
  const databaseUrl = trimmed(env, 'DATABASE_URL')
  installDb(databaseUrl ? createDb(databaseUrl) : unconfiguredDb())

  const accountId = trimmed(env, 'ACCOUNT_ID')
  const accessKeyId = trimmed(env, 'R2_ACCESS_KEY_ID')
  const secretAccessKey = trimmed(env, 'R2_SECRET_ACCESS_KEY')
  if (accountId && accessKeyId && secretAccessKey) {
    installR2(createR2Client({ accountId, accessKeyId, secretAccessKey }))
  }

  const rateLimiter = createRateLimiterFactory(rateLimit, (error, context) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      context,
    )
  })

  const analytics =
    shape.analyticsWrite === 'delivery-worker' && config.deliveryUrl && config.analyticsIngestSecret
      ? deliveryAnalyticsForwarder({
          deliveryUrl: config.deliveryUrl,
          ingestSecret: config.analyticsIngestSecret,
        })
      : nullAnalytics

  return {
    runtime: 'node',
    shape,
    config,
    env,
    logLevel,
    db,
    objectStore: r2,
    auth: createAuth(db, config),
    rateLimiter,
    analytics,
    background: nodeBackground(),
    logger,
    problems,
    advisories,
  }
}

/**
 * Hand a request to the app the way the Node entrypoint must.
 *
 * The third argument of `app.fetch` is load-bearing: it is what Hono installs as
 * `c.executionCtx`, and the routes read it to dispatch tenant webhooks and to
 * schedule post-response work. Node has no platform object to pass, so this
 * factory supplies the stand-in — in one place, used by the entrypoint and by
 * the suites, so that "Node serves requests with a context" is a property of
 * the runtime rather than a line each entrypoint has to remember.
 */
export function createNodeRequestHandler(
  app: Hono<{ Bindings: Bindings }>,
  runtime: NodeRuntime,
): (request: Request) => Response | Promise<Response> {
  // One context for the process: `waitUntil` holds no per-request state, and a
  // fresh object per request would only invite someone to store some there.
  const executionCtx = {
    ...nodeExecutionContext(),
    passThroughOnException: () => {},
    props: {},
  }
  const env = runtime.env as Bindings
  return (request) => app.fetch(request, env, executionCtx)
}

export { fatalProblems }
