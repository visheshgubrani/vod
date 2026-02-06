import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from './app'

const port = Number(process.env.PORT) || 4080

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`Listening on http://localhost:${info.port}`)
})
