import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq, inArray } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { requireApiKey } from '../middleware/apiKey'
import { db } from '../lib/database'
import { uploadToken, video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { dispatchFailureStatus } from '../utils/dispatchTranscode'
import { dispatchWithProvider } from '../utils/dispatchProvider'
import { dispatchWebhook } from '../utils/webhookDispatcher'
import { headObjectSize, r2 } from '../utils/R2'
import type { Bindings } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

/**
 * Bucket names come from the resolved configuration on every use.
 *
 * They used to be module-scope constants read once from `process.env`, with
 * hardcoded defaults ('raw-bucket-uploads' / 'transcoded-bucket'), while the same
 * handler recorded the bucket for a job by reading `c.env` — three resolutions of
 * one value in one file. A presigned URL could therefore point at one bucket
 * while the transcode job named another, and an unconfigured deployment silently
 * targeted a bucket that does not exist instead of saying so.
 */
function rawBucketOrFail(c: Context<{ Bindings: Bindings }>): string | Response {
  const bucket = c.var.runtime.config.rawBucket
  if (!bucket) {
    return c.json(
      {
        error:
          'Uploads are not configured: RAW_BUCKET_NAME is not set on this deployment.',
      },
      409,
    )
  }
  return bucket
}

function transcodedBucketOrFail(c: Context<{ Bindings: Bindings }>): string | Response {
  const bucket = c.var.runtime.config.transcodedBucket
  if (!bucket) {
    return c.json(
      {
        error:
          'Object storage is not configured: TRANSCODED_BUCKET_NAME is not set on this deployment.',
      },
      409,
    )
  }
  return bucket
}

const MIN_PART_SIZE = 5 * 1024 * 1024
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024
const MAX_PARTS = 10000
const MAX_PARTS_PER_REQUEST = 100

const getUploadKey = (
  organizationId: string | null | undefined,
  filename: string,
) => {
  const fileId = crypto.randomUUID()
  const key = `${organizationId || 'org_default'}/raw/${fileId}/${filename}`
  return { fileId, key }
}

const resolvePartConfig = (size: number, requestedPartSize?: number) => {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Invalid size')
  }

  if (!Number.isInteger(size)) {
    throw new Error('Size must be an integer')
  }

  let partSize = requestedPartSize
  if (partSize === undefined) {
    // Calculate optimal part size, but never exceed MAX_PART_SIZE (5GB R2 limit)
    partSize = Math.min(
      MAX_PART_SIZE,
      Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS)),
    )
  }

  if (!Number.isFinite(partSize) || partSize <= 0) {
    throw new Error('Invalid part size')
  }

  if (!Number.isInteger(partSize)) {
    throw new Error('Part size must be an integer')
  }

  if (partSize < MIN_PART_SIZE) {
    throw new Error(`Part size must be at least ${MIN_PART_SIZE} bytes`)
  }

  if (partSize > MAX_PART_SIZE) {
    throw new Error(`Part size must be at most ${MAX_PART_SIZE} bytes`)
  }

  const partCount = Math.ceil(size / partSize)
  if (partCount > MAX_PARTS) {
    throw new Error('Too many parts')
  }

  return { partSize, partCount }
}

const requireUploadAuth = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (authHeader?.startsWith('Bearer ')) {
    return requireApiKey(c, next)
  }

  return requireAuth(c, async () => {
    const session = c.var.session
    c.set('organizationId', session?.activeOrganizationId)
    c.set('userId', session?.userId)
    await next()
  })
})


/**
 * Uploads can be turned off for an installation (`UPLOADS_ENABLED=false`), which
 * is what makes a deployment valid without a raw bucket. Until now the flag was
 * reported by `/health/config` and enforced nowhere: the dashboard said uploads
 * were off while the API kept accepting them.
 *
 * Deletion (`DELETE /:fileId`) is deliberately not gated — it is not an upload,
 * and refusing it would strand bytes.
 */
const requireUploadsEnabled = createMiddleware(async (c, next) => {
  if (!c.var.runtime.config.uploadsEnabled) {
    return c.json(
      { error: 'Uploads are disabled on this deployment (UPLOADS_ENABLED=false)' },
      403,
    )
  }
  await next()
})

app.use('/url', requireUploadsEnabled)
app.use('/complete', requireUploadsEnabled)
app.use('/multipart/*', requireUploadsEnabled)
app.use('/token', requireUploadsEnabled)

app.use('/*', requireUploadAuth)

/** Parse `1h` / `30m` / `24h` into seconds, rejecting anything over a day. */
function parseUploadTokenExpiry(value: unknown): { seconds: number; error?: string } {
  if (value === undefined) return { seconds: 3600 }
  if (typeof value !== 'string') return { seconds: 3600, error: 'expires_in must be a string' }

  const match = value.trim().match(/^(\d+)(s|m|h|d)$/)
  if (!match) {
    return { seconds: 3600, error: 'expires_in must look like "30m", "1h" or "24h"' }
  }

  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
  const seconds = parseInt(match[1], 10) * multipliers[match[2]]
  if (seconds > 86400) return { seconds, error: 'expires_in cannot exceed 24h' }
  return { seconds }
}

/**
 * POST /api/upload/token
 *
 * Mint an upload token for the signed-in dashboard user.
 *
 * The dashboard then uploads through exactly the path an external integrator
 * uses — `/v1/upload/{create,parts,complete}` with
 * `Authorization: UploadToken ut_…` — instead of its own bespoke multipart
 * routes. Two upload implementations existed before this; keeping one means the
 * documented integration path is the one ClipMux itself exercises.
 */
app.post('/token', async (c) => {
  const session = c.var.session
  const organizationId = session?.activeOrganizationId ?? c.var.organizationId

  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const body: Record<string, unknown> = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}))

  const { seconds, error } = parseUploadTokenExpiry(body.expires_in ?? body.expiresIn)
  if (error) return c.json({ error }, 400)

  let maxFiles = 1
  const rawMaxFiles = body.max_files ?? body.maxFiles
  if (rawMaxFiles !== undefined) {
    const parsed = Number(rawMaxFiles)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return c.json({ error: 'max_files must be an integer between 1 and 100' }, 400)
    }
    maxFiles = parsed
  }

  let maxSizeBytes: number | null = null
  const rawMaxSize = body.max_size_bytes ?? body.maxSizeBytes
  if (rawMaxSize !== undefined && rawMaxSize !== null) {
    const parsed = Number(rawMaxSize)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return c.json({ error: 'max_size_bytes must be a positive integer' }, 400)
    }
    maxSizeBytes = parsed
  }

  const tokenId = `ut_${crypto.randomUUID().replace(/-/g, '')}`
  const tokenValue = `${tokenId}_${crypto.randomUUID().replace(/-/g, '')}`
  const expiresAt = new Date(Date.now() + seconds * 1000)

  await db.insert(uploadToken).values({
    id: tokenId,
    token: tokenValue,
    organizationId,
    // Session-minted, not API-key-minted: the dashboard is not an API client.
    apiKeyId: null,
    maxFiles,
    usedFiles: 0,
    maxSizeBytes,
    expiresAt,
  })

  return c.json({
    upload_token: tokenValue,
    expires_at: expiresAt.toISOString(),
    max_files: maxFiles,
    max_size_bytes: maxSizeBytes,
  })
})

// Single file upload (for smaller files)
app.post('/url', async (c) => {
  const organizationId = c.var.organizationId
  const userId = c.var.userId

  // INPUT VALIDATION
  const {
    filename,
    contentType,
    size,
    title,
    playbackPolicy,
    generateSubtitle,
    generateChapters,
  } = await c.req.json()
  if (!filename || !contentType) return c.json({ error: 'Missing fields' }, 400)
  const parsedSize = Number(size)
  if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
    return c.json({ error: 'Invalid size' }, 400)
  }
  if (!Number.isInteger(parsedSize)) {
    return c.json({ error: 'Size must be an integer' }, 400)
  }
  const maxBytesUrl = c.var.runtime.config.uploadSizeLimitBytes
  if (parsedSize > maxBytesUrl) {
    return c.json(
      { error: `File exceeds the maximum allowed size (${maxBytesUrl} bytes)` },
      400,
    )
  }

  // Validate: chapters require subtitles (need transcription first)
  const enableSubtitle = generateSubtitle === true || generateChapters === true
  const enableChapters = generateChapters === true && enableSubtitle

  // Ensure user has an active organization
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // GENERATE UNIQUE FILE PATH
  const { fileId, key } = getUploadKey(organizationId, filename)
  const rawBucket = rawBucketOrFail(c)
  if (typeof rawBucket !== 'string') return rawBucket

  console.log(`[UPLOAD CREATED] Inserted video into DB with ID: ${fileId}, key: ${key}, bucket: ${rawBucket}`)

  // CREATE VIDEO ENTRY IN DATABASE with status 'uploading'
  await db.insert(video).values({
    id: fileId,
    organizationId,
    title: title || filename,
    status: 'uploading',
    playbackPolicy: playbackPolicy === 'signed' ? 'signed' : 'public',
    rawKey: key,
    size: parsedSize,
    uploadedBy: userId,
    generateSubtitle: enableSubtitle,
    subtitleStatus: enableSubtitle ? 'pending' : null,
    generateChapters: enableChapters,
    chaptersStatus: enableChapters ? 'pending' : null,
  })

  // GENERATE PRESIGNED URL (For R2)
  const command = new PutObjectCommand({
    Bucket: rawBucket,
    Key: key,
    ContentType: contentType,
    ContentLength: parsedSize,
  })

  // The URL is valid for 1 hour
  const url = await getSignedUrl(r2, command, { expiresIn: 3600 })

  console.log(`[PRESIGNED URL GENERATED] fileId: ${fileId} (single-file PUT)`)

  // Dispatch webhook event
  dispatchWebhook(c.executionCtx, organizationId, 'video.uploading', {
    videoId: fileId,
    title: title || filename,
    status: 'uploading',
  })

  return c.json({
    uploadUrl: url,
    fileId: fileId,
    key: key,
  })
})

app.post('/complete', async (c) => {
  const bucket = rawBucketOrFail(c)
  if (typeof bucket !== 'string') return bucket
  const transcodedBucket = transcodedBucketOrFail(c)
  if (typeof transcodedBucket !== 'string') return transcodedBucket

  const organizationId = c.var.organizationId
  const { fileId, transcodingProvider } = await c.req.json<{
    fileId?: string
    transcodingProvider?: string
  }>()
  console.log(`[UPLOAD COMPLETE REQ] Received /api/upload/complete for fileId: ${fileId}, orgId: ${organizationId}`)
  if (!fileId) return c.json({ error: 'Missing fileId' }, 400)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  // Get the video to retrieve the rawKey
  const videos = await db
    .select()
    .from(video)
    .where(and(notDeleted, eq(video.id, fileId)))
    .limit(1)
  const videoRecord = videos[0]

  if (!videoRecord) {
    console.error(`[UPLOAD COMPLETE ERROR] Video not found in DB: ${fileId}`)
    return c.json({ error: 'Video not found' }, 404)
  }
  if (videoRecord.organizationId !== organizationId) {
    console.error(`[UPLOAD COMPLETE ERROR] Access denied for video ${fileId}: org mismatch`)
    return c.json({ error: 'Access denied' }, 403)
  }

  console.log(`[UPLOAD COMPLETE DB MATCH] Found video record ${fileId}, rawKey: ${videoRecord.rawKey}, status: ${videoRecord.status}`)

  // Only process if status is 'uploading' (idempotency check)
  if (videoRecord.status !== 'uploading') {
    console.log(
      `Video ${fileId} already being processed (status: ${videoRecord.status}), skipping`,
    )
    return c.json({ success: true, fileId, skipped: true })
  }

    // Verify the object actually landed in R2 at the declared size before
    // spending a transcode dispatch on a missing/truncated file.
    const verifyKey = videoRecord.rawKey
    const headSize = verifyKey ? await headObjectSize(bucket, verifyKey) : null
    if (headSize === null || (videoRecord.size !== null && headSize !== videoRecord.size)) {
      await db
        .update(video)
        .set({
          status: 'failed',
          failureCode: headSize === null ? 'OBJECT_MISSING' : 'SIZE_MISMATCH',
          updatedAt: new Date(),
        })
        .where(eq(video.id, fileId))
      return c.json(
        {
          error:
            headSize === null
              ? 'File was not uploaded; please upload the file again'
              : 'Uploaded file size does not match the declared size; abort and re-upload',
        },
        409,
      )
    }

    // Dispatch the transcode job BEFORE flipping state: a failed dispatch must
    // never leave the row stuck in 'processing'. triggerTranscoding throws a
    // typed DispatchError on final failure.
    if (!videoRecord.rawKey) {
      console.error(`[UPLOAD COMPLETE ERROR] Video ${fileId} has no rawKey`)
      await db
        .update(video)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(video.id, fileId))
      return c.json(
        { error: 'Upload has no stored object; please upload the file again' },
        400,
      )
    }

    // Claim the attempt, then dispatch. The claim is the compare-and-swap that
    // records ownership; dispatching without it is how a lost response or a
    // concurrent retry buys a second GPU run. It also performs the
    // uploading -> processing transition that used to be a separate update.
    const dispatchResult = await dispatchWithProvider({
      videoId: fileId,
      rawKey: videoRecord.rawKey,
      rawBucket: c.var.runtime.config.rawBucket,
      organizationId: videoRecord.organizationId,
      playbackPolicy: videoRecord.playbackPolicy || 'public',
      generateSubtitle: videoRecord.generateSubtitle || false,
      generateChapters: videoRecord.generateChapters || false,
      transcodingProvider,
      env: c.var.runtime.env,
    })

    if (!dispatchResult.dispatched) {
      if (dispatchResult.reason === 'dispatch-failed') {
        // dispatchTranscodeJob already marked the row failed.
        console.error(`Failed to queue transcoding for ${fileId}:`, dispatchResult.error)
        return c.json(
          {
            error: `Upload complete but transcoding failed to start: ${dispatchResult.error?.message ?? 'unknown error'}`,
          },
          500,
        )
      }

      // Lost the claim: another caller owns this row, or the org is at its
      // concurrency cap. Not a failure of the upload itself.
      console.log(`Transcode not dispatched for ${fileId}: ${dispatchResult.reason}`)
      return c.json(
        { error: `Transcode not started: ${dispatchResult.reason}`, reason: dispatchResult.reason },
        dispatchFailureStatus(dispatchResult.reason),
      )
    }

    // Dispatch webhook event
    dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'video.uploaded', {
      videoId: fileId,
      title: videoRecord.title,
      status: 'processing',
    })

    return c.json({ success: true, fileId })
})

// Multipart upload - create
app.post('/multipart/create', async (c) => {
  const bucket = rawBucketOrFail(c)
  if (typeof bucket !== 'string') return bucket

  const organizationId = c.var.organizationId
  const userId = c.var.userId

  const {
    filename,
    contentType,
    size,
    partSize: requestedPartSize,
    title,
    playbackPolicy,
    generateSubtitle,
    generateChapters,
  } = await c.req.json()
  if (!filename || !contentType) return c.json({ error: 'Missing fields' }, 400)

  const parsedSize = Number(size)
  const parsedPartSize =
    requestedPartSize === undefined ? undefined : Number(requestedPartSize)

  let partSize: number
  let partCount: number
  try {
    ;({ partSize, partCount } = resolvePartConfig(parsedSize, parsedPartSize))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid input'
    return c.json({ error: message }, 400)
  }

  const maxBytesMp = c.var.runtime.config.uploadSizeLimitBytes
  if (parsedSize > maxBytesMp) {
    return c.json(
      { error: `File exceeds the maximum allowed size (${maxBytesMp} bytes)` },
      400,
    )
  }

  // Ensure user has an active organization
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const { fileId, key } = getUploadKey(organizationId, filename)

  // Validate: chapters require subtitles (need transcription first)
  const enableSubtitle = generateSubtitle === true || generateChapters === true
  const enableChapters = generateChapters === true && enableSubtitle

  // CREATE VIDEO ENTRY IN DATABASE with status 'uploading'
  await db.insert(video).values({
    id: fileId,
    organizationId,
    title: title || filename,
    status: 'uploading',
    playbackPolicy: playbackPolicy === 'signed' ? 'signed' : 'public',
    rawKey: key,
    size: parsedSize,
    uploadedBy: userId,
    generateSubtitle: enableSubtitle,
    subtitleStatus: enableSubtitle ? 'pending' : null,
    generateChapters: enableChapters,
    chaptersStatus: enableChapters ? 'pending' : null,
  })

  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  })

  let response
  try {
    response = await r2.send(command)
  } catch (err) {
    // Rollback: never leave an orphan 'uploading' row behind.
    console.error('Failed to create multipart upload:', err)
    await db.delete(video).where(eq(video.id, fileId))
    return c.json({ error: 'Failed to create multipart upload' }, 500)
  }
  if (!response.UploadId) {
    await db.delete(video).where(eq(video.id, fileId))
    return c.json({ error: 'Failed to create multipart upload' }, 500)
  }

  // Dispatch webhook event
  dispatchWebhook(c.executionCtx, organizationId, 'video.uploading', {
    videoId: fileId,
    title: title || filename,
    status: 'uploading',
  })

  return c.json({
    uploadId: response.UploadId,
    fileId,
    key,
    partSize,
    partCount,
  })
})

// Multipart upload - get signed URLs for parts
app.post('/multipart/parts', async (c) => {
  const bucket = rawBucketOrFail(c)
  if (typeof bucket !== 'string') return bucket

  const organizationId = c.var.organizationId
  const { key, uploadId, partNumbers, size, partSize, fileId } =
    await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  // Security: Verify the user owns this upload via fileId
  if (fileId) {
    const videos = await db
      .select()
      .from(video)
      .where(and(notDeleted, eq(video.id, fileId)))
      .limit(1)

    if (videos.length === 0) {
      return c.json({ error: 'Video not found' }, 404)
    }

    // Verify the video belongs to user's organization
    if (!organizationId || videos[0].organizationId !== organizationId) {
      return c.json({ error: 'Access denied' }, 403)
    }
  }

  if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
    return c.json({ error: 'partNumbers must be a non-empty array' }, 400)
  }

  const parsedSize = Number(size)
  const parsedPartSize = Number(partSize)

  let resolvedPartSize: number
  let partCount: number
  try {
    ;({ partSize: resolvedPartSize, partCount } = resolvePartConfig(
      parsedSize,
      parsedPartSize,
    ))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid input'
    return c.json({ error: message }, 400)
  }

  const uniquePartNumbers = Array.from(
    new Set(
      partNumbers
        .map((partNumber: number) => Number(partNumber))
        .filter((partNumber: number) => Number.isFinite(partNumber)),
    ),
  )

  if (uniquePartNumbers.length === 0) {
    return c.json({ error: 'Invalid partNumbers' }, 400)
  }

  uniquePartNumbers.sort((a, b) => a - b)

  if (uniquePartNumbers.length > MAX_PARTS_PER_REQUEST) {
    return c.json(
      { error: `Too many part_numbers per request (max ${MAX_PARTS_PER_REQUEST})` },
      400,
    )
  }

  for (const partNumber of uniquePartNumbers) {
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > partCount
    ) {
      return c.json({ error: 'partNumbers out of range' }, 400)
    }
  }

  const urls = await Promise.all(
    uniquePartNumbers.map(async (partNumber) => {
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      })
      const url = await getSignedUrl(r2, command, { expiresIn: 3600 })
      const expectedSize =
        partNumber === partCount
          ? parsedSize - (partCount - 1) * resolvedPartSize
          : resolvedPartSize

      return { partNumber, url, size: expectedSize }
    }),
  )

  return c.json({
    uploadId,
    key,
    partSize: resolvedPartSize,
    partCount,
    urls,
  })
})

// Multipart upload - complete
app.post('/multipart/complete', async (c) => {
  const bucket = rawBucketOrFail(c)
  if (typeof bucket !== 'string') return bucket

  const organizationId = c.var.organizationId
  const { key, uploadId, parts, fileId, transcodingProvider } = await c.req.json<{
    key?: string
    uploadId?: string
    parts?: Array<Record<string, unknown>>
    fileId?: string
    transcodingProvider?: string
  }>()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  if (!Array.isArray(parts) || parts.length === 0) {
    return c.json({ error: 'parts must be a non-empty array' }, 400)
  }

  const normalizedParts = parts
    .map((part) => {
      const partNumber = Number(part.partNumber ?? part.PartNumber)
      const etag = part.etag ?? part.ETag
      if (!Number.isInteger(partNumber) || partNumber < 1 || !etag) {
        return null
      }
      const cleanEtag = String(etag).replace(/^"+|"+$/g, '')
      if (!cleanEtag) return null
      return { PartNumber: partNumber, ETag: cleanEtag }
    })
    .filter((part) => part !== null) as Array<{
    PartNumber: number
    ETag: string
  }>

  if (normalizedParts.length === 0) {
    return c.json({ error: 'Invalid parts' }, 400)
  }

  normalizedParts.sort((a, b) => a.PartNumber - b.PartNumber)

  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: normalizedParts,
    },
  })

  const response = await r2.send(command)

  // UPDATE VIDEO STATUS TO 'processing' and queue for transcoding (with idempotency)
  if (fileId) {
    // First check current status
    const videos = await db
      .select()
      .from(video)
      .where(and(notDeleted, eq(video.id, fileId)))
      .limit(1)
    const videoRecord = videos[0]

    if (!videoRecord) {
      return c.json({ error: 'Video not found' }, 404)
    }
    if (videoRecord.organizationId !== organizationId) {
      return c.json({ error: 'Access denied' }, 403)
    }
    if (
      videoRecord.status === 'processing' ||
      videoRecord.status === 'ready'
    ) {
      console.log(
        `Video ${fileId} already processed/processing, skipping transcoding`,
      )
      return c.json({
        location: response.Location,
        bucket: response.Bucket,
        key: response.Key,
        etag: response.ETag,
        fileId,
        skipped: true,
      })
    }

    // Verify the object actually landed in R2 at the declared size before
    // spending a transcode dispatch on a missing/truncated file.
    const verifyKey = videoRecord.rawKey
    const headSize = verifyKey ? await headObjectSize(bucket, verifyKey) : null
    if (headSize === null || (videoRecord.size !== null && headSize !== videoRecord.size)) {
      await db
        .update(video)
        .set({
          status: 'failed',
          failureCode: headSize === null ? 'OBJECT_MISSING' : 'SIZE_MISMATCH',
          updatedAt: new Date(),
        })
        .where(eq(video.id, fileId))
      return c.json(
        {
          error:
            headSize === null
              ? 'File was not uploaded; please upload the file again'
              : 'Uploaded file size does not match the declared size; abort and re-upload',
        },
        409,
      )
    }

    // Claim the attempt, then dispatch (see the note on the single-PUT path).
    const dispatchResult = await dispatchWithProvider({
      videoId: fileId,
      rawKey: key,
      rawBucket: c.var.runtime.config.rawBucket,
      organizationId: videoRecord.organizationId,
      playbackPolicy: videoRecord.playbackPolicy || 'public',
      generateSubtitle: videoRecord.generateSubtitle || false,
      generateChapters: videoRecord.generateChapters || false,
      transcodingProvider,
      env: c.var.runtime.env,
    })

    if (!dispatchResult.dispatched) {
      if (dispatchResult.reason === 'dispatch-failed') {
        // dispatchTranscodeJob already marked the row failed.
        console.error(`Failed to queue transcoding for ${fileId}:`, dispatchResult.error)
        return c.json(
          {
            error: `Upload complete but transcoding failed to start: ${dispatchResult.error?.message ?? 'unknown error'}`,
          },
          500,
        )
      }
      console.log(`Transcode not dispatched for ${fileId}: ${dispatchResult.reason}`)
      return c.json(
        { error: `Transcode not started: ${dispatchResult.reason}`, reason: dispatchResult.reason },
        dispatchFailureStatus(dispatchResult.reason),
      )
    }

    // Dispatch webhook event
    dispatchWebhook(c.executionCtx, videoRecord.organizationId, 'video.uploaded', {
      videoId: fileId,
      title: videoRecord.title,
      status: 'processing',
    })
  }

  return c.json({
    location: response.Location,
    bucket: response.Bucket,
    key: response.Key,
    etag: response.ETag,
    fileId,
  })
})

// Multipart upload - abort
app.post('/multipart/abort', async (c) => {
  const bucket = rawBucketOrFail(c)
  if (typeof bucket !== 'string') return bucket

  const organizationId = c.var.organizationId
  const { key, uploadId, fileId } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)
  if (!organizationId) return c.json({ error: 'No active organization' }, 400)

  await r2.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    }),
  )

  // DELETE video record if fileId provided (user canceled)
  if (fileId) {
    const videos = await db
      .select()
      .from(video)
      .where(and(notDeleted, eq(video.id, fileId)))
      .limit(1)
    const videoRecord = videos[0]

    if (!videoRecord) {
      return c.json({ error: 'Video not found' }, 404)
    }
    if (videoRecord.organizationId !== organizationId) {
      return c.json({ error: 'Access denied' }, 403)
    }

    await db.delete(video).where(eq(video.id, fileId))
  }

  return c.json({ aborted: true, deleted: !!fileId })
})

// Cancel/delete any upload (for single-file uploads or general cleanup)
app.delete('/:fileId', async (c) => {
  const transcodedBucket = transcodedBucketOrFail(c)
  if (typeof transcodedBucket !== 'string') return transcodedBucket

  const bucket = rawBucketOrFail(c)
  if (typeof bucket !== 'string') return bucket

  const organizationId = c.var.organizationId
  const fileId = c.req.param('fileId')

  if (!fileId) {
    return c.json({ error: 'Missing fileId' }, 400)
  }
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // The guard and the write are ONE statement, and it runs before any byte is
  // removed. Reading the row, checking the status in JavaScript and deleting
  // afterwards is what deleted live uploads: `/upload/complete` claims the row
  // for transcoding (uploading -> processing) milliseconds later, so a cancel
  // that had already read `uploading` would still delete the row and its raw
  // object out from under a dispatched job — the Modal worker then 404'd on
  // HeadObject, leaving nothing to retry and no trace in R2.
  const removed = (
    await db
      .delete(video)
      .where(
        and(
          eq(video.id, fileId),
          eq(video.organizationId, organizationId),
          notDeleted,
          inArray(video.status, ['uploading', 'failed']),
        ),
      )
      .returning({ rawKey: video.rawKey, status: video.status })
  )[0]

  if (!removed) {
    // Nothing was removed. Answer exactly as this endpoint always has — gone is
    // idempotent, another tenant is a 403, an in-flight upload is a 400 — and,
    // the point of the ordering, without touching object storage.
    const [existing] = await db
      .select({ organizationId: video.organizationId })
      .from(video)
      .where(and(notDeleted, eq(video.id, fileId)))
      .limit(1)

    if (!existing) {
      // Already deleted, that's fine
      return c.json({ deleted: true, fileId })
    }

    // Verify ownership - video must belong to user's organization
    if (existing.organizationId !== organizationId) {
      return c.json({ error: 'Access denied' }, 403)
    }

    // Only allow deletion of uploads in 'uploading' or 'failed' status
    return c.json({ error: 'Cannot delete video in current status' }, 400)
  }

  console.log(`[UPLOAD CANCEL] removed upload ${fileId} (status ${removed.status})`)

  // Bytes are removed only after the row is confirmed gone, and only through
  // the key the deleted row returned — never a key re-read from a row that may
  // have changed in the meantime.
  const rawKey = removed.rawKey
  if (rawKey) {
    try {
      await r2.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: rawKey,
        }),
      )
    } catch (err) {
      // Log but don't fail - file might not exist in R2 yet
      console.warn(`Failed to delete from R2 raw bucket: ${rawKey}`, err)
    }
  }

  // Delete all transcoded files from R2 transcoded bucket
  // Transcoded files are stored under {videoId}/ prefix
  try {
    // List all objects with the video ID prefix
    const listResponse = await r2.send(
      new ListObjectsV2Command({
        Bucket: transcodedBucket,
        Prefix: `${fileId}/`,
      }),
    )

    if (listResponse.Contents && listResponse.Contents.length > 0) {
      // Batch delete all objects
      const objectsToDelete = listResponse.Contents.map((obj: { Key?: string }) => ({
        Key: obj.Key!,
      }))

      await r2.send(
        new DeleteObjectsCommand({
          Bucket: transcodedBucket,
          Delete: {
            Objects: objectsToDelete,
            Quiet: true,
          },
        }),
      )

      console.log(
        `Deleted ${objectsToDelete.length} transcoded files for video ${fileId}`,
      )
    }

    // Also delete the folder marker object (0-byte object with trailing /)
    await r2.send(
      new DeleteObjectCommand({
        Bucket: transcodedBucket,
        Key: `${fileId}/`,
      }),
    )
  } catch (err) {
    // Log but don't fail - files might not exist in transcoded bucket yet
    console.warn(`Failed to delete from R2 transcoded bucket: ${fileId}/`, err)
  }

  // The row was already removed by the guarded statement above; deleting it
  // again here would be the read-then-write shape this handler just left behind.
  return c.json({ deleted: true, fileId })
})

export default app
