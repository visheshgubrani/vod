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
import { Bindings, Variables } from '../types'
import { requireAuth } from '../middleware/auth'

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

app.post('/url', async (c) => {
  const session = c.var.session

  // 2. INPUT VALIDATION
  const { filename, contentType, size } = await c.req.json()
  if (!filename || !contentType) return c.json({ error: 'Missing fields' }, 400)
  const parsedSize = Number(size)
  if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
    return c.json({ error: 'Invalid size' }, 400)
  }
  if (!Number.isInteger(parsedSize)) {
    return c.json({ error: 'Size must be an integer' }, 400)
  }

  // 3. GENERATE UNIQUE FILE PATH
  // Path: org_id/raw/random_id/filename.mp4
  const { fileId, key } = getUploadKey(session.activeOrganizationId, filename)

  // 4. GENERATE PRESIGNED URL (For R2)
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

app.post('/multipart/create', async (c) => {
  const session = c.var.session

  const {
    filename,
    contentType,
    size,
    partSize: requestedPartSize,
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

  const { fileId, key } = getUploadKey(session.activeOrganizationId, filename)

  const r2 = createR2Client(c.env)
  const command = new CreateMultipartUploadCommand({
    Bucket: RAW_BUCKET,
    Key: key,
    ContentType: contentType,
  })

  const response = await r2.send(command)
  if (!response.UploadId) {
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

app.post('/multipart/parts', async (c) => {
  const session = c.var.session

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

app.post('/multipart/complete', async (c) => {
  const session = c.var.session

  const { key, uploadId, parts } = await c.req.json()
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
  return c.json({
    location: response.Location,
    bucket: response.Bucket,
    key: response.Key,
    etag: response.ETag,
  })
})

app.post('/multipart/abort', async (c) => {
  const session = c.var.session

  const { key, uploadId } = await c.req.json()
  if (!key || !uploadId) return c.json({ error: 'Missing fields' }, 400)

  const r2 = createR2Client(c.env)
  await r2.send(
    new AbortMultipartUploadCommand({
      Bucket: RAW_BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  )

  return c.json({ aborted: true })
})

export default app
