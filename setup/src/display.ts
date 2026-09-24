/**
 * Display helpers — pure functions for showing answers without leaking
 * secret values (used by the confirmation summary).
 */

import { maskSecret } from './verify'
import type { WizardAnswers } from './types'
import { transcodeProvider } from './mapping'

const SECRET_KEYS = new Set([
  'BETTER_AUTH_SECRET',
  'R2_SECRET_ACCESS_KEY',
  'TRANSCODE_INGEST_SECRET',
  'LOCAL_TRANSCODER_SECRET',
  'JWT_SECRET',
  'ANALYTICS_INGEST_SECRET',
  'INTERNAL_SWEEP_SECRET',
  'QSTASH_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'GROQ_API_KEY',
])

/** Mask userinfo embedded in URLs (e.g. postgres://user:pass@host/db). */
export function maskUrlCreds(url: string): string {
  return url.replace(/\/\/([^@/]*@)/, '//•••••@')
}

export function displayValue(key: string, value: string): string {
  if (SECRET_KEYS.has(key)) return maskSecret(value)
  if (value === '') return '(blank — set after deploy / optional)'
  if (/^https?:\/\//.test(value) && value.includes('@')) return maskUrlCreds(value)
  return value
}

const SERVER_KEY_LABELS: Record<string, string> = {
  DATABASE_URL: 'Postgres URL',
  BETTER_AUTH_SECRET: 'Auth secret (generated)',
  BETTER_AUTH_URL: 'Auth base URL',
  FRONTEND_URL: 'Dashboard origin',
  CORS_ORIGINS: 'CORS origins',
  BACKEND_URL: 'API base URL',
  ACCOUNT_ID: 'Cloudflare account id',
  R2_ACCESS_KEY_ID: 'R2 access key id',
  R2_SECRET_ACCESS_KEY: 'R2 secret access key',
  RAW_BUCKET_NAME: 'Raw bucket',
  TRANSCODED_BUCKET_NAME: 'Transcoded bucket',
  ANALYTICS_ENABLED: 'Analytics collection',
  ANALYTICS_INGEST_SECRET: 'Analytics ingest secret (generated)',
  CLOUDFLARE_ANALYTICS_TOKEN: 'Analytics API token (optional)',
  QSTASH_TOKEN: 'QStash token',
  MODAL_WEBHOOK_URL: 'Modal webhook URL',
  TRANSCODE_INGEST_SECRET: 'Transcode ingest secret (generated)',
  LOCAL_TRANSCODER_SECRET: 'Local worker secret (generated)',
  LOCAL_TRANSCODE_ENABLED: 'Local encoding enabled',
  JWT_SECRET: 'Playback JWT secret (generated)',
  DELIVERY_URL: 'Delivery worker URL',
  INTERNAL_SWEEP_SECRET: 'Sweeper secret (generated)',
  GROQ_API_KEY: 'Groq API key',
  REDIS_URL: 'Redis URL (shared rate-limit store)',
  UPSTASH_REDIS_REST_URL: 'Upstash Redis REST URL',
  UPSTASH_REDIS_REST_TOKEN: 'Upstash Redis token',
}

const RATE_LIMIT_LABELS: Record<WizardAnswers['rateLimit']['kind'], string> = {
  memory: 'in-memory (per instance)',
  redis: 'Redis (shared, your own server)',
  upstash: 'Upstash Redis (shared, hosted)',
}

const PROVIDER_LABELS: Record<'modal' | 'local', string> = {
  modal: 'Modal (GPU in the cloud)',
  local: 'this machine (Docker worker)',
}

/** One-line summary of the decisions for the final confirmation. */
export function summaryText(answers: WizardAnswers): string {
  const target = answers.target ?? 'dev'
  const provider = transcodeProvider(answers)
  const uploads = answers.uploadsEnabled !== false
  const lines = [
    `Configuration: ${target === 'deploy' ? 'deploy — root .env (Docker Compose)' : 'dev — server/.dev.vars'}`,
    'API runtime: Node (postgres-js)',
    `Postgres: ${answers.db.kind === 'local' ? 'the bundled/dev Postgres' : 'existing Postgres URL'}`,
    `Transcoding: ${PROVIDER_LABELS[provider]}`,
    ...(provider === 'modal'
      ? [`Queue: ${answers.queue.kind === 'direct' ? 'direct HTTP → Modal' : 'QStash'}`]
      : []),
    `Rate limiting: ${RATE_LIMIT_LABELS[answers.rateLimit.kind]}`,
    `Browser uploads: ${uploads ? 'enabled (raw bucket required)' : 'disabled (local files only)'}`,
    `Analytics: ${answers.analyticsEnabled === false ? 'disabled' : 'enabled (delivery worker)'}`,
    `Buckets: ${uploads ? `${answers.rawBucket} / ` : ''}${answers.transcodedBucket} (Cloudflare R2)`,
    `Delivery worker: Cloudflare (always required for playback)`,
    `Dashboard origin: ${answers.frontendUrl}`,
    ...(provider === 'modal'
      ? [`Groq AI: ${answers.groqApiKey ? 'configured' : 'skipped'}`]
      : []),
  ]
  return lines.join('\n')
}

export function displayValueForRow(key: string): (value: string) => string {
  return (value: string) => displayValue(key, value)
}

export { SERVER_KEY_LABELS }
