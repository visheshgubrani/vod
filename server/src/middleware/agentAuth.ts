/**
 * Agent authentication middleware.
 *
 * A dedicated middleware rather than a shared one with a scope flag, because the
 * whole point of the agent credential is that it is *not* an API key: it cannot
 * list videos, mint playback tokens, or touch another organization's data. An
 * agent token presented to `/v1/*` or `/api/video/*` fails there because those
 * routes call `requireApiKey`/`requireAuth`, and a token that is never accepted
 * anywhere else cannot be over-scoped by forgetting a check.
 */

import { createMiddleware } from 'hono/factory'
import { and, eq } from 'drizzle-orm'
import { db } from '../lib/database'
import { transcoderAgent } from '../db/schema'
import { authenticateAgentToken, readPresentedToken } from '../lib/agentToken'

export type AgentVariables = {
  agent: {
    id: string
    organizationId: string
    name: string
    enabled: boolean
    capacityJobs: number
    capacityRenditions: number
  }
}

export const requireAgent = createMiddleware<{ Variables: AgentVariables }>(
  async (c, next) => {
    const token = readPresentedToken(c.req.raw.headers)
    const agent = await authenticateAgentToken(token)

    if (!agent) {
      // One message for unknown, revoked and disabled alike: the difference is
      // not the caller's to learn.
      return c.json({ error: 'Invalid or revoked agent credential' }, 401)
    }

    if (!agent.enabled) {
      return c.json(
        { error: 'Agent is disabled', code: 'AGENT_DISABLED' },
        403,
      )
    }

    c.set('agent', {
      id: agent.id,
      organizationId: agent.organizationId,
      name: agent.name,
      enabled: agent.enabled,
      capacityJobs: agent.capacityJobs,
      capacityRenditions: agent.capacityRenditions,
    })

    // Liveness is a side effect of every authenticated call, not only of the
    // heartbeat. An agent that is actively claiming work and uploading artifacts
    // is obviously alive, and requiring a separate beat would make it look dead
    // during a long upload.
    c.executionCtx?.waitUntil?.(
      db
        .update(transcoderAgent)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(transcoderAgent.id, agent.id), eq(transcoderAgent.enabled, true)))
        .catch(() => {}),
    )

    await next()
  },
)
