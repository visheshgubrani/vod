/**
 * POST /api/upload-token
 *
 * Mints a short-lived upload token for the browser with your API key.
 *
 * This is the canonical "your API key never reaches the browser" sample: the
 * key is read from `OPENVOD_API_KEY` (no `NEXT_PUBLIC_` prefix), so only this
 * server route can see it. The browser gets a token that is scoped to your
 * organization, expires in an hour, and may start exactly one upload.
 */

import { getOpenVod, toErrorResponse } from '@/lib/openvod'

// Reads a request-time secret, so it must never be evaluated at build time.
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const vod = getOpenVod()

    // Options are camelCase; the SDK translates them to the API's snake_case
    // (`expires_in`, `max_files`) — see `POST /v1/upload/token`.
    const token = await vod.uploads.createToken({ expiresIn: '1h', maxFiles: 1 })

    // The token is only checked when an upload *starts*, so a slow upload is
    // never cut off by its own token lapsing.
    return Response.json({
      uploadToken: token.upload_token,
      expiresAt: token.expires_at,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
