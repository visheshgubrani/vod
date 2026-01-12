import { createMiddleware } from 'hono/factory'
import { createAuth } from '../lib/auth'
import { Bindings, Variables } from '../types'

export const requireAuth = createMiddleware<{
  Bindings: Bindings
  Variables: Variables
}>(async (c, next) => {
  // Initialize Auth
  const auth = createAuth(c.env)

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
