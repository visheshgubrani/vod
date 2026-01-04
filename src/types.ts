import { R2Bucket } from '@cloudflare/workers-types'

export type Bindings = {
  // Buckets
  RAW_BUCKET: R2Bucket
  PUBLIC_BUCKET: R2Bucket

  // Secrets (from .dev.vars)
  DATABASE_URL: string
  BETTER_AUTH_SECRET: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  ACCOUNT_ID: string
  FRONTEND_URL: string

  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}
