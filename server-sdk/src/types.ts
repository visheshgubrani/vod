/**
 * Wire types for the public ClipMux API (`/v1`).
 *
 * Field names here are the API's own snake_case names, deliberately: this is
 * the boundary, and renaming on the way in would mean the docs, the curl
 * examples and the SDK disagree about what a response looks like. The
 * resource methods (`vod.uploads.createToken(...)`) take camelCase options and
 * return these shapes.
 */

/** A video, as returned by `GET /v1/video/:id` and `GET /v1/videos`. */
export interface Video {
    id: string
    title: string
    status: 'pending' | 'uploading' | 'processing' | 'ready' | 'failed'
    playback_policy: 'public' | 'signed'
    duration: number | null
    thumbnail_url: string | null
    created_at: string
}

/** Paginated list response from `GET /v1/videos`. */
export interface VideoList {
    data: Video[]
}

export interface ListVideosParams {
    /** Filter by lifecycle status. */
    status?: Video['status']
    /** 1–100 (the API clamps to 100; default 50). */
    limit?: number
}

export interface UpdateVideoParams {
    title?: string
    playbackPolicy?: 'public' | 'signed'
}

export interface DeleteVideoResponse {
    deleted: true
    id: string
}

/** Response from `POST /v1/upload/token`. */
export interface UploadToken {
    upload_token: string
    /** ISO 8601 timestamp. */
    expires_at: string
    max_files: number | null
    max_size_bytes: number | null
}

export interface CreateUploadTokenParams {
    /** Lifetime — `'1h'`, `'30m'`, `'24h'`. Max 24h, default 1h. */
    expiresIn?: string
    /** How many files this token may start. 1–100, default 1. */
    maxFiles?: number
    /** Per-file size ceiling in bytes. */
    maxSizeBytes?: number | null
}

/** Response from `POST /v1/video/:id/playback-token`. */
export interface PlaybackSession {
    /** Playback URL; already carries `?token=` for signed videos. */
    playback_url: string | null
    /** Null for public videos — no token is needed. */
    token: string | null
    /** Epoch seconds; null for public videos. */
    expires_at: number | null
    playback_policy: 'public' | 'signed'
    subtitle_url: string | null
    chapters: PlaybackChapter[] | null
}

export interface PlaybackChapter {
    startTime: number
    endTime: number
    title: string
}

export interface CreatePlaybackTokenParams {
    /** Lifetime — `'2h'`, `'30m'`. Default 4h. */
    expiresIn?: string
    /**
     * The viewer's User-Agent. **Required for signed videos**: the delivered
     * token is bound to it and the delivery worker checks that binding.
     */
    viewerUserAgent?: string
    /**
     * Domain patterns allowed to play this video. `['*']` (the default) allows
     * any origin; `'*.example.com'` allows subdomains.
     */
    allowedDomains?: string[]
    /** Allow playback requests with no Referer. Default true. */
    allowNoReferrer?: boolean
}

/** A webhook delivery, as the API sends it. */
export interface WebhookEventPayload<T = Record<string, unknown>> {
    /** `evt_…` — stable per delivery; use it to de-duplicate. */
    id: string
    event: string
    /** ISO 8601 time the event was created. */
    timestamp: string
    data: T
}
