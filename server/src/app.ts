import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './lib/auth'
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

const app = new Hono<{ Bindings: Bindings }>()

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

// Strict CORS for dashboard routes (/api/*)
// These routes use session cookies, so we need to restrict origin
app.use(
  '/api/*',
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  }),
)

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

// Analytics routes (public, no auth)
app.route('/api/analytics', analytics)
app.route('/api/analytics-stats', analyticsStats)

app.get('/health', (c) => c.text('ok'))

export default app
