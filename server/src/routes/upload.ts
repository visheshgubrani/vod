import { Hono } from 'hono'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq, and } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { db } from '../lib/database'
import { video } from '../db/schema'
import { triggerTranscoding } from '../utils/queue'
import { r2 } from '../utils/R2'

const app = new Hono()
const RAW_BUCKET = 'vod-raw-dev'
const MIN_PART_SIZE = 5 * 1024 * 1024
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024
const MAX_PARTS = 10000

const getUploadKey = (
  organizationId: string | null | undefined,
  filename: string
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
      Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS))
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

app.use('/*', requireAuth)

// Single file upload (for smaller files)
app.post('/url', async (c) => {
  const session = c.var.session

  // INPUT VALIDATION
  const { filename, contentType, size, title, playbackPolicy } = await c.req.json()
  if (!filename || !contentType) return c.json({ error: 'Missing fields' }, 400)
  const parsedSize = Number(size)
  if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
    return c.json({ error: 'Invalid size' }, 400)
  }
  if (!Number.isInteger(parsedSize)) {
    return c.json({ error: 'Size must be an integer' }, 400)
  }

  // Ensure user has an active organization
  const organizationId = session.activeOrganizationId
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  // GENERATE UNIQUE FILE PATH
  const { fileId, key } = getUploadKey(organizationId, filename)

  // CREATE VIDEO ENTRY IN DATABASE with status 'uploading'
  await db.insert(video).values({
    id: fileId,
    organizationId,
    title: title || filename,
    status: 'uploading',
    playbackPolicy: playbackPolicy === 'signed' ? 'signed' : 'public',
    rawKey: key,
    size: parsedSize,
    uploadedBy: session.userId,
  })

  // GENERATE PRESIGNED URL (For R2)
  const command = new PutObjectCommand({
    Bucket: RAW_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: parsedSize,
  })

  // The URL is valid for 1 hour
  const url = await getSignedUrl(r2, command, { expiresIn: 3600 })

  return c.json({
    uploadUrl: url,
    fileId: fileId,
    key: key,
  })
})

// Single file upload - complete (called after PUT succeeds)
app.post('/complete', async (c) => {
  const { fileId } = await c.req.json()
  if (!fileId) return c.json({ error: 'Missing fileId' }, 400)

  // Get the video to retrieve the rawKey
  const videos = await db
    .select()
    .from(video)
    .where(eq(video.id, fileId))
    .limit(1)
  const videoRecord = videos[0]

  if (!videoRecord) {
    return c.json({ error: 'Video not found' }, 404)
  }

  // Only process if status is 'uploading' (idempotency check)
  if (videoRecord.status !== 'uploading') {
    console.log(`Video ${fileId} already being processed (status: ${videoRecord.status}), skipping`)
    return c.json({ success: true, fileId, skipped: true })
  }

  // Update video status to 'processing' atomically
  const updated = await db
    .update(video)
    .set({
      status: 'processing',
      updatedAt: new Date(),
    })
    .where(and(eq(video.id, fileId), eq(video.status, 'uploading')))
    .returning()

  // If no rows updated, another request already started processing
  if (updated.length === 0) {
    console.log(`Video ${fileId} processing already started by another request`)
    return c.json({ success: true, fileId, skipped: true })
  }

  // Queue for transcoding
  if (videoRecord.rawKey) {
    try {
      await triggerTranscoding(videoRecord.rawKey, fileId, videoRecord.playbackPolicy || 'public')
    } catch (err) {
      console.error(`Failed to queue transcoding for ${fileId}:`, err)
      // Revert status so user knows it failed and can retry
      await db.update(video).set({ status: 'failed' }).where(eq(video.id, fileId))
      return c.json({ error: 'Upload complete but transcoding failed to start' }, 500)
    }
  }

  return c.json({ success: true, fileId })
})

// Multipart upload - create
app.post('/multipart/create', async (c) => {
  const session = c.var.session

  const {
    filename,
    contentType,
    size,
    partSize: requestedPartSize,
    title,
    playbackPolicy,
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

  // Ensure user has an active organization
  const organizationId = session.activeOrganizationId
  if (!organizationId) {
    return c.json({ error: 'No active organization' }, 400)
  }

  const { fileId, key } = getUploadKey(organizationId, filename)

  // CREATE VIDEO ENTRY IN DATABASE with status 'uploading'
  await db.insert(video).values({
    id: fileId,
    organizationId,
    title: title || filename,
    status: 'uploading',
    playbackPolicy: playbackPolicy === 'signed' ? 'signed' : 'public',
    rawKey: key,
    size: parsedSize,
    uploadedBy: session.userId,
  })

  const command = new CreateMultipartUploadCommand({
    Bucket: RAW_BUCKET,
    Key: key,
    ContentType: contentType,
  })

  const response = await r2.send(command)
  if (!response.UploadId) {
    // Rollback: delete the video entry if R2 upload creation fails
    await db.delete(video).where(eq(video.id, fileId))
    return c.json({ error: 'Failed to create multipart upload' }, 500)
  }

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
  const session = c.var.session
  const { key, uploadId, partNumbers, size, partSize, fileId } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)

  // Security: Verify the user owns this upload via fileId
  if (fileId) {
    const videos = await db
      .select()
      .from(video)
      .where(eq(video.id, fileId))
      .limit(1)
    
    if (videos.length === 0) {
      return c.json({ error: 'Video not found' }, 404)
    }
    
    // Verify the video belongs to user's organization
    if (videos[0].organizationId !== session.activeOrganizationId) {
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
      parsedPartSize
    ))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid input'
    return c.json({ error: message }, 400)
  }

  const uniquePartNumbers = Array.from(
    new Set(
      partNumbers
        .map((partNumber: number) => Number(partNumber))
        .filter((partNumber: number) => Number.isFinite(partNumber))
    )
  )

  if (uniquePartNumbers.length === 0) {
    return c.json({ error: 'Invalid partNumbers' }, 400)
  }

  uniquePartNumbers.sort((a, b) => a - b)

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
        Bucket: RAW_BUCKET,
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
    })
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
  const { key, uploadId, parts, fileId } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)

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
    Bucket: RAW_BUCKET,
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
    const videos = await db.select().from(video).where(eq(video.id, fileId)).limit(1)
    const videoRecord = videos[0]
    
    if (!videoRecord || videoRecord.status === 'processing' || videoRecord.status === 'ready') {
      console.log(`Video ${fileId} already processed/processing, skipping transcoding`)
      return c.json({
        location: response.Location,
        bucket: response.Bucket,
        key: response.Key,
        etag: response.ETag,
        fileId,
        skipped: true,
      })
    }

    // Atomic update - only update if still 'uploading'
    const updated = await db
      .update(video)
      .set({
        status: 'processing',
        updatedAt: new Date(),
      })
      .where(and(eq(video.id, fileId), eq(video.status, 'uploading')))
      .returning()

    // Only queue if we successfully updated the status
    if (updated.length > 0) {
      try {
        const playbackPolicy = videoRecord.playbackPolicy || 'public'
        await triggerTranscoding(key, fileId, playbackPolicy)
      } catch (err) {
        console.error(`Failed to queue transcoding for ${fileId}:`, err)
        // Revert status so user knows it failed and can retry
        await db.update(video).set({ status: 'failed' }).where(eq(video.id, fileId))
        return c.json({ error: 'Upload complete but transcoding failed to start' }, 500)
      }
    } else {
      console.log(`Video ${fileId} status changed, skipping transcoding`)
    }
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
  const { key, uploadId, fileId } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)

  await r2.send(
    new AbortMultipartUploadCommand({
      Bucket: RAW_BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  )

  // DELETE video record if fileId provided (user canceled)
  if (fileId) {
    await db.delete(video).where(eq(video.id, fileId))
  }

  return c.json({ aborted: true, deleted: !!fileId })
})

// Cancel/delete any upload (for single-file uploads or general cleanup)
app.delete('/:fileId', async (c) => {
  const session = c.var.session
  const fileId = c.req.param('fileId')

  if (!fileId) {
    return c.json({ error: 'Missing fileId' }, 400)
  }

  // Get the video record
  const videos = await db
    .select()
    .from(video)
    .where(eq(video.id, fileId))
    .limit(1)
  const videoRecord = videos[0]

  if (!videoRecord) {
    // Already deleted, that's fine
    return c.json({ deleted: true, fileId })
  }

  // Verify ownership - video must belong to user's organization
  if (videoRecord.organizationId !== session.activeOrganizationId) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Only allow deletion of uploads in 'uploading' or 'failed' status
  if (videoRecord.status !== 'uploading' && videoRecord.status !== 'failed') {
    return c.json({ error: 'Cannot delete video in current status' }, 400)
  }

  // Try to delete from R2 if rawKey exists
  if (videoRecord.rawKey) {
    try {
      await r2.send(
        new DeleteObjectCommand({
          Bucket: RAW_BUCKET,
          Key: videoRecord.rawKey,
        })
      )
    } catch (err) {
      // Log but don't fail - file might not exist in R2 yet
      console.warn(`Failed to delete from R2: ${videoRecord.rawKey}`, err)
    }
  }

  // Delete from database
  await db.delete(video).where(eq(video.id, fileId))

  return c.json({ deleted: true, fileId })
})

export default app
