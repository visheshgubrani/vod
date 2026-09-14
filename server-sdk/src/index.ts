/**
 * OpenVOD server SDK
 *
 * The server-side half of an OpenVOD integration: mint upload tokens for the
 * browser, mint playback tokens for viewers, manage videos, and verify
 * webhooks. Your API key stays here — never in a browser.
 *
 * ```ts
 * import { OpenVod, constructWebhookEvent } from '@openvod/server'
 *
 * const vod = new OpenVod({
 *   apiKey: process.env.OPENVOD_API_KEY!,
 *   baseUrl: process.env.OPENVOD_API_URL!, // https://api.example.com
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
 *   secret: process.env.OPENVOD_WEBHOOK_SECRET!,
 *   rawBody: rawBodyString,
 *   signature: headers['x-webhook-signature'],
 *   timestamp: headers['x-webhook-timestamp'],
 * })
 * ```
 */

export { OpenVod } from './client'
export type { OpenVodConfig } from './client'

export {
    OpenVodError,
    WebhookSignatureError,
    codeForStatus,
    isRetryableCode,
    parseRetryAfter,
} from './errors'
export type {
    OpenVodErrorCode,
    OpenVodErrorOptions,
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
