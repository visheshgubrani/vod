/**
 * Test composition root.
 *
 * Route modules reach configuration, clients, the limiter, the analytics sink and
 * background work through `c.var.runtime`, which `createApp` installs. A suite
 * that mounts a single route app needs the same thing, and it should be able to
 * *choose* the deployment shape it is testing — including a Workers-shaped one,
 * which was impossible before the runtime seam existed because the Workers path
 * only existed as a side effect of ambient `process.env`.
 *
 * Deliberately side-effect free: it does not install a database or an R2 client.
 * Suites that need a real database install one through `createTestDb`; a second
 * install here would silently replace it.
 */

import { Hono } from 'hono'
import { createAuth } from '../../src/lib/auth'
import { db, hasInstalledDb, installDb, unconfiguredDb } from '../../src/lib/database'
import { r2 } from '../../src/utils/R2'
import { createLogger } from '../../src/lib/logger'
import { createRateLimiterFactory, type RateLimiterFactory } from '../../src/lib/rateLimit'
import { resolveDeployment } from '../../src/runtime/deployment'
import { nodeBackground } from '../../src/runtime/background'
import { nullAnalytics } from '../../src/runtime/analytics'
import type { EnvLike, RuntimeName } from '../../src/lib/config'
import type { AnalyticsPort, RuntimeCapabilities } from '../../src/runtime/types'

export type TestRuntimeOptions = {
  /** Defaults to `node`; pass `workers` to exercise that shape. */
  runtime?: RuntimeName
  /** Swapped in wholesale when a suite needs a specific sink or limiter. */
  analytics?: AnalyticsPort
  rateLimiter?: RateLimiterFactory
  /** Silence the logger by default: suites assert on behaviour, not on output. */
  logLevel?: RuntimeCapabilities['logLevel']
}

export function createTestRuntime(
  env: EnvLike = {},
  options: TestRuntimeOptions = {},
): RuntimeCapabilities {
  const runtime = options.runtime ?? 'node'
  const resolution = resolveDeployment(env, runtime, {
    hasPlaybackAnalyticsBinding: Boolean(options.analytics?.canWritePlayback),
  })
  const logLevel = options.logLevel ?? 'error'
  const logger = createLogger({ level: logLevel })

  // better-auth's drizzle adapter reads the handle while the auth instance is
  // constructed, so one must exist even for a suite that never queries. A suite
  // that needs a real database has already installed one via `createTestDb`, and
  // that handle is left alone.
  if (!hasInstalledDb()) {
    installDb(unconfiguredDb())
  }

  return {
    runtime,
    shape: resolution.shape,
    config: resolution.config,
    env,
    logLevel,
    db,
    objectStore: r2,
    auth: createAuth(db, resolution.config),
    rateLimiter:
      options.rateLimiter ??
      createRateLimiterFactory({ ...resolution.rateLimit, store: 'memory' }, () => {}),
    analytics: options.analytics ?? nullAnalytics,
    background: nodeBackground(),
    logger,
    problems: resolution.problems,
    advisories: resolution.advisories,
  }
}

/**
 * Mount a route app behind the runtime, exactly as `createApp` does first.
 *
 * Returns a plain Hono app so `app.request('/path')` behaves as it does in
 * production for that route.
 */
export function withRuntime(
  app: Hono<any>,
  runtime: RuntimeCapabilities,
  path = '/',
): Hono<any> {
  const outer = new Hono()
  outer.use('*', async (c, next) => {
    c.set('runtime', runtime)
    await next()
  })
  outer.route(path, app)
  return outer
}

/**
 * A minimal environment that satisfies `loadConfig` completely.
 *
 * Values are obviously fake; nothing here is a real credential.
 */
export function fullyConfiguredEnv(env: EnvLike = {}): EnvLike {
  return {
    DATABASE_URL: 'postgresql://user:pass@db.example.com/neondb?sslmode=require',
    BETTER_AUTH_SECRET: 'a-32-character-secret-string-1234567890',
    JWT_SECRET: 'another-32-character-secret-string-9876543',
    ACCOUNT_ID: 'cf-account-123',
    R2_ACCESS_KEY_ID: 'r2-access-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret-key',
    RAW_BUCKET_NAME: 'raw-uploads',
    TRANSCODED_BUCKET_NAME: 'transcoded-media',
    MODAL_WEBHOOK_URL: 'https://user--app.modal.run/transcode',
    TRANSCODE_INGEST_SECRET: 'ingest-secret',
    DELIVERY_URL: 'https://media.example.com',
    CLOUDFLARE_ANALYTICS_TOKEN: 'analytics-token',
    ...env,
  }
}
