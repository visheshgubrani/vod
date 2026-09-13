/**
 * Cloudflare R2 client (S3 API).
 *
 * Install-once, like `lib/database`: the composition root builds the client from
 * the resolved credentials and installs it, and everything else asks for the
 * installed one. Previously `getR2()` fell back to `process.env`, which worked on
 * Workers only because a per-request middleware copied bindings into
 * `process.env` — so a `c.env`-only credential set silently resolved to nothing.
 *
 * Storage stays R2: it is a fixed part of the architecture (the delivery Worker
 * is bound to the same bucket), not a choosable provider.
 */

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'

export type R2Credentials = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

export function createR2Client(credentials: R2Credentials): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  })
}

let installed: S3Client | null = null

/** Composition roots only. */
export function installR2(client: S3Client): void {
  installed = client
}

/** Uninstall. Tests only. */
export function resetInstalledR2(): void {
  installed = null
}

export function getR2(): S3Client {
  if (!installed) {
    throw new Error(
      'Object storage is not installed: the runtime composition root must call ' +
        'installR2() before the first S3 operation.',
    )
  }
  return installed
}

/** The app-wide handle, so existing call sites keep working. */
export const r2 = new Proxy({} as S3Client, {
  get(_target, prop, receiver) {
    const instance = getR2()
    const value = Reflect.get(instance, prop, receiver)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

/**
 * HEAD an object and return its ContentLength, or null when the object is
 * missing/unreadable. Used to verify uploads actually landed at the declared
 * size before a transcode job is dispatched.
 */
export async function headObjectSize(bucket: string, key: string): Promise<number | null> {
  try {
    const result = await getR2().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return typeof result.ContentLength === 'number' ? result.ContentLength : null
  } catch {
    return null
  }
}
