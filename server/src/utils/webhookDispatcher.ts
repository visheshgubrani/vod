import crypto from 'crypto'
import { db } from '../lib/database'
import { webhookEndpoint } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'

/**
 * All supported webhook event types
 */
export const WEBHOOK_EVENTS = [
  // Video lifecycle
  'video.uploading',
  'video.uploaded',
  'video.processing',
  'video.ready',
  'video.failed',
  'video.updated',
  'video.deleted',
  // Subtitle
  'subtitle.generating',
  'subtitle.generated',
  'subtitle.failed',
  // Chapters
  'chapters.generating',
  'chapters.generated',
  'chapters.failed',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
function generateSignature(secret: string, timestamp: number, body: string): string {
  const payload = `${timestamp}.${body}`
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Generate a cryptographically secure webhook secret
 */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`
}

/**
 * Generate a webhook endpoint ID
 */
export function generateWebhookId(): string {
  return `whep_${crypto.randomBytes(16).toString('hex')}`
}

/**
 * Dispatch a webhook event to all subscribed endpoints for an organization
 */
export async function dispatchWebhookEvent(
  organizationId: string,
  event: WebhookEvent,
  data: Record<string, any>
): Promise<void> {
  try {
    // Find all enabled endpoints that are subscribed to this event
    const endpoints = await db
      .select()
      .from(webhookEndpoint)
      .where(
        and(
          eq(webhookEndpoint.organizationId, organizationId),
          eq(webhookEndpoint.enabled, true),
          sql`${event} = ANY(${webhookEndpoint.events})`
        )
      )

    if (endpoints.length === 0) {
      return // No subscribers for this event
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const eventId = `evt_${crypto.randomBytes(12).toString('hex')}`

    const payload = {
      id: eventId,
      event,
      timestamp: new Date().toISOString(),
      data,
    }

    const body = JSON.stringify(payload)

    // Fire webhooks in parallel (fire-and-forget)
    const deliveries = endpoints.map(async (endpoint) => {
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
            'User-Agent': 'ClipMux-Webhooks/1.0',
          },
          body,
          signal: AbortSignal.timeout(10000), // 10s timeout
        })

        if (response.ok) {
          console.log(`[Webhook] ✅ Delivered ${event} to ${endpoint.url}`)
          // Update last triggered time
          await db
            .update(webhookEndpoint)
            .set({ lastTriggeredAt: new Date() })
            .where(eq(webhookEndpoint.id, endpoint.id))
        } else {
          console.warn(`[Webhook] ⚠️ ${endpoint.url} responded ${response.status}`)
        }
      } catch (err) {
        console.error(`[Webhook] ❌ Failed to deliver to ${endpoint.url}:`, err)
      }
    })

    // Don't await - fire and forget
    Promise.allSettled(deliveries)
  } catch (err) {
    console.error(`[Webhook] Error dispatching ${event}:`, err)
  }
}

/**
 * Dispatch webhook event without blocking
 */
export function dispatchWebhook(
  organizationId: string,
  event: WebhookEvent,
  data: Record<string, any>
): void {
  // Fire and forget - don't block the main request
  dispatchWebhookEvent(organizationId, event, data).catch((err) => {
    console.error(`[Webhook] Dispatch error:`, err)
  })
}
