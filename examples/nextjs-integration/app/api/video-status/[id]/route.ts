/**
 * GET /api/video-status/[id]
 *
 * What the browser polls while a video transcodes. Returns the status, and —
 * once the video is `ready` — the playback URL, token, subtitles and chapters
 * the player needs.
 *
 * The `id` route parameter is a `Promise` in Next 15+ (params are async now),
 * so it must be awaited.
 */

import { OpenVodError } from '@openvod/server'
import { getOpenVod, toErrorResponse } from '@/lib/openvod'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  try {
    const vod = getOpenVod()
    const video = await vod.videos.get(id)

    // Not ready yet: the browser keeps polling. 202 + the current status tells
    // it whether to stop (`failed`).
    if (video.status !== 'ready') {
      return Response.json({ status: video.status }, { status: 202 })
    }

    // Mint a short-lived playback token for this viewer.
    //
    // The viewer's User-Agent MUST be forwarded: for `signed` videos the token
    // is bound to it and the delivery worker enforces that binding, so a token
    // minted with the *server's* UA is rejected when the browser uses it.
    const session = await vod.playback.createToken(id, {
      viewerUserAgent: request.headers.get('user-agent') ?? undefined,
    })

    return Response.json({
      status: video.status,
      // Already carries `?token=` for signed videos.
      playbackUrl: session.playback_url,
      // `null` for public videos — no token is required to play them.
      token: session.token,
      subtitleUrl: session.subtitle_url,
      chapters: session.chapters,
    })
  } catch (error) {
    // `VIDEO_NOT_READY` is a race: the status flipped between the two calls.
    // Tell the browser to keep polling instead of surfacing an error.
    if (error instanceof OpenVodError && error.code === 'VIDEO_NOT_READY') {
      return Response.json({ status: 'processing' }, { status: 202 })
    }

    if (error instanceof OpenVodError && error.code === 'NOT_FOUND') {
      return Response.json({ error: 'Unknown video id' }, { status: 404 })
    }

    return toErrorResponse(error)
  }
}
