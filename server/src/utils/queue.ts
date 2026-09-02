import { Client } from '@upstash/qstash'
import type { Bindings } from '../types'

export const triggerTranscoding = async (
  fileKey: string,
  fileId: string,
  playbackPolicy: 'public' | 'signed' = 'public',
  generateSubtitle: boolean = false,
  generateChapters: boolean = false,
  organizationId: string,
  env?: Bindings,
) => {
  const qstashToken = env?.QSTASH_TOKEN || process.env.QSTASH_TOKEN
  const client = new Client({ token: qstashToken })
  const ingestSecret =
    env?.TRANSCODE_INGEST_SECRET ||
    process.env.TRANSCODE_INGEST_SECRET ||
    env?.MODAL_WEBHOOK_SECRET ||
    process.env.MODAL_WEBHOOK_SECRET

  // Use BACKEND_URL for the callback since the webhook is in the worker
  // Falls back to constructing from localhost for local dev
  const rawBackendUrl =
    env?.BACKEND_URL || process.env.BACKEND_URL || 'http://localhost:8787'
  const cleanBackendUrl = rawBackendUrl.replace(/\/+$/, '')
  const baseUrl = cleanBackendUrl.endsWith('/api')
    ? cleanBackendUrl.slice(0, -4)
    : cleanBackendUrl
  const callbackUrl = `${baseUrl}/api/webhook/transcode-complete`
  const modalWebhookUrl =
    env?.MODAL_WEBHOOK_URL || process.env.MODAL_WEBHOOK_URL
  const rawBucketName =
    env?.RAW_BUCKET_NAME || process.env.RAW_BUCKET_NAME || 'raw-bucket-uploads'

  try {
    if (!ingestSecret) {
      throw new Error(
        'Missing TRANSCODE_INGEST_SECRET (or MODAL_WEBHOOK_SECRET fallback)',
      )
    }

    if (!modalWebhookUrl) {
      throw new Error('Missing MODAL_WEBHOOK_URL configuration')
    }

    console.log(`[QSTASH DISPATCH] Dispatching job for fileId: ${fileId}`, {
      fileKey,
      rawBucketName,
      modalWebhookUrl,
      callbackUrl,
      hasIngestSecret: Boolean(ingestSecret),
      hasQstashToken: Boolean(qstashToken),
    })

    const result = await client.publishJSON({
      url: modalWebhookUrl,
      body: {
        key: fileKey,
        bucket: rawBucketName,
        fileId: fileId,
        playbackPolicy: playbackPolicy,
        generateSubtitle: generateSubtitle,
        generateChapters: generateChapters,
        organizationId: organizationId, // For bandwidth analytics
        callbackUrl: callbackUrl,
      },
      headers: {
        Authorization: `Bearer ${ingestSecret}`,
      },
      retries: 3,
    })

    console.log(`[QSTASH SUCCESS] Queued transcoding for ${fileId}, messageId:`, result.messageId)
    return { success: true, messageId: result.messageId }
  } catch (error) {
    console.error(`Failed to queue transcoding for ${fileId}:`, error)
    return { success: false, error }
  }
}

