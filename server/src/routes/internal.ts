import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { runSweep } from '../utils/jobSweeper'
import { createSweepAdapters, sweepLimitsFromEnv } from '../utils/sweepAdapters'
import { secretsMatch } from '../utils/webhookDispatcher'
import type { Bindings } from '../types'

/**
 * Internal maintenance endpoints. NOT for tenant use — every route requires
 * INTERNAL_SWEEP_SECRET (bearer or x-sweep-secret header).
 */
export const internalApp = new Hono<{ Bindings: Bindings }>()

const requireInternalSecret = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const expected =
    c.env?.INTERNAL_SWEEP_SECRET ||
    (typeof process !== 'undefined' ? process.env?.INTERNAL_SWEEP_SECRET : undefined)
  if (!expected) {
    return c.json({ error: 'Internal maintenance not configured' }, 503)
  }
  const got =
    c.req.header('x-sweep-secret') ??
    c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!got || !secretsMatch(got, expected)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})

internalApp.use('/sweep', requireInternalSecret)

internalApp.post('/sweep', async (c) => {
  const started = Date.now()
  const stats = await runSweep(
    new Date(),
    sweepLimitsFromEnv(c.env),
    createSweepAdapters(c.env),
  )
  return c.json({
    ok: true,
    stats,
    durationMs: Date.now() - started,
  })
})

export default internalApp
