/**
 * POST /api/webhooks/openvod
 *
 * Receives OpenVOD webhooks (`video.ready`, `video.failed`, …).
 *
 * Configure the endpoint URL in your OpenVOD deployment and put the signing
 * secret in `OPENVOD_WEBHOOK_SECRET` (`whsec_…`).
 */

import {
  WebhookSignatureError,
  constructWebhookEvent,
  type WebhookEventPayload,
} from '@openvod/server'

/**
 * The payloads the API actually sends. `video.ready` comes from
 * `server/src/lib/lifecycleFinalize.ts` (buildSuccessStatement); `video.failed`
 * from the same file's failure path — it carries `error` and `failureCode`,
 * not `errorMessage`/`errorCode`.
 */
type VideoReadyData = {
  videoId: string
  title?: string
  status?: string
  duration?: number | null
  hlsUrl?: string
  thumbnailUrl?: string | null
}

type VideoFailedData = {
  videoId: string
  title?: string
  /** Human-readable failure message. */
  error?: string
  /** Stable machine-readable code — see docs/delivery-contract.md. */
  failureCode?: string | null
}

export async function POST(req: Request) {
  const secret = process.env.OPENVOD_WEBHOOK_SECRET
  if (!secret) {
    console.error('[webhook] OPENVOD_WEBHOOK_SECRET is not set')
    return Response.json({ error: 'Webhook secret is not configured' }, { status: 500 })
  }

  // The RAW body, not `req.json()`.
  //
  // The signature is HMAC-SHA256(secret, `${timestamp}.${rawBody}`). Parsing and
  // re-serializing (`JSON.stringify(await req.json())`) does not reproduce the
  // signed bytes — key order, whitespace and number formatting are all free to
  // differ — so the digest never matches. This is the single most common
  // integration bug, and why `constructWebhookEvent` verifies before it parses.
  const rawBody = await req.text()

  let event: WebhookEventPayload
  try {
    event = await constructWebhookEvent({
      secret,
      rawBody,
      signature: req.headers.get('x-webhook-signature'),
      timestamp: req.headers.get('x-webhook-timestamp'),
      // Cross-checked against the payload: a disagreement is a `mismatch`.
      event: req.headers.get('x-webhook-event'),
    })
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      // 400 so the sender does not treat a forged or stale delivery as retryable.
      return Response.json({ error: `Invalid signature: ${error.reason}` }, { status: 400 })
    }
    throw error
  }

  switch (event.event) {
    case 'video.ready': {
      // `video.ready` is delivered through a transactional outbox and retried
      // until it succeeds, so it is AT-LEAST-ONCE: the same delivery can arrive
      // more than once, and `event.id` is stable across those retries.
      //
      // De-duplicate on `event.id` before doing anything that is not idempotent
      // — sending an email, charging a customer, appending to a log you bill
      // from. This example only logs, so it is safe to run twice, and the
      // `seen` set is deliberately process-local (a real app stores it in a DB
      // or Redis, which also survives a restart):
      if (seenEventIds.has(event.id)) {
        console.log(`[webhook] duplicate ${event.id} ignored`)
        break
      }
      seenEventIds.add(event.id)

      const data = event.data as VideoReadyData
      console.log('[webhook] video.ready', {
        id: event.id,
        videoId: data.videoId,
        hlsUrl: data.hlsUrl,
      })
      // A real integration marks the video playable here instead of polling:
      // await db.videos.markReady(data.videoId, data.hlsUrl)
      break
    }

    case 'video.failed': {
      const data = event.data as VideoFailedData
      console.error('[webhook] video.failed', {
        id: event.id,
        videoId: data.videoId,
        failureCode: data.failureCode,
        error: data.error,
      })
      break
    }

    default:
      // Every other event is dispatched once, with no retry.
      console.log(`[webhook] ${event.event}`, { id: event.id })
  }

  return Response.json({ received: true })
}

/**
 * Process-local de-duplication for the example. Replace with durable storage
 * (unique index on the event id, Redis SETNX, …) — a redeploy forgets this set.
 */
const seenEventIds = new Set<string>()
