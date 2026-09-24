/**
 * Shared answer types for the ClipMux bootstrap wizard.
 *
 * One schema drives both the interactive questions and the headless
 * `--answers <file.json>` mode, so a file written for CI is exactly what the
 * TUI would have collected.
 */

import type { DeploymentProxyAnswers, PublicAccess } from './origin'

export type { DeploymentProxyAnswers, PublicAccess }

/**
 * Which configuration this run owns.
 *
 * ClipMux keeps two of them, and they are not interchangeable:
 *
 * - `dev`    — `server/.dev.vars` + `delivery/.dev.vars`: running the API on
 *              this machine (`pnpm dev`).
 * - `deploy` — the root `.env`: the Docker Compose stack on a server.
 *
 * A run touches exactly one, and uses it for choices, credentials, deployment
 * and verification. Writing both is how a Compose deployment ended up reading
 * a `.env` the wizard had stopped updating.
 */
export type ConfigTarget = 'dev' | 'deploy'
export type DbKind = 'local' | 'existing'
export type QueueKind = 'direct' | 'qstash'
/** `redis` is a plain Redis over TCP. */
export type RateLimitKind = 'memory' | 'redis' | 'upstash'

export interface DbAnswers {
  kind: DbKind
  /** Required for kind 'existing'. A Neon URL is a regular postgresql:// URL. */
  url?: string
}

export interface QueueAnswers {
  kind: QueueKind
  /** Required for kind 'qstash'. */
  token?: string
}

export interface RateLimitAnswers {
  kind: RateLimitKind
  /** Required for kind 'redis' — e.g. redis://localhost:6379. */
  url?: string
  /** Required for kind 'upstash'. */
  restUrl?: string
  token?: string
}

/**
 * Everything the wizard needs to write server/.dev.vars and
 * delivery/.dev.vars. Credentials are never echoed once collected.
 */
export interface WizardAnswers {
  /** Which configuration file(s) this run owns. Omitted means 'dev'. */
  target?: ConfigTarget
  db: DbAnswers
  queue: QueueAnswers
  rateLimit: RateLimitAnswers
  accountId: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  rawBucket: string
  transcodedBucket: string
  /** Which deployment-level encoder handles new jobs. The wizard defaults to local. */
  transcodeProvider?: 'modal' | 'local'
  /** Accept browser/SDK uploads. Omitted means true. */
  uploadsEnabled?: boolean
  /** Playback/bandwidth analytics. Omitted means true. */
  analyticsEnabled?: boolean
  frontendUrl: string
  /** Optional Groq key for AI subtitles/chapters. */
  groqApiKey?: string
  /**
   * Set by `scripts/install.sh` / `--host-install`. Ordinary bootstrap runs
   * leave this unset so existing answer files keep working.
   */
  hostInstall?: boolean
  /** How the host install is reached. Omitted outside host-install mode. */
  access?: PublicAccess
  /** Caddy / bind / Compose-profile settings. Omitted outside host-install. */
  proxy?: DeploymentProxyAnswers
}

/** Defaults that keep every prompt short. */
export const DEFAULT_ANSWERS: Pick<
  WizardAnswers,
  'rawBucket' | 'transcodedBucket' | 'frontendUrl'
> = {
  rawBucket: 'clipmux-raw',
  transcodedBucket: 'clipmux-transcoded',
  frontendUrl: 'http://localhost:3000',
}

export interface SecretSet {
  betterAuthSecret: string
  jwtSecret: string
  internalSweepSecret: string
  transcodeIngestSecret: string
  localTranscoderSecret: string
  analyticsIngestSecret: string
  /** Password for the bundled Postgres of a Docker deployment (.env only). */
  postgresPassword: string
}

/** Choices the CLI flags may prefill (interactive mode only). */
export interface Prefill {
  dbKind?: DbKind
  queueKind?: QueueKind
  rateLimitKind?: RateLimitKind
  transcodeProvider?: 'modal' | 'local'
  uploadsEnabled?: boolean
  analyticsEnabled?: boolean
  access?: PublicAccess
}
