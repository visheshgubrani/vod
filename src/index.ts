import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuth } from './lib/auth'
import upload from './routes/upload'
import { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', async (c, next) => {
  const corsMiddleware = cors({
    origin: c.env.FRONTEND_URL || 'http://localhost:3000',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  })
  return corsMiddleware(c, next)
})

app.on(['POST', 'GET'], '/api/auth/**', (c) => {
  const auth = createAuth(c.env)
  return auth.handler(c.req.raw)
})

app.route('/api/upload', upload)

app.get('/health', (c) => c.text('ok'))

export default app
