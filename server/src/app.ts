/**
 * The Hono application, built by a composition root.
 *
 * The app is a function of `RuntimeCapabilities`. There is no ambient
 * environment to reach for: configuration, clients, the rate limiter, the
 * analytics sink and background work all arrive on `c.var.runtime`.
 */

import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { matchOrigin } from './lib/config'
import { resolveRateLimitScope } from './lib/rateLimit'
import type { RuntimeCapabilities } from './runtime/types'
import health from './routes/health'
import internal from './routes/internal'
import upload from './routes/upload'
import uploadPublic from './routes/upload-public'
import webhook from './routes/webhook'
import video from './routes/video'
import keys from './routes/keys'
import usage from './routes/usage'
import webhooks from './routes/webhooks'
import api from './routes/api'
import transcoder from './routes/transcoder'
import { dashboardApp, localWorkerSourceApp, importLocalApp } from './routes/localImport'
import analytics from './routes/analytics'
import analyticsStats from './routes/analytics-stats'
import type { Bindings } from './types'

/**
 * Origins that are always allowed while developing (matches legacy behavior).
 * Kept in one place so CORS and better-auth's trusted origins cannot drift.
 */
export const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]

const getClientIp = (c: Context<{ Bindings: Bindings }>): string => {
  const forwardedFor = c.req.header('x-forwarded-for')
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim()
    if (firstIp) return firstIp
  }

  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-client-ip') ||
    'unknown'
  )
}

export function createApp(runtime: RuntimeCapabilities): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>()
  const { config, env } = runtime
  const isProduction = env['NODE_ENV'] === 'production'

  const applySecurityHeaders = (c: Context<{ Bindings: Bindings }>) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'SAMEORIGIN')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-DNS-Prefetch-Control', 'off')
    c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
    c.header('Cross-Origin-Resource-Policy', 'cross-origin')
    if (isProduction) {
      c.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
    }
  }

  // Everything below reads c.var.runtime.
  app.use('*', async (c, next) => {
    c.set('runtime', runtime)
    await next()
  })

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID()
    const requestLogger = runtime.logger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
      ip: getClientIp(c),
    })

    c.set('requestId', requestId)
    c.set('logger', requestLogger)
    c.header('x-request-id', requestId)

    const start = performance.now()
    console.log(`[REQ START] ${c.req.method} ${c.req.path}`)
    await next()
    const durationMs = Number((performance.now() - start).toFixed(2))
    console.log(`[REQ END] ${c.req.method} ${c.req.path} -> ${c.res.status} (${durationMs}ms)`)

    if (c.res.status >= 500) {
      requestLogger.error({ status: c.res.status, durationMs }, 'request completed with server error')
      return
    }

    if (c.res.status >= 400) {
      requestLogger.warn({ status: c.res.status, durationMs }, 'request completed with client error')
      return
    }

    requestLogger.info({ status: c.res.status, durationMs }, 'request completed')
  })

  app.onError((error, c) => {
    const requestLogger = c.var.logger ?? runtime.logger
    requestLogger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        method: c.req.method,
        path: c.req.path,
        requestId: c.var.requestId,
      },
      'unhandled request error',
    )
    return c.json({ error: 'Internal server error' }, 500)
  })

  app.use('*', async (c, next) => {
    applySecurityHeaders(c)
    await next()
  })

  // Permissive CORS for B2B public API routes (/v1/*)
  app.use(
    '/v1/*',
    cors({
      origin: '*',
      allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-request-id'],
      allowMethods: ['POST', 'GET', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Length'],
      maxAge: 600,
    }),
  )

  // Permissive CORS for playback telemetry (/api/playback/*)
  app.use(
    '/api/playback/*',
    cors({
      origin: '*',
      allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-request-id'],
      allowMethods: ['POST', 'GET', 'OPTIONS'],
      exposeHeaders: ['Content-Length'],
      maxAge: 600,
    }),
  )

  // Permissive CORS for public health probes (no credentials involved)
  app.use(
    '/health',
    cors({
      origin: '*',
      allowMethods: ['GET', 'HEAD', 'OPTIONS'],
      maxAge: 600,
    }),
  )
  app.use(
    '/health/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'HEAD', 'OPTIONS'],
      maxAge: 600,
    }),
  )

  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/playback')) {
      return next()
    }

    const corsMiddleware = cors({
      origin: (origin) => {
        // FRONTEND_URL + CORS_ORIGINS, resolved once by the composition root.
        const patterns = config.corsPatterns
        if (matchOrigin(origin, [...patterns, ...LOCAL_DEV_ORIGINS])) {
          return origin
        }
        // Unknown origin: send no CORS header. Do not fabricate a fallback origin.
        return null
      },
      allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-request-id'],
      allowMethods: ['POST', 'GET', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Length'],
      maxAge: 600,
      credentials: true,
    })

    return corsMiddleware(c, next)
  })

  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/health') {
      await next()
      return
    }

    if (c.req.path.startsWith('/api/webhook')) {
      await next()
      return
    }

    const scope = resolveRateLimitScope(c.req.path)
    const rateLimitResult = await runtime.rateLimiter(scope).limit(getClientIp(c))
    const resetSeconds = Math.max(
      0,
      Math.ceil((rateLimitResult.reset - Date.now()) / 1000),
    )

    c.header('X-RateLimit-Limit', String(rateLimitResult.limit))
    c.header('X-RateLimit-Remaining', String(Math.max(rateLimitResult.remaining, 0)))
    c.header('X-RateLimit-Reset', String(Math.ceil(rateLimitResult.reset / 1000)))
    c.header('RateLimit-Limit', String(rateLimitResult.limit))
    c.header('RateLimit-Remaining', String(Math.max(rateLimitResult.remaining, 0)))
    c.header('RateLimit-Reset', String(resetSeconds))

    runtime.background(
      rateLimitResult.pending,
      'rate limit analytics sync',
    )

    if (!rateLimitResult.success) {
      c.header('Retry-After', String(Math.max(1, resetSeconds)))
      const requestLogger = c.var.logger ?? runtime.logger
      requestLogger.warn(
        {
          requestId: c.var.requestId,
          path: c.req.path,
          method: c.req.method,
          ip: getClientIp(c),
          limit: rateLimitResult.limit,
          reset: rateLimitResult.reset,
        },
        'request blocked by rate limiter',
      )

      return c.json(
        {
          error: 'Rate limit exceeded',
          retryAfter: Math.max(1, resetSeconds),
        },
        429,
      )
    }

    await next()
  })

  app.on(['POST', 'GET'], '/api/auth/*', (c) => {
    return runtime.auth.handler(c.req.raw)
  })

  app.route('/health', health)
  app.route('/api/internal', internal)
  app.route('/api/upload', upload)
  app.route('/api/webhook', webhook)
  app.route('/api/video', video)
  app.route('/api/keys', keys)
  app.route('/api/usage', usage)
  app.route('/api/webhooks', webhooks)
  app.route('/v1/upload', uploadPublic)
  // Local import sits under /v1 too, but is built separately because it authenticates
  // with an API key while the rest of the public API does not yet.
  app.route('/v1', importLocalApp)
  app.route('/v1', api)
  // The local-worker protocol runs outside session and API-key middleware. Its
  // deployment credential authenticates only worker endpoints and carries no tenant.
  app.route('/api/transcoder/v1', transcoder)
  app.route('/api/transcoder/v1/sources', localWorkerSourceApp)
  app.route('/api/transcoder', dashboardApp)
  app.route('/api/playback', analytics)
  app.route('/api/analytics-stats', analyticsStats)

  return app
}
