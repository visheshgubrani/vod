import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './lib/auth'
import upload from './routes/upload'
import webhook from './routes/webhook'
import video from './routes/video'
import keys from './routes/keys'
import usage from './routes/usage'
import webhooks from './routes/webhooks'
import api from './routes/api'
import { Bindings } from './types'
import 'dotenv/config'

const app = new Hono<{ Bindings: Bindings }>()

app.use(
  '/*',
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

// Public API routes (API key auth) - for B2B customers
app.route('/v1', api)

app.get('/health', (c) => c.text('ok'))

export default app
