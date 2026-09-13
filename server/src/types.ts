/**
 * Cloudflare Workers bindings.
 *
 * This is the Workers *platform* shape: strings from `vars`/secrets plus the
 * Analytics Engine dataset, which is a binding object rather than a string. It is
 * no longer the type the rest of the app is written against — that is `EnvLike`
 * (strings) resolved by `lib/config`, or `RuntimeCapabilities` — and it is no
 * longer the type the Node entry pretends to have.
 *
 * `PLAYBACK_ANALYTICS` is optional because it genuinely is: a deployment that
 * removes the binding, and every Node deployment, has no playback telemetry
 * sink. Declaring it required forced a knowingly false
 * `process.env as unknown as Bindings` cast in the Node entry and made the
 * runtime null-check in the analytics route look unreachable.
 */
export type Bindings = {
  // Analytics Engine (Workers only)
  PLAYBACK_ANALYTICS?: AnalyticsEngineDataset

  // Secrets (wrangler secrets / .dev.vars)
  DATABASE_URL: string
  DB_DRIVER?: string
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
  DELIVERY_WORKER_URL: string
  DELIVERY_URL?: string
  BACKEND_URL: string
  MODAL_WEBHOOK_SECRET: string
  JWT_SECRET: string
  RAW_BUCKET_NAME?: string
  TRANSCODED_BUCKET_NAME?: string
  TRANSCODE_INGEST_SECRET?: string
  CLOUDFLARE_ANALYTICS_TOKEN?: string

  // Transcoding provider
  TRANSCODE_PROVIDER?: string
  SELF_HOSTED_ENABLED?: string
  UPLOADS_ENABLED?: string
  TRANSCODE_ORG_CONCURRENCY_CAP?: string
  MAX_UPLOAD_SIZE_BYTES?: string

  // Rate limiting
  REDIS_URL?: string
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

  // Job sweeper (stuck-video recovery)
  INTERNAL_SWEEP_SECRET?: string
  SWEEP_ENABLED?: string
  SWEEP_PROCESSING_STALE_MIN?: string
  SWEEP_UPLOADING_STALE_HOURS?: string
  SWEEP_MAX_ATTEMPTS?: string
  MAINTENANCE_BATCH_SIZE?: string

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
