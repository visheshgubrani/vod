import { Client } from '@upstash/qstash'
import { Bindings } from '../types'

export const triggerTranscoding = async (
  env: Bindings,
  fileKey: string,
  fileId: string
) => {
  const client = new Client({ token: env.QSTASH_TOKEN })

  // Use BACKEND_URL for the callback since the webhook is in the worker
  // Falls back to constructing from localhost for local dev
  const backendUrl = env.BACKEND_URL || 'http://localhost:8787'

  try {
    const result = await client.publishJSON({
      url: env.MODAL_WEBHOOK_URL,
      body: {
        key: fileKey,
        bucket: 'vod-raw-dev',
        fileId: fileId,
        callbackUrl: `${backendUrl}/api/webhook/transcode-complete`,
      },
      retries: 3,
    })

    console.log(`Queued transcoding for ${fileId}:`, result.messageId)
    return { success: true, messageId: result.messageId }
  } catch (error) {
    console.error(`Failed to queue transcoding for ${fileId}:`, error)
    return { success: false, error }
  }
}

