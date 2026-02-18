import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from './app'
import { logger } from './lib/logger'

const port = Number(process.env.PORT) || 4080

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  logger.info(
    { port: info.port, environment: process.env.NODE_ENV || 'development' },
    'server listening',
  )
})
