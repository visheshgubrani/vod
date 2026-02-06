export type Bindings = {
  // Buckets
  RAW_BUCKET: string
  PUBLIC_BUCKET: string

  // Secrets (from .dev.vars)
  DATABASE_URL: string
  BETTER_AUTH_SECRET: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  ACCOUNT_ID: string
  FRONTEND_URL: string

  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  MODAL_WEBHOOK_URL: string
  QSTASH_TOKEN: string
  TRANSCODED_BUCKET_URL: string // URL prefix for transcoded content bucket
  DELIVERY_WORKER_URL: string
  BACKEND_URL: string // Backend URL for callbacks (e.g. https://api.streamflow.io)
  MODAL_WEBHOOK_SECRET: string
  PORT: number
}

// Context variables set by API key middleware
export type ApiKeyVariables = {
  organizationId: string
  apiKeyId: string
  userId: string
}

// Context variables set by upload token middleware
export type UploadTokenVariables = {
  organizationId: string
  uploadTokenId: string
  uploadTokenRecord: {
    id: string
    token: string
    organizationId: string
    apiKeyId: string | null
    maxFiles: number | null
    usedFiles: number | null
    maxSizeBytes: number | null
    expiresAt: Date
    createdAt: Date | null
  }
}
