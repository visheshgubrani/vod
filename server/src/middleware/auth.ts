import { createMiddleware } from 'hono/factory'
import { auth } from '../lib/auth'

export const requireAuth = createMiddleware(async (c, next) => {
  const sessionData = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!sessionData) {
    return c.json({ error: 'Anauthorized' }, 401)
  }

  // Injext into context
  c.set('user', sessionData.user)
  c.set('session', sessionData.session)
  await next()
})
