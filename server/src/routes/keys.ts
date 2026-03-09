/**
 * API Key Management Routes
 * 
 * Dashboard routes for authenticated users to manage their API keys.
 * Uses session authentication (not API key auth).
 */

import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { db } from '../lib/database'
import { apiKey, member } from '../db/schema'
import {
  generateApiKey,
  getApiKeyLast4,
  getApiKeyPreview,
  hashApiKey,
} from '../utils/apiKey'

const app = new Hono()

// All routes require session authentication
app.use('/*', requireAuth)

/**
 * GET /api/keys
 * List all API keys for the current organization
 */
app.get('/', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const keys = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      label: apiKey.label,
      keyPreview: apiKey.keyLast4,
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(eq(apiKey.organizationId, organizationId))
    .orderBy(apiKey.createdAt)

  return c.json({
    keys: keys.map(k => ({
      id: k.id,
      name: k.name,
      label: k.label,
      key_preview: getApiKeyPreview(k.keyPreview),
      last_used_at: k.lastUsedAt,
      created_at: k.createdAt,
    })),
  })
})

/**
 * POST /api/keys
 * Create a new API key
 * 
 * Body: { "name": "Production Key", "label": "optional label" }
 * 
 * Returns the full key ONLY on creation (not stored/retrievable later)
 */
app.post('/', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const body = await c.req.json()
  const name = body.name?.trim()

  if (!name) {
    return c.json({ error: 'Name is required' }, 400)
  }

  // Generate new API key
  const { id, key } = generateApiKey()

  await db.insert(apiKey).values({
    id,
    keyHash: hashApiKey(key),
    keyLast4: getApiKeyLast4(key),
    name,
    label: body.label?.trim() || null,
    organizationId,
    userId: session.userId,
  })

  return c.json({
    id,
    name,
    label: body.label?.trim() || null,
    // Return the full key ONLY on creation
    key,
    key_preview: getApiKeyPreview(getApiKeyLast4(key)),
    created_at: new Date().toISOString(),
    message: 'Store this key securely. You will not be able to see it again.',
  }, 201)
})

/**
 * GET /api/keys/:id
 * Get details of a specific API key (without the full key)
 */
app.get('/:id', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const keyId = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const keys = await db
    .select()
    .from(apiKey)
    .where(
      and(
        eq(apiKey.id, keyId),
        eq(apiKey.organizationId, organizationId)
      )
    )
    .limit(1)

  const keyRecord = keys[0]

  if (!keyRecord) {
    return c.json({ error: 'API key not found' }, 404)
  }

  return c.json({
    id: keyRecord.id,
    name: keyRecord.name,
    label: keyRecord.label,
    key_preview: getApiKeyPreview(keyRecord.keyLast4),
    last_used_at: keyRecord.lastUsedAt,
    created_at: keyRecord.createdAt,
  })
})

/**
 * PATCH /api/keys/:id
 * Update an API key (name/label only)
 * 
 * Body: { "name": "New Name", "label": "new label" }
 */
app.patch('/:id', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const keyId = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const body = await c.req.json()

  // Verify ownership
  const keys = await db
    .select()
    .from(apiKey)
    .where(
      and(
        eq(apiKey.id, keyId),
        eq(apiKey.organizationId, organizationId)
      )
    )
    .limit(1)

  if (keys.length === 0) {
    return c.json({ error: 'API key not found' }, 404)
  }

  // Update
  const updates: { name?: string; label?: string | null } = {}
  if (body.name?.trim()) updates.name = body.name.trim()
  if (body.label !== undefined) updates.label = body.label?.trim() || null

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  await db
    .update(apiKey)
    .set(updates)
    .where(eq(apiKey.id, keyId))

  return c.json({ success: true, id: keyId, ...updates })
})

/**
 * DELETE /api/keys/:id
 * Revoke/delete an API key
 */
app.delete('/:id', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const keyId = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // Verify ownership before delete
  const keys = await db
    .select()
    .from(apiKey)
    .where(
      and(
        eq(apiKey.id, keyId),
        eq(apiKey.organizationId, organizationId)
      )
    )
    .limit(1)

  if (keys.length === 0) {
    return c.json({ error: 'API key not found' }, 404)
  }

  await db
    .delete(apiKey)
    .where(eq(apiKey.id, keyId))

  return c.json({ success: true, message: 'API key revoked' })
})

/**
 * POST /api/keys/:id/regenerate
 * Regenerate an API key (creates new key, keeps same ID/name)
 * 
 * Returns the new key ONLY on regeneration
 */
app.post('/:id/regenerate', async (c) => {
  const session = c.var.session
  const organizationId = session.activeOrganizationId
  const keyId = c.req.param('id')

  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // Verify ownership
  const keys = await db
    .select()
    .from(apiKey)
    .where(
      and(
        eq(apiKey.id, keyId),
        eq(apiKey.organizationId, organizationId)
      )
    )
    .limit(1)

  const keyRecord = keys[0]

  if (!keyRecord) {
    return c.json({ error: 'API key not found' }, 404)
  }

  // Generate new key value
  const { key: newKey } = generateApiKey()

  await db
    .update(apiKey)
    .set({
      keyHash: hashApiKey(newKey),
      keyLast4: getApiKeyLast4(newKey),
    })
    .where(eq(apiKey.id, keyId))

  return c.json({
    id: keyId,
    name: keyRecord.name,
    key: newKey,
    key_preview: getApiKeyPreview(getApiKeyLast4(newKey)),
    message: 'Store this key securely. You will not be able to see it again.',
  })
})

export default app
