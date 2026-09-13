/**
 * Cloudflare Workers composition root.
 *
 * Bindings are the environment here: they arrive as the second argument to
 * `fetch`, per invocation. Everything isolate-scoped (the resolved config, the
 * database client, the rate limiters) is built once per isolate and reused,
 * because building it per request would re-parse the environment and drop the
 * limiters' connection state on every call.
 *
 * `background` is the exception: it wraps the invocation's `ExecutionContext`,
 * so it is bound per request by `withRequestContext`. That split is why this
 * module returns a `WorkersIsolateRuntime` without `background` rather than a
 * complete `RuntimeCapabilities`.
 */

import { createLogger } from '../lib/logger'
import { createAuth } from '../lib/auth'
import { createDb, db, installDb, unconfiguredDb } from '../lib/database'
import { createR2Client, installR2, r2 } from '../utils/R2'
import { createRateLimiterFactory } from '../lib/rateLimit'
import type { EnvLike } from '../lib/config'
import { stringBindings } from './bindings'
import { fatalProblems, resolveDeployment } from './deployment'
import { workersBackground } from './background'
import { workersAnalyticsEngine } from './analytics'
import type { RuntimeCapabilities, WaitUntilLike } from './types'
import type { Bindings } from '../types'

/**
 * Capabilities plus the boot log.
 *
 * A complete `RuntimeCapabilities` — `background` is present but is a fail-loud
 * stand-in, because the real runner needs the invocation's ExecutionContext. The
 * app's first middleware swaps in the per-request version via `forRequest`, so
 * the stand-in is only reachable if something schedules background work outside
 * a request, which is a wiring bug worth an exception rather than a silent drop.
 */
export type WorkersIsolateRuntime = RuntimeCapabilities

type WorkersIsolateBase = Omit<WorkersIsolateRuntime, 'background' | 'forRequest'>

let cached: WorkersIsolateRuntime | null = null
let cachedFor: unknown = null

/**
 * The isolate's capabilities.
 *
 * Memoised on the bindings object: Workers hands the same object to every
 * invocation in an isolate, so the first request pays for resolution and the
 * rest reuse it. A different object (which is what a test does) rebuilds.
 */
export function getWorkersRuntime(bindings: Bindings): WorkersIsolateRuntime {
  if (cached && cachedFor === bindings) {
    return cached
  }

  const env: EnvLike = stringBindings(bindings as unknown as Record<string, unknown>)
  const dataset = bindings?.PLAYBACK_ANALYTICS
  const resolution = resolveDeployment(env, 'workers', {
    hasPlaybackAnalyticsBinding: Boolean(dataset),
  })
  const { config, shape, logLevel, rateLimit, problems, advisories } = resolution
  const logger = createLogger({ level: logLevel })

  // See the note in runtime/node.ts: the handle must always exist.
  const databaseUrl = env['DATABASE_URL']
  installDb(databaseUrl ? createDb(databaseUrl, shape.dbTransport) : unconfiguredDb())

  const accountId = env['ACCOUNT_ID']
  const accessKeyId = env['R2_ACCESS_KEY_ID']
  const secretAccessKey = env['R2_SECRET_ACCESS_KEY']
  if (accountId && accessKeyId && secretAccessKey) {
    installR2(createR2Client({ accountId, accessKeyId, secretAccessKey }))
  }

  const rateLimiter = createRateLimiterFactory(rateLimit, (error, context) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      context,
    )
  })

  const base: WorkersIsolateBase = {
    runtime: 'workers',
    shape,
    config,
    env,
    logLevel,
    db,
    objectStore: r2,
    auth: createAuth(db, config),
    rateLimiter,
    analytics: workersAnalyticsEngine(dataset),
    logger,
    problems,
    advisories,
  }

  cached = {
    ...base,
    background: (_work, label) => {
      throw new Error(
        `Background work "${label}" was scheduled outside a request. The ` +
          'Workers runtime supplies it per invocation via forRequest().',
      )
    },
    forRequest: (ctx) => withRequestContext(base, ctx),
  }
  cachedFor = bindings
  return cached
}

/** Drop the memoised isolate runtime. Tests only. */
export function resetWorkersRuntime(): void {
  cached = null
  cachedFor = null
}

/** Bind this invocation's background runner onto the isolate capabilities. */
export function withRequestContext(
  isolate: WorkersIsolateBase,
  ctx: WaitUntilLike,
): RuntimeCapabilities {
  return { ...isolate, background: workersBackground(ctx) }
}

export { fatalProblems }
