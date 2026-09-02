import { S3Client } from '@aws-sdk/client-s3'
import type { Bindings } from '../types'

let cachedR2: S3Client | null = null
let cachedR2Key: string | null = null

export function getR2(env?: Bindings): S3Client {
  const accountId =
    env?.ACCOUNT_ID ||
    (typeof process !== 'undefined' ? process.env?.ACCOUNT_ID : undefined)
  const accessKeyId =
    env?.R2_ACCESS_KEY_ID ||
    (typeof process !== 'undefined' ? process.env?.R2_ACCESS_KEY_ID : undefined)
  const secretAccessKey =
    env?.R2_SECRET_ACCESS_KEY ||
    (typeof process !== 'undefined'
      ? process.env?.R2_SECRET_ACCESS_KEY
      : undefined)

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 credentials (ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are not configured',
    )
  }

  const key = `${accountId}:${accessKeyId}`
  if (cachedR2 && cachedR2Key === key) {
    return cachedR2
  }

  cachedR2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })
  cachedR2Key = key
  return cachedR2
}

export const r2 = new Proxy({} as S3Client, {
  get(_target, prop, receiver) {
    const instance = getR2()
    const value = Reflect.get(instance, prop, receiver)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

