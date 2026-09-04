export type Bindings = {
  // Analytics Engine
  PLAYBACK_ANALYTICS: AnalyticsEngineDataset

  // Secrets (wrangler secrets / .dev.vars)
  DATABASE_URL: string
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  ACCOUNT_ID: string
  FRONTEND_URL: string
  CORS_ORIGINS?: string

  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  MODAL_WEBHOOK_URL: string
  QSTASH_TOKEN: string
  TRANSCODED_BUCKET_URL?: string
  DELIVERY_WORKER_URL: string
  DELIVERY_URL?: string
  BACKEND_URL: string
  MODAL_WEBHOOK_SECRET: string
  JWT_SECRET: string
  RAW_BUCKET_NAME?: string
  TRANSCODED_BUCKET_NAME?: string
  TRANSCODE_INGEST_SECRET?: string
  CLOUDFLARE_ANALYTICS_TOKEN?: string

  // Rate limiting
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
  RATE_LIMIT_PREFIX?: string
  RATE_LIMIT_ANALYTICS?: string
  RATE_LIMIT_AUTH_MAX?: string
  RATE_LIMIT_AUTH_WINDOW?: string
  RATE_LIMIT_API_MAX?: string
  RATE_LIMIT_API_WINDOW?: string
  RATE_LIMIT_ANALYTICS_MAX?: string
  RATE_LIMIT_ANALYTICS_WINDOW?: string

  NODE_ENV?: string
  LOG_LEVEL?: string
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
