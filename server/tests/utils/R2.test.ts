import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { describe, expect, it } from 'vitest'
import { createR2Client } from '../../src/utils/R2'

/**
 * AWS SDK v3 ≥3.729 defaults to CRC32 checksums on PutObject. Those land in
 * the presigned query string (`x-amz-checksum-crc32`,
 * `x-amz-sdk-checksum-algorithm`) even though the body is not known yet —
 * the browser then PUTs a real file and R2 rejects the checksum. Worked
 * example: a default S3Client presign includes both params; the R2 client
 * must not.
 */
const CHECKSUM_QUERY_PARAMS = [
  'x-amz-checksum-crc32',
  'x-amz-sdk-checksum-algorithm',
]

describe('createR2Client', () => {
  it('presigns browser PUTs without AWS SDK flexible-checksum query params', async () => {
    const client = createR2Client({
      accountId: '49b962322ece3363f6495da349dd9d9e',
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'secret',
    })
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: 'clipmux-raw',
        Key: 'org/raw/id/clip.webm',
        ContentType: 'video/webm',
        ContentLength: 22903955,
      }),
      { expiresIn: 3600 },
    )
    const params = new URL(url).searchParams
    for (const name of CHECKSUM_QUERY_PARAMS) {
      expect(params.has(name), name).toBe(false)
    }
  })
})
