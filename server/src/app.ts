import type { HttpBindings } from '@hono/node-server'
import { Ratelimit, type Duration } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import helmet from 'helmet'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './lib/auth'
import { logger } from './lib/logger'
import upload from './routes/upload'
import uploadPublic from './routes/upload-public'
import webhook from './routes/webhook'
import video from './routes/video'
import keys from './routes/keys'
import usage from './routes/usage'
import webhooks from './routes/webhooks'
import api from './routes/api'
import analytics from './routes/analytics'
import analyticsStats from './routes/analytics-stats'
import { Bindings } from './types'
import 'dotenv/config'

type AppBindings = Bindings & Partial<HttpBindings>

const app = new Hono<{ Bindings: AppBindings }>()

const isProduction = process.env.NODE_ENV === 'production'
const hasUpstashRedis =
  Boolean(process.env.UPSTASH_REDIS_REST_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

const DURATION_PATTERN = /^\d+\s?(ms|s|m|h|d)$/
const parseDuration = (value: string | undefined, fallback: Duration): Duration => {
  const normalized = value?.trim()
  if (!normalized || !DURATION_PATTERN.test(normalized)) {
    return fallback
  }
  return normalized as Duration
}

const RATE_LIMIT_PREFIX = process.env.RATE_LIMIT_PREFIX || 'vod-app:ratelimit'
const RATE_LIMIT_ANALYTICS = process.env.RATE_LIMIT_ANALYTICS === 'true'

const authLimiterRequests = parsePositiveInt(process.env.RATE_LIMIT_AUTH_MAX, 30)
const authLimiterWindow = parseDuration(process.env.RATE_LIMIT_AUTH_WINDOW, '1 m')
const apiLimiterRequests = parsePositiveInt(process.env.RATE_LIMIT_API_MAX, 120)
const apiLimiterWindow = parseDuration(process.env.RATE_LIMIT_API_WINDOW, '1 m')
const analyticsLimiterRequests = parsePositiveInt(
  process.env.RATE_LIMIT_ANALYTICS_MAX,
  600,
)
const analyticsLimiterWindow = parseDuration(
  process.env.RATE_LIMIT_ANALYTICS_WINDOW,
  '1 m',
)

const redis = hasUpstashRedis ? Redis.fromEnv() : null

if (!redis) {
  logger.warn(
    'UPSTASH_REDIS_REST_URL/TOKEN are missing. Rate limiting middleware is disabled.',
  )
}

const createRateLimiter = (
  scope: string,
  requests: number,
  window: Duration,
): Ratelimit | null => {
  if (!redis) return null

  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: `${RATE_LIMIT_PREFIX}:${scope}`,
    analytics: RATE_LIMIT_ANALYTICS,
    ephemeralCache: new Map<string, number>(),
  })
}

const authRateLimiter = createRateLimiter(
  'auth',
  authLimiterRequests,
  authLimiterWindow,
)
const apiRateLimiter = createRateLimiter('api', apiLimiterRequests, apiLimiterWindow)
const analyticsRateLimiter = createRateLimiter(
  'analytics',
  analyticsLimiterRequests,
  analyticsLimiterWindow,
)

const resolveRateLimiter = (path: string): Ratelimit | null => {
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return authRateLimiter
  if (path === '/api/playback' || path.startsWith('/api/playback/')) {
    return analyticsRateLimiter
  }
  return apiRateLimiter
}

const getClientIp = (c: Context<{ Bindings: AppBindings }>): string => {
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

const isNodeRequest = (
  env: AppBindings,
): env is Bindings & HttpBindings => {
  return (
    typeof env === 'object' &&
    env !== null &&
    'incoming' in env &&
    'outgoing' in env &&
    Boolean(env.incoming) &&
    Boolean(env.outgoing)
  )
}

const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: isProduction
    ? {
        maxAge: 15552000, // 180 days
        includeSubDomains: true,
      }
    : false,
})

const applyHelmet = (c: Context<{ Bindings: AppBindings }>) =>
  new Promise<void>((resolve, reject) => {
    if (!isNodeRequest(c.env)) {
      // Fallback for non-node runtimes (tests/edge-like fetch calls)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('X-Frame-Options', 'SAMEORIGIN')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-DNS-Prefetch-Control', 'off')
      c.header('X-Download-Options', 'noopen')
      c.header('X-Permitted-Cross-Domain-Policies', 'none')
      c.header('Cross-Origin-Opener-Policy', 'same-origin')
      c.header('Cross-Origin-Resource-Policy', 'cross-origin')
      resolve()
      return
    }

    helmetMiddleware(c.env.incoming, c.env.outgoing, (error?: unknown) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID()
  const requestLogger = logger.child({
    requestId,
    method: c.req.method,
    path: c.req.path,
    ip: getClientIp(c),
  })

  c.set('requestId', requestId)
  c.set('logger', requestLogger)
  c.header('x-request-id', requestId)

  const start = performance.now()
  await next()
  const durationMs = Number((performance.now() - start).toFixed(2))

  if (c.res.status >= 500) {
    requestLogger.error(
      { status: c.res.status, durationMs },
      'request completed with server error',
    )
    return
  }

  if (c.res.status >= 400) {
    requestLogger.warn(
      { status: c.res.status, durationMs },
      'request completed with client error',
    )
    return
  }

  requestLogger.info(
    { status: c.res.status, durationMs },
    'request completed',
  )
})

app.onError((error, c) => {
  const requestLogger = c.var.logger ?? logger
  requestLogger.error(
    {
      err: error,
      method: c.req.method,
      path: c.req.path,
      requestId: c.var.requestId,
    },
    'unhandled request error',
  )
  return c.json({ error: 'Internal server error' }, 500)
})

app.use('*', async (c, next) => {
  await applyHelmet(c)
  await next()
})

// Permissive CORS for B2B public API routes (/v1/*)
// These routes use API keys or upload tokens for auth, so any origin is fine
app.use(
  '/v1/*',
  cors({
    origin: '*', // Allow any origin for B2B customers
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
  }),
)

// Permissive CORS for playback telemetry (/api/playback/*)
// The player can be embedded on any domain, so we allow all origins
app.use(
  '/api/playback/*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
  }),
)

// Strict CORS for dashboard routes (/api/*)
// These routes use session cookies, so we need to restrict origin
const strictCors = cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
})

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/playback')) {
    return next()
  }
  return strictCors(c, next)
})

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS' || c.req.path === '/health') {
    await next()
    return
  }

  // Don't rate-limit inbound webhook callbacks (server-to-server, trusted)
  if (c.req.path.startsWith('/api/webhook')) {
    await next()
    return
  }

  const rateLimiter = resolveRateLimiter(c.req.path)
  if (!rateLimiter) {
    await next()
    return
  }

  const rateLimitResult = await rateLimiter.limit(getClientIp(c))
  const resetSeconds = Math.max(
    0,
    Math.ceil((rateLimitResult.reset - Date.now()) / 1000),
  )

  c.header('X-RateLimit-Limit', String(rateLimitResult.limit))
  c.header('X-RateLimit-Remaining', String(Math.max(rateLimitResult.remaining, 0)))
  c.header('X-RateLimit-Reset', String(Math.ceil(rateLimitResult.reset / 1000)))
  c.header('RateLimit-Limit', String(rateLimitResult.limit))
  c.header(
    'RateLimit-Remaining',
    String(Math.max(rateLimitResult.remaining, 0)),
  )
  c.header('RateLimit-Reset', String(resetSeconds))

  void rateLimitResult.pending.catch((error) => {
    const requestLogger = c.var.logger ?? logger
    requestLogger.warn(
      { err: error, requestId: c.var.requestId },
      'rate limit analytics sync failed',
    )
  })

  if (!rateLimitResult.success) {
    c.header('Retry-After', String(Math.max(1, resetSeconds)))
    const requestLogger = c.var.logger ?? logger
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
  return auth.handler(c.req.raw)
})

// Dashboard routes (session auth)
app.route('/api/upload', upload)
app.route('/api/webhook', webhook)
app.route('/api/video', video)
app.route('/api/keys', keys)
app.route('/api/usage', usage)
app.route('/api/webhooks', webhooks)

// Public upload routes - for B2B customer frontends
// /token uses API key auth, others use upload token auth
app.route('/v1/upload', uploadPublic)

// Public API routes (API key auth) - for B2B customers
app.route('/v1', api)

// Playback telemetry ingest route (public, no auth)
app.route('/api/playback', analytics)
app.route('/api/analytics-stats', analyticsStats)

app.get('/health', (c) => c.text('ok'))

export default app
