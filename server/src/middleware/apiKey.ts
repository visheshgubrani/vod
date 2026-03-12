import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { apiKey } from '../db/schema'
import { hashApiKey } from '../utils/apiKey'

/**
 * Middleware for API key authentication (for external API consumers)
 * Expects: Authorization: Bearer sk_live_xxxxx
 */
export const requireApiKey = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const key = authHeader.slice(7) // Remove "Bearer "

  if (!key) {
    return c.json({ error: 'API key required' }, 401)
  }

  const keyHash = hashApiKey(key)

  // Look up the API key
  const keys = await db
    .select()
    .from(apiKey)
    .where(eq(apiKey.keyHash, keyHash))
    .limit(1)

  const keyRecord = keys[0]

  if (!keyRecord) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  // Update last used timestamp (fire and forget)
  db.update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, keyRecord.id))
    .catch(() => {}) // Ignore errors

  // Inject organization ID into context
  c.set('organizationId', keyRecord.organizationId)
  c.set('apiKeyId', keyRecord.id)
  c.set('userId', keyRecord.userId)

  await next()
})
