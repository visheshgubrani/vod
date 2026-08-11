import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { db } from '../lib/database'
import { webhookEndpoint, member } from '../db/schema'
import {
  generateWebhookId,
  generateWebhookSecret,
  WEBHOOK_EVENTS,
  dispatchWebhook,
} from '../utils/webhookDispatcher'

const app = new Hono()

app.use('/*', requireAuth)

/**
 * GET /api/webhooks
 * List all webhook endpoints for the current organization
 */
app.get('/', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const endpoints = await db
    .select({
      id: webhookEndpoint.id,
      url: webhookEndpoint.url,
      events: webhookEndpoint.events,
      enabled: webhookEndpoint.enabled,
      description: webhookEndpoint.description,
      lastTriggeredAt: webhookEndpoint.lastTriggeredAt,
      createdAt: webhookEndpoint.createdAt,
    })
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.organizationId, organizationId))

  return c.json({ endpoints })
})

/**
 * POST /api/webhooks
 * Create a new webhook endpoint
 */
app.post('/', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const body = await c.req.json()
  const { url, events, description } = body

  // Validate URL
  if (!url || typeof url !== 'string') {
    return c.json({ error: 'URL is required' }, 400)
  }

  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'https:' && !url.includes('localhost')) {
      return c.json({ error: 'URL must use HTTPS' }, 400)
    }
  } catch {
    return c.json({ error: 'Invalid URL' }, 400)
  }

  // Validate events
  if (!events || !Array.isArray(events) || events.length === 0) {
    return c.json({ error: 'At least one event is required' }, 400)
  }

  const invalidEvents = events.filter((e: string) => !WEBHOOK_EVENTS.includes(e as any))
  if (invalidEvents.length > 0) {
    return c.json({ error: `Invalid events: ${invalidEvents.join(', ')}` }, 400)
  }

  const id = generateWebhookId()
  const secret = generateWebhookSecret()

  await db.insert(webhookEndpoint).values({
    id,
    organizationId,
    url,
    secret,
    events,
    description: description || null,
    enabled: true,
  })

  return c.json({
    id,
    url,
    secret, // Only returned on creation!
    events,
    description,
    enabled: true,
    message: 'Webhook created. Save the secret - it will not be shown again.',
  })
})

/**
 * GET /api/webhooks/:id
 * Get a specific webhook endpoint
 */
app.get('/:id', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const id = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const endpoints = await db
    .select()
    .from(webhookEndpoint)
    .where(
      and(
        eq(webhookEndpoint.id, id),
        eq(webhookEndpoint.organizationId, organizationId)
      )
    )
    .limit(1)

  if (endpoints.length === 0) {
    return c.json({ error: 'Webhook not found' }, 404)
  }

  const endpoint = endpoints[0]

  return c.json({
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    enabled: endpoint.enabled,
    description: endpoint.description,
    lastTriggeredAt: endpoint.lastTriggeredAt,
    createdAt: endpoint.createdAt,
    // Note: secret is NOT returned for security
  })
})

/**
 * PATCH /api/webhooks/:id
 * Update a webhook endpoint
 */
app.patch('/:id', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const id = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // Verify ownership
  const endpoints = await db
    .select()
    .from(webhookEndpoint)
    .where(
      and(
        eq(webhookEndpoint.id, id),
        eq(webhookEndpoint.organizationId, organizationId)
      )
    )
    .limit(1)

  if (endpoints.length === 0) {
    return c.json({ error: 'Webhook not found' }, 404)
  }

  const body = await c.req.json()
  const updates: Partial<{
    url: string
    events: string[]
    enabled: boolean
    description: string | null
  }> = {}

  // Validate and set URL
  if (body.url !== undefined) {
    try {
      const parsedUrl = new URL(body.url)
      if (parsedUrl.protocol !== 'https:' && !body.url.includes('localhost')) {
        return c.json({ error: 'URL must use HTTPS' }, 400)
      }
      updates.url = body.url
    } catch {
      return c.json({ error: 'Invalid URL' }, 400)
    }
  }

  // Validate and set events
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return c.json({ error: 'At least one event is required' }, 400)
    }
    const invalidEvents = body.events.filter((e: string) => !WEBHOOK_EVENTS.includes(e as any))
    if (invalidEvents.length > 0) {
      return c.json({ error: `Invalid events: ${invalidEvents.join(', ')}` }, 400)
    }
    updates.events = body.events
  }

  // Set enabled status
  if (body.enabled !== undefined) {
    updates.enabled = Boolean(body.enabled)
  }

  // Set description
  if (body.description !== undefined) {
    updates.description = body.description || null
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  await db.update(webhookEndpoint).set(updates).where(eq(webhookEndpoint.id, id))

  return c.json({ success: true, id, ...updates })
})

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook endpoint
 */
app.delete('/:id', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const id = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // Verify ownership
  const endpoints = await db
    .select()
    .from(webhookEndpoint)
    .where(
      and(
        eq(webhookEndpoint.id, id),
        eq(webhookEndpoint.organizationId, organizationId)
      )
    )
    .limit(1)

  if (endpoints.length === 0) {
    return c.json({ error: 'Webhook not found' }, 404)
  }

  await db.delete(webhookEndpoint).where(eq(webhookEndpoint.id, id))

  return c.json({ success: true, message: 'Webhook deleted', id })
})

/**
 * POST /api/webhooks/:id/test
 * Send a test event to verify the webhook endpoint
 */
app.post('/:id/test', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const id = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // Get the endpoint
  const endpoints = await db
    .select()
    .from(webhookEndpoint)
    .where(
      and(
        eq(webhookEndpoint.id, id),
        eq(webhookEndpoint.organizationId, organizationId)
      )
    )
    .limit(1)

  if (endpoints.length === 0) {
    return c.json({ error: 'Webhook not found' }, 404)
  }

  const endpoint = endpoints[0]

  // Send a test event directly (ignore enabled status for test)
  const testPayload = {
    videoId: 'test_video_123',
    title: 'Test Video',
    status: 'ready',
    message: 'This is a test webhook event',
  }

  // Temporarily enable for test dispatch
  dispatchWebhook(c.executionCtx, organizationId, 'video.ready', testPayload)

  return c.json({
    success: true,
    message: 'Test event dispatched',
    event: 'video.ready',
    url: endpoint.url,
  })
})

/**
 * GET /api/webhooks/events
 * List all available webhook events
 */
app.get('/events/list', async (c) => {
  return c.json({
    events: WEBHOOK_EVENTS,
    categories: {
      video: WEBHOOK_EVENTS.filter((e) => e.startsWith('video.')),
      subtitle: WEBHOOK_EVENTS.filter((e) => e.startsWith('subtitle.')),
      chapters: WEBHOOK_EVENTS.filter((e) => e.startsWith('chapters.')),
    },
  })
})

export default app
