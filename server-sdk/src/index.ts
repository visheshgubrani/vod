/**
 * ClipMux server SDK
 *
 * The server-side half of an ClipMux integration: mint upload tokens for the
 * browser, mint playback tokens for viewers, manage videos, and verify
 * webhooks. Your API key stays here — never in a browser.
 *
 * ```ts
 * import { ClipMux, constructWebhookEvent } from '@clipmux/server'
 *
 * const vod = new ClipMux({
 *   apiKey: process.env.CLIPMUX_API_KEY!,
 *   baseUrl: process.env.CLIPMUX_API_URL!, // https://api.example.com
 * })
 *
 * // Browser upload
 * const { upload_token } = await vod.uploads.createToken({ expiresIn: '1h', maxFiles: 1 })
 *
 * // Playback for one viewer
 * const session = await vod.playback.createToken(videoId, {
 *   expiresIn: '2h',
 *   viewerUserAgent: req.headers['user-agent'],
 * })
 *
 * // `video.ready`
 * const event = await constructWebhookEvent({
 *   secret: process.env.CLIPMUX_WEBHOOK_SECRET!,
 *   rawBody: rawBodyString,
 *   signature: headers['x-webhook-signature'],
 *   timestamp: headers['x-webhook-timestamp'],
 * })
 * ```
 */

export { ClipMux } from './client'
export type { ClipMuxConfig } from './client'

export {
    ClipMuxError,
    WebhookSignatureError,
    codeForStatus,
    isRetryableCode,
    parseRetryAfter,
} from './errors'
export type {
    ClipMuxErrorCode,
    ClipMuxErrorOptions,
    WebhookSignatureFailure,
} from './errors'

export {
    WEBHOOK_EVENTS,
    RELIABLE_WEBHOOK_EVENTS,
    DEFAULT_TOLERANCE_SECONDS,
    verifyWebhookSignature,
    checkWebhookSignature,
    constructWebhookEvent,
    parseWebhookEvent,
    isWebhookEvent,
} from './webhooks'
export type {
    WebhookEvent,
    VerifyWebhookOptions,
    WebhookVerification,
    ConstructEventOptions,
} from './webhooks'

export type {
    CreatePlaybackTokenParams,
    CreateUploadTokenParams,
    DeleteVideoResponse,
    ListVideosParams,
    PlaybackChapter,
    PlaybackSession,
    UpdateVideoParams,
    UploadToken,
    Video,
    VideoList,
    WebhookEventPayload,
} from './types'
