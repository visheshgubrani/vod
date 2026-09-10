/**
 * Public Upload Routes (Upload Token Authentication)
 *
 * These routes allow B2B customer frontends to upload files directly
 * using short-lived upload tokens instead of API keys.
 *
 * Base path: /v1/upload
 */

import { Hono } from 'hono'
import {
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    UploadPartCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq } from 'drizzle-orm'
import {
    requireUploadToken,
    incrementUploadTokenUsage,
} from '../middleware/uploadToken'
import { db } from '../lib/database'
import { maxUploadBytes } from '../lib/config'
import { uploadToken, video } from '../db/schema'
import { notDeleted } from '../db/predicates'
import { headObjectSize, r2 } from '../utils/R2'
import { dispatchTranscodeJob, dispatchFailureStatus } from '../utils/dispatchTranscode'
import { dispatchWebhook } from '../utils/webhookDispatcher'
import type { Bindings, UploadTokenVariables } from '../types'

const app = new Hono<{ Bindings: Bindings; Variables: UploadTokenVariables }>()

const RAW_BUCKET = process.env.RAW_BUCKET_NAME || 'raw-bucket-uploads'
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

console.log('[upload-public] Module loaded')

// Import API key middleware for the token generation endpoint
import { requireApiKey } from '../middleware/apiKey'

// Helper to parse expiration strings like "1h", "30m", "24h"
const parseExpiration = (exp: string): number => {
    const match = exp.match(/^(\d+)(s|m|h|d)$/)
    if (!match) return 3600 // Default to 1 hour
    const [, value, unit] = match
    const multipliers: Record<string, number> = {
        s: 1,
        m: 60,
        h: 3600,
        d: 86400,
    }
    return parseInt(value) * (multipliers[unit] || 3600)
}

/**
 * POST /v1/upload/token
 * 
 * Generate a short-lived upload token for frontend use.
 * This route uses API KEY authentication (Bearer sk_live_xxx).
 * 
 * The returned upload token can then be used for /create, /parts, /complete.
 */
app.post('/token', requireApiKey, async (c) => {
    const organizationId = c.var.organizationId
    const apiKeyId = c.var.apiKeyId

    let expiresIn = '1h'
    let maxFiles = 1
    let maxSizeBytes: number | null = null

    try {
        const body = await c.req.json()
        if (body.expires_in) {
            const seconds = parseExpiration(body.expires_in)
            if (seconds > 86400) {
                return c.json({ error: 'expires_in cannot exceed 24h' }, 400)
            }
            expiresIn = body.expires_in
        }
        if (body.max_files !== undefined) {
            const mf = Number(body.max_files)
            if (!Number.isInteger(mf) || mf < 1 || mf > 100) {
                return c.json({ error: 'max_files must be an integer between 1 and 100' }, 400)
            }
            maxFiles = mf
        }
        if (body.max_size_bytes !== undefined && body.max_size_bytes !== null) {
            const msb = Number(body.max_size_bytes)
            if (!Number.isInteger(msb) || msb < 1) {
                return c.json({ error: 'max_size_bytes must be a positive integer' }, 400)
            }
            maxSizeBytes = msb
        }
    } catch {
        // No body or invalid JSON - use defaults
    }

    // Generate unique token
    const tokenId = `ut_${crypto.randomUUID().replace(/-/g, '')}`
    const tokenValue = `${tokenId}_${crypto.randomUUID().replace(/-/g, '')}`

    // Calculate expiration
    const expiresAtMs = Date.now() + parseExpiration(expiresIn) * 1000
    const expiresAt = new Date(expiresAtMs)

    // Insert token into database
    await db.insert(uploadToken).values({
        id: tokenId,
        token: tokenValue,
        organizationId,
        apiKeyId,
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

// All OTHER routes require upload token authentication
app.use('/*', requireUploadToken)

/**
 * POST /v1/upload/create
 *
 * Create a new multipart upload. Returns presigned URLs for all parts.
 *
 * Headers:
 *   Authorization: UploadToken ut_xxxxx
 *
 * Body:
 *   {
 *     "filename": "video.mp4",
 *     "content_type": "video/mp4",
 *     "size": 104857600,
 *     "title": "My Video",           // Optional
 *     "playback_policy": "public"    // Optional: "public" or "signed"
 *   }
 *
 * Response:
 *   {
 *     "upload_id": "abc123",
 *     "file_id": "uuid",
 *     "key": "org/raw/uuid/filename",
 *     "part_size": 5242880,
 *     "part_count": 20,
 *     "urls": [{ "part_number": 1, "url": "...", "size": 5242880 }, ...]
 *   }
 */
app.post('/create', async (c) => {
    const organizationId = c.var.organizationId
    const uploadTokenRecord = c.var.uploadTokenRecord
    const uploadTokenId = c.var.uploadTokenId

    const body = await c.req.json()
    const filename = body.filename
    const contentType = body.content_type || body.contentType
    const size = Number(body.size)
    const title = body.title
    const playbackPolicy = body.playback_policy || body.playbackPolicy
    const generateSubtitle = body.generate_subtitle === true || body.generateSubtitle === true
    const generateChapters = body.generate_chapters === true || body.generateChapters === true
    console.log(`[create] generateSubtitle=${generateSubtitle} generateChapters=${generateChapters} playbackPolicy=${playbackPolicy}`)

    if (!filename || !contentType) {
        return c.json({ error: 'Missing filename or content_type' }, 400)
    }

    if (!Number.isInteger(size) || size <= 0) {
        return c.json({ error: 'Invalid size' }, 400)
    }

    // Check max size constraint from token
    if (
        uploadTokenRecord.maxSizeBytes &&
        size > uploadTokenRecord.maxSizeBytes
    ) {
        return c.json(
            {
                error: `File size exceeds maximum allowed (${uploadTokenRecord.maxSizeBytes} bytes)`,
            },
            400,
        )
    }

    const maxBytes = maxUploadBytes(c.env)
    if (size > maxBytes) {
        return c.json(
            { error: `File exceeds the maximum allowed size (${maxBytes} bytes)` },
            400,
        )
    }

    let partSize: number
    let partCount: number
    try {
        ; ({ partSize, partCount } = resolvePartConfig(size))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid input'
        return c.json({ error: message }, 400)
    }

    const { fileId, key } = getUploadKey(organizationId, filename)

    // Create video record
    await db.insert(video).values({
        id: fileId,
        organizationId: organizationId!,
        title: title || filename,
        status: 'uploading',
        playbackPolicy: playbackPolicy === 'signed' ? 'signed' : 'public',
        generateSubtitle,
        generateChapters: generateSubtitle ? generateChapters : false,
        rawKey: key,
        size: size,
        uploadedBy: null, // No specific user for B2B token uploads
    })

    // Create multipart upload in R2
    const command = new CreateMultipartUploadCommand({
        Bucket: RAW_BUCKET,
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

    // Increment token usage
    await incrementUploadTokenUsage(uploadTokenId)

    // Presigned URLs are NOT minted up front (10k URLs would exceed payload
    // limits and expire during slow uploads). Clients fetch them in windows
    // via POST /v1/upload/parts (capped at 100 part numbers per request).

    // Dispatch webhook
    dispatchWebhook(c.executionCtx, organizationId!, 'video.uploading', {
        videoId: fileId,
        title: title || filename,
        status: 'uploading',
    })

    return c.json({
        upload_id: response.UploadId,
        file_id: fileId,
        key,
        part_size: partSize,
        part_count: partCount,
    })
})

/**
 * POST /v1/upload/parts
 *
 * Get additional presigned URLs for specific parts (useful for retries).
 */
app.post('/parts', async (c) => {
    const organizationId = c.var.organizationId

    const body = await c.req.json()
    const { key, upload_id, part_numbers, size, file_id } = body
    const uploadId = upload_id || body.uploadId
    const partNumbers = part_numbers || body.partNumbers
    const fileId = file_id || body.fileId

    if (!key || !uploadId) {
        return c.json({ error: 'Missing key or upload_id' }, 400)
    }

    // Verify ownership
    if (fileId) {
        const videos = await db
            .select()
            .from(video)
            .where(and(notDeleted, eq(video.id, fileId)))
            .limit(1)

        if (videos.length === 0) {
            return c.json({ error: 'Video not found' }, 404)
        }

        if (videos[0].organizationId !== organizationId) {
            return c.json({ error: 'Access denied' }, 403)
        }
    }

    if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
        return c.json({ error: 'part_numbers must be a non-empty array' }, 400)
    }

    const parsedSize = Number(size)
    let partSize: number
    let partCount: number
    try {
        ; ({ partSize, partCount } = resolvePartConfig(parsedSize))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid input'
        return c.json({ error: message }, 400)
    }

    const uniquePartNumbers = Array.from(
        new Set(
            partNumbers
                .map((n: number) => Number(n))
                .filter((n: number) => Number.isFinite(n)),
        ),
    )

    if (uniquePartNumbers.length === 0) {
        return c.json({ error: 'Invalid part_numbers' }, 400)
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
            return c.json({ error: 'part_numbers out of range' }, 400)
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
                    ? parsedSize - (partCount - 1) * partSize
                    : partSize

            return { part_number: partNumber, url, size: expectedSize }
        }),
    )

    return c.json({
        upload_id: uploadId,
        key,
        part_size: partSize,
        part_count: partCount,
        urls,
    })
})

/**
 * POST /v1/upload/complete
 *
 * Complete the multipart upload and start transcoding.
 */
app.post('/complete', async (c) => {
    const organizationId = c.var.organizationId

    const body = await c.req.json()
    const { key, parts, file_id } = body
    const uploadId = body.upload_id || body.uploadId
    const fileId = file_id || body.fileId

    if (!key || !uploadId) {
        return c.json({ error: 'Missing key or upload_id' }, 400)
    }

    if (!Array.isArray(parts) || parts.length === 0) {
        return c.json({ error: 'parts must be a non-empty array' }, 400)
    }

    // Normalize parts to AWS format
    const normalizedParts = parts
        .map((part) => {
            const partNumber = Number(part.part_number ?? part.partNumber ?? part.PartNumber)
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

    // Complete multipart upload in R2
    const command = new CompleteMultipartUploadCommand({
        Bucket: RAW_BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
            Parts: normalizedParts,
        },
    })

    const response = await r2.send(command)

    // Update video status and trigger transcoding
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

        if (
            videoRecord.status === 'processing' ||
            videoRecord.status === 'ready'
        ) {
            return c.json({
                location: response.Location,
                bucket: response.Bucket,
                key: response.Key,
                etag: response.ETag,
                file_id: fileId,
                skipped: true,
            })
        }

        // Verify the object actually landed in R2 at the declared size before
        // spending a transcode dispatch on a missing/truncated file.
        const verifyKey = videoRecord.rawKey
        const headSize = verifyKey ? await headObjectSize(RAW_BUCKET, verifyKey) : null
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

        // Claim the attempt, then dispatch — the claim owns the
        // uploading -> processing transition and the attempt id.
        const dispatchResult = await dispatchTranscodeJob({
            videoId: fileId,
            rawKey: key,
            organizationId: videoRecord.organizationId,
            playbackPolicy: videoRecord.playbackPolicy || 'public',
            generateSubtitle: videoRecord.generateSubtitle || false,
            generateChapters: videoRecord.generateChapters || false,
            env: c.env,
        })

        if (!dispatchResult.dispatched) {
            if (dispatchResult.reason === 'dispatch-failed') {
                // dispatchTranscodeJob already marked the row failed.
                console.error(`Failed to queue transcoding for ${fileId}:`, dispatchResult.error)
                return c.json(
                    { error: `Upload complete but transcoding failed to start: ${dispatchResult.error?.message ?? 'unknown error'}` },
                    500,
                )
            }
            return c.json(
                { error: `Transcode not started: ${dispatchResult.reason}`, reason: dispatchResult.reason },
                dispatchFailureStatus(dispatchResult.reason),
            )
        }

        // Dispatch webhook
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
        file_id: fileId,
    })
})

/**
 * POST /v1/upload/abort
 *
 * Abort a multipart upload and clean up.
 */
app.post('/abort', async (c) => {
    const organizationId = c.var.organizationId

    const body = await c.req.json()
    const { key, file_id } = body
    const uploadId = body.upload_id || body.uploadId
    const fileId = file_id || body.fileId

    if (!key || !uploadId) {
        return c.json({ error: 'Missing key or upload_id' }, 400)
    }

    // Abort multipart upload in R2
    await r2.send(
        new AbortMultipartUploadCommand({
            Bucket: RAW_BUCKET,
            Key: key,
            UploadId: uploadId,
        }),
    )

    // Delete video record if exists
    if (fileId) {
        const videos = await db
            .select()
            .from(video)
            .where(and(notDeleted, eq(video.id, fileId)))
            .limit(1)
        const videoRecord = videos[0]

        if (videoRecord && videoRecord.organizationId === organizationId) {
            await db.delete(video).where(eq(video.id, fileId))
        }
    }

    return c.json({ aborted: true, deleted: !!fileId })
})

export default app
