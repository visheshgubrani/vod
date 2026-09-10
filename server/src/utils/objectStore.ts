/**
 * Object-store operations the cleanup reconciler needs.
 *
 * Declared as an interface, with the S3 implementation below it, so the
 * reconciler can be tested without a bucket. The deletion protocol is
 * list-then-delete-then-confirm-empty, and confirming "empty" is the only way
 * to know a prefix is genuinely reclaimed — a single delete call returning 200
 * does not tell you that.
 */

import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getR2 } from './R2'

export interface ObjectStore {
  /** Every key under `prefix`, paginated. */
  listKeys(bucket: string, prefix: string): Promise<string[]>
  /** Best-effort delete of a single key (idempotent: missing keys are fine). */
  deleteKeys(bucket: string, keys: string[]): Promise<number>
  /**
   * Abort in-flight multipart uploads under a prefix.
   *
   * An unfinished multipart upload holds parts that are billed but invisible to
   * `listKeys`, so without this a failed upload leaks storage that the
   * reconciler would never observe.
   */
  abortMultipartUploads(bucket: string, prefix: string): Promise<number>
}

/** S3 deletes at most 1000 keys per request. */
const DELETE_BATCH = 1000

export const s3ObjectStore: ObjectStore = {
  async listKeys(bucket, prefix) {
    const client = getR2()
    const keys: string[] = []
    let token: string | undefined

    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      )
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key)
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)

    return keys
  },

  async deleteKeys(bucket, keys) {
    if (keys.length === 0) return 0
    const client = getR2()
    let deleted = 0

    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const slice = keys.slice(i, i + DELETE_BATCH)
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
        }),
      )
      // S3 reports partial failure in `Errors` rather than throwing.
      const failed = result.Errors?.length ?? 0
      deleted += slice.length - failed
    }

    return deleted
  },

  async abortMultipartUploads(bucket, prefix) {
    const client = getR2()
    let aborted = 0
    let keyMarker: string | undefined
    let uploadIdMarker: string | undefined

    do {
      const page = await client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      )
      for (const upload of page.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        )
        aborted += 1
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined
      uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined
    } while (keyMarker)

    return aborted
  },
}
