import { Hono } from 'hono'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { Bindings, Variables } from '../types'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../lib/database'
import { video } from '../db/schema'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const RAW_BUCKET = 'vod-raw-dev'
const MIN_PART_SIZE = 5 * 1024 * 1024
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024
const MAX_PARTS = 10000

const createR2Client = (env: Bindings) =>
  new S3Client({
    region: 'auto',
    endpoint: `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  })

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
    partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS))
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
  const db = getDb(c.env.DATABASE_URL)

  // INPUT VALIDATION
  const { filename, contentType, size, title } = await c.req.json()
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
    rawKey: key,
    size: parsedSize,
    uploadedBy: session.userId,
  })

  // GENERATE PRESIGNED URL (For R2)
  const r2 = createR2Client(c.env)

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
  const db = getDb(c.env.DATABASE_URL)

  const { fileId } = await c.req.json()
  if (!fileId) return c.json({ error: 'Missing fileId' }, 400)

  // Update video status to 'processing'
  await db
    .update(video)
    .set({
      status: 'processing',
      updatedAt: new Date(),
    })
    .where(eq(video.id, fileId))

  return c.json({ success: true, fileId })
})

// Multipart upload - create
app.post('/multipart/create', async (c) => {
  const session = c.var.session
  const db = getDb(c.env.DATABASE_URL)

  const {
    filename,
    contentType,
    size,
    partSize: requestedPartSize,
    title,
  } = await c.req.json()
  if (!filename || !contentType) return c.json({ error: 'Missing fields' }, 400)

  const parsedSize = Number(size)
  const parsedPartSize =
    requestedPartSize === undefined ? undefined : Number(requestedPartSize)

  let partSize: number
  let partCount: number
  try {
    ; ({ partSize, partCount } = resolvePartConfig(parsedSize, parsedPartSize))
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
    rawKey: key,
    size: parsedSize,
    uploadedBy: session.userId,
  })

  const r2 = createR2Client(c.env)
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
  const { key, uploadId, partNumbers, size, partSize } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)

  if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
    return c.json({ error: 'partNumbers must be a non-empty array' }, 400)
  }

  const parsedSize = Number(size)
  const parsedPartSize = Number(partSize)

  let resolvedPartSize: number
  let partCount: number
  try {
    ; ({ partSize: resolvedPartSize, partCount } = resolvePartConfig(
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

  const r2 = createR2Client(c.env)
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
  const db = getDb(c.env.DATABASE_URL)

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

  const r2 = createR2Client(c.env)
  const command = new CompleteMultipartUploadCommand({
    Bucket: RAW_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: normalizedParts,
    },
  })

  const response = await r2.send(command)

  // UPDATE VIDEO STATUS TO 'processing'
  if (fileId) {
    await db
      .update(video)
      .set({
        status: 'processing',
        updatedAt: new Date(),
      })
      .where(eq(video.id, fileId))
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
  const db = getDb(c.env.DATABASE_URL)

  const { key, uploadId, fileId } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)

  const r2 = createR2Client(c.env)
  await r2.send(
    new AbortMultipartUploadCommand({
      Bucket: RAW_BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  )

  // UPDATE VIDEO STATUS TO 'failed' if fileId provided
  if (fileId) {
    await db
      .update(video)
      .set({
        status: 'failed',
        updatedAt: new Date(),
      })
      .where(eq(video.id, fileId))
  }

  return c.json({ aborted: true })
})

export default app
