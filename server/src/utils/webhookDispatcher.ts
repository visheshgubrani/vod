import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { db } from '../lib/database'
import { webhookEndpoint } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'

/**
 * All supported webhook event types
 */
export const WEBHOOK_EVENTS = [
  'video.uploading',
  'video.uploaded',
  'video.processing',
  'video.ready',
  'video.failed',
  'video.updated',
  'video.deleted',
  'subtitle.generating',
  'subtitle.generated',
  'subtitle.failed',
  'chapters.generating',
  'chapters.generated',
  'chapters.failed',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

function generateSignature(secret: string, timestamp: number, body: string): string {
  const payload = `${timestamp}.${body}`
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`
}

export function generateWebhookId(): string {
  return `whep_${randomBytes(16).toString('hex')}`
}

export async function dispatchWebhookEvent(
  organizationId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const endpoints = await db
      .select()
      .from(webhookEndpoint)
      .where(
        and(
          eq(webhookEndpoint.organizationId, organizationId),
          eq(webhookEndpoint.enabled, true),
          sql`${event} = ANY(${webhookEndpoint.events})`,
        ),
      )

    if (endpoints.length === 0) {
      return
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const eventId = `evt_${randomBytes(12).toString('hex')}`

    const payload = {
      id: eventId,
      event,
      timestamp: new Date().toISOString(),
      data,
    }

    const body = JSON.stringify(payload)

    await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        try {
          const signature = generateSignature(endpoint.secret, timestamp, body)

          const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Event': event,
              'X-Webhook-Timestamp': timestamp.toString(),
              'X-Webhook-Signature': `sha256=${signature}`,
              'X-Webhook-Id': eventId,
              'User-Agent': 'OpenVOD-Webhooks/1.0',
            },
            body,
            signal: AbortSignal.timeout(10000),
          })

          if (response.ok) {
            console.log(`[Webhook] Delivered ${event} to ${endpoint.url}`)
            await db
              .update(webhookEndpoint)
              .set({ lastTriggeredAt: new Date() })
              .where(eq(webhookEndpoint.id, endpoint.id))
          } else {
            console.warn(`[Webhook] ${endpoint.url} responded ${response.status}`)
          }
        } catch (err) {
          console.error(`[Webhook] Failed to deliver to ${endpoint.url}:`, err)
        }
      }),
    )
  } catch (err) {
    console.error(`[Webhook] Error dispatching ${event}:`, err)
  }
}

export function dispatchWebhook(
  executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  organizationId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  const task = dispatchWebhookEvent(organizationId, event, data)
  if (executionCtx) {
    executionCtx.waitUntil(task)
    return
  }
  void task
}

export function secretsMatch(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value)
  const expectedBuffer = Buffer.from(expected)

  if (valueBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(valueBuffer, expectedBuffer)
}
