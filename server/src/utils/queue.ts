import { Client } from '@upstash/qstash'

export const triggerTranscoding = async (
  fileKey: string,
  fileId: string,
  playbackPolicy: 'public' | 'signed' = 'public',
  generateSubtitle: boolean = false,
  generateChapters: boolean = false,
  organizationId: string
) => {
  const client = new Client({ token: process.env.QSTASH_TOKEN })

  // Use BACKEND_URL for the callback since the webhook is in the worker
  // Falls back to constructing from localhost for local dev
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:4080'

  try {
    const result = await client.publishJSON({
      url: process.env.MODAL_WEBHOOK_URL!,
      body: {
        key: fileKey,
        bucket: 'vod-raw-dev',
        fileId: fileId,
        playbackPolicy: playbackPolicy,
        generateSubtitle: generateSubtitle,
        generateChapters: generateChapters,
        organizationId: organizationId,  // For bandwidth analytics
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
