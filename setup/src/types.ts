/**
 * Shared answer types for the OpenVOD bootstrap wizard.
 *
 * One schema drives both the interactive questions and the headless
 * `--answers <file.json>` mode, so a file written for CI is exactly what the
 * TUI would have collected.
 */

export type RuntimeKind = 'workers' | 'compose'
export type DbKind = 'neon' | 'local' | 'existing'
export type QueueKind = 'direct' | 'qstash'
export type RateLimitKind = 'memory' | 'upstash'

export interface DbAnswers {
  kind: DbKind
  /** Required for kind 'neon' | 'existing'. */
  url?: string
}

export interface QueueAnswers {
  kind: QueueKind
  /** Required for kind 'qstash'. */
  token?: string
}

export interface RateLimitAnswers {
  kind: RateLimitKind
  /** Required for kind 'upstash'. */
  restUrl?: string
  token?: string
}

/**
 * Everything the wizard needs to write server/.dev.vars and
 * delivery/.dev.vars. Credentials are never echoed once collected.
 */
export interface WizardAnswers {
  /** API runtime: Cloudflare Worker (default) or Node via Docker Compose. */
  runtime: RuntimeKind
  db: DbAnswers
  queue: QueueAnswers
  rateLimit: RateLimitAnswers
  accountId: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  rawBucket: string
  transcodedBucket: string
  frontendUrl: string
  /** Optional Groq key for AI subtitles/chapters. */
  groqApiKey?: string
}

/** Defaults that keep every prompt short. */
export const DEFAULT_ANSWERS: Pick<
  WizardAnswers,
  'rawBucket' | 'transcodedBucket' | 'frontendUrl'
> = {
  rawBucket: 'openvod-raw',
  transcodedBucket: 'openvod-transcoded',
  frontendUrl: 'http://localhost:3000',
}

export interface SecretSet {
  betterAuthSecret: string
  jwtSecret: string
  internalSweepSecret: string
  transcodeIngestSecret: string
}

/** Choices the CLI flags may prefill (interactive mode only). */
export interface Prefill {
  runtime?: RuntimeKind
  dbKind?: DbKind
  queueKind?: QueueKind
  rateLimitKind?: RateLimitKind
}
