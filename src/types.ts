import { R2Bucket } from '@cloudflare/workers-types'
import { createAuth } from './lib/auth'

type AuthInstance = ReturnType<typeof createAuth>

export type Session = AuthInstance['$Infer']['Session']['session']
export type User = AuthInstance['$Infer']['Session']['user']

export type Variables = {
  user: User
  session: Session
}

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
