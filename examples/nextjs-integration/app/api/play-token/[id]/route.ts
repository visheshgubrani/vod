/**
 * POST /api/play-token/[id]
 *
 * The endpoint `<OpenVodPlayer tokenRefreshEndpoint="/api/play-token/<id>">`
 * calls before the current playback token expires.
 *
 * Why a same-origin route works here: the player fetches a `tokenRefreshEndpoint`
 * **string** with `credentials: 'include'`, so your session cookie is sent and
 * this handler can authorize the viewer before minting a new token.
 *
 * A cross-origin API (a different host, a signed request, a token cache) should
 * use the player's callback form instead — `credentials: 'include'` needs CORS
 * credentials and is not what you want across origins:
 *
 * ```tsx
 * tokenRefreshEndpoint={async () => {
 *   const res = await fetch('/api/play-token', { headers: { 'x-csrf': csrf } })
 *   return res.json() // { token } / { playback_token } / { playback_url }
 * }}
 * ```
 *
 * The player accepts `{ token }`, `{ playback_token }` or `{ playback_url }`.
 */

import { OpenVodError } from '@openvod/server'
import { getOpenVod } from '@/lib/openvod'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Replace this with your own authorization: the cookie proves *who* is
  // asking, not that they may watch this video. A cross-tenant id must not be
  // accepted just because someone is signed in.
  // const session = await auth.api.getSession({ headers: request.headers })
  // if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const vod = getOpenVod()
    const session = await vod.playback.createToken(id, {
      expiresIn: '30m',
      // Bound to the viewer's UA — forward it, exactly as in video-status.
      viewerUserAgent: request.headers.get('user-agent') ?? undefined,
    })

    return Response.json({ token: session.token, expiresAt: session.expires_at })
  } catch (error) {
    if (error instanceof OpenVodError && error.code === 'NOT_FOUND') {
      return Response.json({ error: 'Unknown video id' }, { status: 404 })
    }
    if (error instanceof Error) {
      console.error('[play-token]', error.message)
    }
    return Response.json({ error: 'Could not mint a playback token' }, { status: 500 })
  }
}
