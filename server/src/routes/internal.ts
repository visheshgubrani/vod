import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { runMaintenance } from '../utils/maintenance'
import { secretsMatch } from '../utils/webhookDispatcher'
import type { Bindings } from '../types'

/**
 * Internal maintenance endpoints. NOT for tenant use — every route requires
 * INTERNAL_SWEEP_SECRET (bearer or x-sweep-secret header).
 *
 * This endpoint and the scheduled trigger both call `runMaintenance`, so an
 * operator who schedules this route by hand gets exactly the work the cron
 * would have done — including webhook retries.
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
  const result = await runMaintenance(c.env)
  return c.json({
    ok: true,
    // `stats` keeps its original meaning (the transcode sweep) so existing
    // callers and dashboards are unaffected; the rest is additive.
    stats: result.videos,
    deliveries: result.deliveries,
    durationMs: result.durationMs,
  })
})

export default internalApp
