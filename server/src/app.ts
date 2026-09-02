import { Ratelimit, type Duration } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
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
import type { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

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

let cachedRedis: Redis | null = null
let cachedRedisKey: string | null = null

const getRedis = (env?: Bindings): Redis | null => {
  const url = env?.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = env?.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) return null
  const key = `${url}:${token}`
  if (cachedRedis && cachedRedisKey === key) return cachedRedis

  cachedRedis = new Redis({ url, token })
  cachedRedisKey = key
  return cachedRedis
}

const limiterCache = new Map<string, Ratelimit>()

const createRateLimiter = (
  scope: string,
  requests: number,
  window: Duration,
  env?: Bindings,
): Ratelimit | null => {
  const redis = getRedis(env)
  if (!redis) return null

  const prefix = env?.RATE_LIMIT_PREFIX || RATE_LIMIT_PREFIX
  const cacheKey = `${prefix}:${scope}:${requests}:${window}`
  if (limiterCache.has(cacheKey)) {
    return limiterCache.get(cacheKey)!
  }

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: `${prefix}:${scope}`,
    analytics: RATE_LIMIT_ANALYTICS,
    ephemeralCache: new Map<string, number>(),
  })
  limiterCache.set(cacheKey, limiter)
  return limiter
}

const resolveRateLimiter = (path: string, env?: Bindings): Ratelimit | null => {
  if (path === '/api/auth' || path.startsWith('/api/auth/')) {
    return createRateLimiter('auth', authLimiterRequests, authLimiterWindow, env)
  }
  if (path === '/api/playback' || path.startsWith('/api/playback/')) {
    return createRateLimiter(
      'analytics',
      analyticsLimiterRequests,
      analyticsLimiterWindow,
      env,
    )
  }
  return createRateLimiter('api', apiLimiterRequests, apiLimiterWindow, env)
}

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

const applySecurityHeaders = (c: Context<{ Bindings: Bindings }>) => {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'SAMEORIGIN')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-DNS-Prefetch-Control', 'off')
  c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  if (isProduction) {
    c.header(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains',
    )
  }
}

app.use('*', async (c, next) => {
  if (c.env) {
    for (const key of Object.keys(c.env)) {
      const val = (c.env as Record<string, unknown>)[key]
      if (typeof val === 'string') {
        process.env[key] = val
      }
    }
  }
  await next()
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
  console.log(`[REQ START] ${c.req.method} ${c.req.path}`)
  await next()
  const durationMs = Number((performance.now() - start).toFixed(2))
  console.log(`[REQ END] ${c.req.method} ${c.req.path} -> ${c.res.status} (${durationMs}ms)`)

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

const isAllowedOrigin = (origin: string, envFrontendUrl?: string): boolean => {
  if (!origin) return false

  // Local development origins
  if (
    origin === 'http://localhost:3000' ||
    origin === 'http://localhost:3001' ||
    origin === 'http://127.0.0.1:3000'
  ) {
    return true
  }

  // Production domain & subdomains
  if (
    origin === 'https://clipmux.com' ||
    origin === 'https://www.clipmux.com' ||
    origin.endsWith('.clipmux.com')
  ) {
    return true
  }

  // Cloudflare Pages deployments (e.g. *.clipmux-ui.pages.dev, *.pages.dev)
  if (
    origin === 'https://clipmux-ui.pages.dev' ||
    origin.endsWith('.clipmux-ui.pages.dev') ||
    origin.endsWith('.pages.dev')
  ) {
    return true
  }

  // Configured FRONTEND_URL environment variable (supports comma-separated origins)
  if (envFrontendUrl) {
    const origins = envFrontendUrl.split(',').map((o) => o.trim())
    if (origins.includes(origin)) return true
  }

  if (process.env.FRONTEND_URL) {
    const origins = process.env.FRONTEND_URL.split(',').map((o) => o.trim())
    if (origins.includes(origin)) return true
  }

  return false
}

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

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/playback')) {
    return next()
  }

  const corsMiddleware = cors({
    origin: (origin) => {
      const envFrontendUrl = c.env?.FRONTEND_URL
      if (isAllowedOrigin(origin, envFrontendUrl)) {
        return origin
      }
      return envFrontendUrl || 'https://clipmux.com'
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

  const rateLimiter = resolveRateLimiter(c.req.path, c.env)
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

  c.executionCtx.waitUntil(
    rateLimitResult.pending.catch((error) => {
      const requestLogger = c.var.logger ?? logger
      requestLogger.warn(
        { err: error instanceof Error ? error.message : String(error), requestId: c.var.requestId },
        'rate limit analytics sync failed',
      )
    }),
  )

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

app.route('/api/upload', upload)
app.route('/api/webhook', webhook)
app.route('/api/video', video)
app.route('/api/keys', keys)
app.route('/api/usage', usage)
app.route('/api/webhooks', webhooks)
app.route('/v1/upload', uploadPublic)
app.route('/v1', api)
app.route('/api/playback', analytics)
app.route('/api/analytics-stats', analyticsStats)

app.get('/health', (c) => c.text('ok'))

export default app
