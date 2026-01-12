import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth } from './lib/auth'
import upload from './routes/upload'
import webhook from './routes/webhook'
import { Bindings } from './types'
import 'dotenv/config'

const app = new Hono<{ Bindings: Bindings }>()

app.use(
  '/*',
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  })
)

app.on(['POST', 'GET'], '/api/auth/**', (c) => {
  return auth.handler(c.req.raw)
})

app.route('/api/upload', upload)
app.route('/api/webhook', webhook)

app.get('/health', (c) => c.text('ok'))

export default app
