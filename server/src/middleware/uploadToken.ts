import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { uploadToken } from '../db/schema'

/**
 * Middleware for upload token authentication (for B2B customer frontends)
 * Expects: Authorization: UploadToken ut_xxxxx
 *
 * Upload tokens are short-lived, single-use tokens that allow direct uploads
 * from customer frontends without exposing API keys.
 */
export const requireUploadToken = createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization')
    console.log('[UploadToken] Auth header:', authHeader)

    if (!authHeader?.startsWith('UploadToken ')) {
        console.log('[UploadToken] Header does not start with "UploadToken "')
        return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }

    const token = authHeader.slice(12).trim() // Remove "UploadToken "

    console.log('[UploadToken] Extracted token:', token)

    if (!token) {
        return c.json({ error: 'Upload token required' }, 401)
    }

    // Look up the upload token
    const tokens = await db
        .select()
        .from(uploadToken)
        .where(eq(uploadToken.token, token))
        .limit(1)

    console.log('[UploadToken] Found tokens:', tokens.length)

    const tokenRecord = tokens[0]

    if (!tokenRecord) {
        console.log('[UploadToken] Token not found in database')
        return c.json({ error: 'Invalid upload token' }, 401)
    }

    // Check if token has expired
    if (new Date() > tokenRecord.expiresAt) {
        return c.json({ error: 'Upload token has expired' }, 401)
    }

    // Check if token has been exhausted (used all allowed uploads)
    // Only enforce this limit for /create - allow /parts, /complete, /abort to proceed
    const isCreateRequest = c.req.path.endsWith('/create')
    if (
        isCreateRequest &&
        tokenRecord.maxFiles !== null &&
        tokenRecord.usedFiles !== null &&
        tokenRecord.usedFiles >= tokenRecord.maxFiles
    ) {
        return c.json({ error: 'Upload token has been fully used' }, 401)
    }

    // Inject context for downstream handlers
    c.set('organizationId', tokenRecord.organizationId)
    c.set('uploadTokenId', tokenRecord.id)
    c.set('uploadTokenRecord', tokenRecord)

    await next()
})

/**
 * Increment the used file count for an upload token.
 * Call this after successfully creating an upload.
 */
export async function incrementUploadTokenUsage(tokenId: string): Promise<void> {
    await db
        .update(uploadToken)
        .set({
            usedFiles: (await db
                .select({ usedFiles: uploadToken.usedFiles })
                .from(uploadToken)
                .where(eq(uploadToken.id, tokenId))
                .limit(1)
                .then(r => (r[0]?.usedFiles ?? 0) + 1)),
        })
        .where(eq(uploadToken.id, tokenId))
}
