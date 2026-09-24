/**
 * Deployment-only authentication for the single local transcoding worker.
 *
 * This secret is intentionally unrelated to session, API-key, upload-token, or
 * playback credentials. It is accepted only by the worker protocol routes.
 * Liveness changes only when the daemon sends an explicit heartbeat.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { localWorker } from '../db/schema'

export const LOCAL_WORKER_ID = 'local'

export type LocalWorkerVariables = {
  worker: {
    id: typeof LOCAL_WORKER_ID
    capacityJobs: number
    capacityRenditions: number
  }
}

function matchesSecret(presented: string, expected: string): boolean {
  if (!presented) return false
  const presentedHash = createHash('sha256').update(presented).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(presentedHash, expectedHash)
}

export const requireLocalWorker = createMiddleware<{ Variables: LocalWorkerVariables }>(
  async (c, next) => {
    const secret = c.var.runtime.config.localTranscoderSecret
    if (!secret) {
      return c.json({ error: 'Local worker authentication is not configured', code: 'WORKER_AUTH_UNCONFIGURED' }, 503)
    }

    const presented = c.req.header('x-local-transcoder-secret') ?? ''
    if (!matchesSecret(presented, secret)) {
      return c.json({ error: 'Invalid local worker credential' }, 401)
    }

    const [row] = await db
      .select({ capacityJobs: localWorker.capacityJobs, capacityRenditions: localWorker.capacityRenditions })
      .from(localWorker)
      .where(eq(localWorker.id, LOCAL_WORKER_ID))
      .limit(1)

    c.set('worker', {
      id: LOCAL_WORKER_ID,
      capacityJobs: row?.capacityJobs ?? 1,
      capacityRenditions: row?.capacityRenditions ?? 1,
    })
    await next()
  },
)
