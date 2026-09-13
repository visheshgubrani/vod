import { createMiddleware } from 'hono/factory'

export const requireAuth = createMiddleware(async (c, next) => {
  const sessionData = await c.var.runtime.auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!sessionData) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('user', sessionData.user)
  c.set('session', sessionData.session)
  await next()
})
