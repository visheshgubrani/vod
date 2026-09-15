/**
 * Resource implementations.
 *
 * Each function is a thin, typed translation of one API route:
 * camelCase options in, the API's own wire shape out. Kept out of `client.ts`
 * so the client stays about transport, and out of the index so the public
 * surface is a deliberate choice rather than whatever the file exports.
 */

import type { ClipMux } from './client'
import { listQuery, updateBody } from './client'
import { ClipMuxError } from './errors'
import type {
    CreatePlaybackTokenParams,
    CreateUploadTokenParams,
    DeleteVideoResponse,
    ListVideosParams,
    PlaybackSession,
    UpdateVideoParams,
    UploadToken,
    Video,
    VideoList,
} from './types'

export interface UploadsResource {
    /**
     * Mint a short-lived upload token for a browser.
     *
     * The token is scoped to the API key's organization and is only checked
     * when an upload starts, so an upload that began before expiry finishes.
     */
    createToken(params?: CreateUploadTokenParams): Promise<UploadToken>
}

export interface VideosResource {
    get(id: string): Promise<Video>
    list(params?: ListVideosParams): Promise<VideoList>
    update(id: string, patch: UpdateVideoParams): Promise<Partial<Video> & { id: string }>
    delete(id: string): Promise<DeleteVideoResponse>
}

export interface PlaybackResource {
    /**
     * Mint a playback token / playback URL for one video.
     *
     * For `signed` videos you must pass `viewerUserAgent` — the token is bound
     * to it and the delivery worker enforces the binding.
     */
    createToken(id: string, params?: CreatePlaybackTokenParams): Promise<PlaybackSession>
}

export function createUploadToken(
    client: ClipMux,
    params: CreateUploadTokenParams,
): Promise<UploadToken> {
    return client.request<UploadToken>({
        method: 'POST',
        path: '/v1/upload/token',
        // Retrying is safe: a duplicate token simply expires unused.
        retryable: true,
        body: {
            ...(params.expiresIn !== undefined ? { expires_in: params.expiresIn } : {}),
            ...(params.maxFiles !== undefined ? { max_files: params.maxFiles } : {}),
            ...(params.maxSizeBytes !== undefined ? { max_size_bytes: params.maxSizeBytes } : {}),
        },
    })
}

export async function getVideo(client: ClipMux, id: string): Promise<Video> {
    requireId(id)
    return client.request<Video>({ method: 'GET', path: `/v1/video/${encodeURIComponent(id)}` })
}

export function listVideos(client: ClipMux, params: ListVideosParams): Promise<VideoList> {
    return client.request<VideoList>({
        method: 'GET',
        path: '/v1/videos',
        query: listQuery(params),
    })
}

export async function updateVideo(
    client: ClipMux,
    id: string,
    patch: UpdateVideoParams,
): Promise<Partial<Video> & { id: string }> {
    requireId(id)
    const body = updateBody(patch)
    if (Object.keys(body).length === 0) {
        // The API would answer 400 "No valid fields to update"; failing here
        // names the actual mistake (an empty patch) instead of the symptom.
        throw new ClipMuxError('update() needs a title or a playbackPolicy', {
            code: 'INVALID_REQUEST',
        })
    }
    return client.request({ method: 'PATCH', path: `/v1/video/${encodeURIComponent(id)}`, body })
}

export async function deleteVideo(client: ClipMux, id: string): Promise<DeleteVideoResponse> {
    requireId(id)
    return client.request<DeleteVideoResponse>({
        method: 'DELETE',
        path: `/v1/video/${encodeURIComponent(id)}`,
    })
}

export async function createPlaybackToken(
    client: ClipMux,
    id: string,
    params: CreatePlaybackTokenParams,
): Promise<PlaybackSession> {
    requireId(id)
    return client.request<PlaybackSession>({
        method: 'POST',
        path: `/v1/video/${encodeURIComponent(id)}/playback-token`,
        retryable: true,
        body: {
            ...(params.expiresIn !== undefined ? { expires_in: params.expiresIn } : {}),
            ...(params.viewerUserAgent !== undefined
                ? { viewer_user_agent: params.viewerUserAgent }
                : {}),
            ...(params.allowedDomains !== undefined
                ? { allowed_domains: params.allowedDomains }
                : {}),
            ...(params.allowNoReferrer !== undefined
                ? { allow_no_referrer: params.allowNoReferrer }
                : {}),
        },
    })
}

/**
 * Validation that must *reject*, not throw: these methods are typed as
 * returning promises, so a caller writing `vod.videos.get(id).catch(...)` must
 * not have the error escape synchronously. Every caller is `async` for this
 * reason.
 */
function requireId(id: string): void {
    if (typeof id !== 'string' || !id.trim()) {
        throw new ClipMuxError('A video id is required', { code: 'INVALID_REQUEST' })
    }
}
