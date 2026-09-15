/**
 * Shared server-side ClipMux client.
 *
 * `CLIPMUX_API_KEY` has no `NEXT_PUBLIC_` prefix on purpose: only the route
 * handlers in `app/api/**` can read it, so the API key never reaches the
 * browser. Clients are memoized per `(apiKey, baseUrl)` pair so a route does not
 * rebuild the SDK on every request.
 */

import { ClipMux } from '@clipmux/server'

const clients = new Map<string, ClipMux>()

export function getClipMux(): ClipMux {
  const apiKey = process.env.CLIPMUX_API_KEY
  if (!apiKey) {
    throw new Error('CLIPMUX_API_KEY is not set — copy .env.example to .env.local')
  }

  // No `/v1` suffix: the SDK appends it. See server-sdk/README.md.
  const baseUrl = process.env.CLIPMUX_API_URL ?? 'http://localhost:8787'
  const cacheKey = `${apiKey}:${baseUrl}`

  const existing = clients.get(cacheKey)
  if (existing) return existing

  const client = new ClipMux({ apiKey, baseUrl })
  clients.set(cacheKey, client)
  return client
}

/** Config errors are 500s; anything else is the API's own problem. */
export function toErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Unexpected error'
  console.error('[clipmux-example]', message)
  return Response.json({ error: message }, { status: 500 })
}
