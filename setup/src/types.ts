/**
 * Shared answer types for the OpenVOD bootstrap wizard.
 *
 * One schema drives both the interactive questions and the headless
 * `--answers <file.json>` mode, so a file written for CI is exactly what the
 * TUI would have collected.
 */

/**
 * `node` used to be called `compose`, which conflated the API runtime with the
 * Docker deployment shape. They are separate decisions: the Node runtime runs
 * under Docker, under `pnpm dev`, or behind any process manager. `compose` is
 * still accepted from older `--answers` files (see parsers.ts).
 */
export type RuntimeKind = 'workers' | 'node'
/**
 * Which configuration this run owns.
 *
 * OpenVOD keeps two of them, and they are not interchangeable:
 *
 * - `dev`    — `server/.dev.vars` + `delivery/.dev.vars`: running the API on
 *              this machine (`pnpm dev`), or deploying it as a Cloudflare
 *              Worker.
 * - `deploy` — the root `.env`: the Docker Compose stack on a server.
 *
 * A run touches exactly one, and uses it for choices, credentials, deployment
 * and verification. Writing both (which is what the wizard used to do for the
 * Node runtime) is how a Compose deployment ended up reading a `.env` the
 * wizard had stopped updating.
 */
export type ConfigTarget = 'dev' | 'deploy'
export type DbKind = 'neon' | 'local' | 'existing'
export type QueueKind = 'direct' | 'qstash'
/** `redis` is a plain Redis over TCP: Node runtime only, no hosted vendor. */
export type RateLimitKind = 'memory' | 'redis' | 'upstash'

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
  /** API runtime: Cloudflare Worker (default) or Node (Docker/VPS/local). */
  runtime: RuntimeKind
  db: DbAnswers
  queue: QueueAnswers
  rateLimit: RateLimitAnswers
  accountId: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  rawBucket: string
  transcodedBucket: string
  /** 'modal' (default) or 'self-hosted'. Omitted means Modal. */
  transcodeProvider?: 'modal' | 'self-hosted'
  /** Accept new self-hosted submissions. Omitted follows the provider. */
  selfHostedEnabled?: boolean
  /** Accept browser/SDK uploads. Omitted means true. */
  uploadsEnabled?: boolean
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
  /** Password for the bundled Postgres of a Docker deployment (.env only). */
  postgresPassword: string
}

/** Choices the CLI flags may prefill (interactive mode only). */
export interface Prefill {
  runtime?: RuntimeKind
  dbKind?: DbKind
  queueKind?: QueueKind
  rateLimitKind?: RateLimitKind
  transcodeProvider?: 'modal' | 'self-hosted'
  uploadsEnabled?: boolean
}
