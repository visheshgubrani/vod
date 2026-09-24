/**
 * The runtime seam: what the application needs from the Node platform.
 *
 * ClipMux serves the Hono API from Node (`@hono/node-server`, `process.env`,
 * real sockets). Playback telemetry is forwarded to the delivery worker; the
 * Analytics Engine binding itself never lives on this process.
 *
 * Each composition root builds one `RuntimeCapabilities` object, and everything
 * downstream receives it. A capability this process genuinely lacks
 * (`analytics.canWritePlayback` when analytics is off or the ingest secret is
 * missing) is a value the app can branch on and report.
 */

import type { S3Client } from '@aws-sdk/client-s3'
import type {
  DbTransport,
  EnvLike,
  LogLevel,
  ClipMuxConfig,
  RuntimeName,
  TranscodeProvider,
} from '../lib/config'
import type { Db } from '../lib/database'
import type { Logger } from '../lib/logger'
import type { RateLimiterFactory, RateLimitStoreKind } from '../lib/rateLimit'
import type { Auth } from '../lib/auth'

export type { DbTransport }

/** How a *Modal* job is handed to the transcoder. */
export type ModalDispatchTransport = 'direct-http' | 'qstash'

export type AnalyticsWriteSink = 'delivery-worker' | 'none'
export type AnalyticsReadSource = 'cloudflare-sql' | 'none'

/**
 * The resolved answer to "what is this deployment?".
 *
 * Deliberately flat and secret-free: it is what `/health/config` publishes and
 * what the dashboard renders, so an operator can see which provider, transport
 * and store are actually in use rather than inferring it from defaults.
 *
 * `analyticsWrite` is a configured capability, not remote liveness of the
 * delivery worker.
 */
export type DeploymentShape = {
  runtime: RuntimeName
  dbTransport: DbTransport
  rateLimitStore: RateLimitStoreKind
  transcodeProvider: TranscodeProvider
  localTranscodeEnabled: boolean
  /** Local jobs are queued in Postgres; this is the Modal transport. */
  modalDispatch: ModalDispatchTransport
  analyticsEnabled: boolean
  analyticsWrite: AnalyticsWriteSink
  analyticsRead: AnalyticsReadSource
  uploadsEnabled: boolean
  /** Always the Cloudflare Worker in delivery/ — there is no Node delivery. */
  deliveryRuntime: 'cloudflare-worker'
  deliveryUrl: string | null
}

/** One playback telemetry row, as forwarded to the delivery worker. */
export type PlaybackRow = {
  event: string
  videoId: string
  sessionId: string
  userId: string
  country: string
  device: string
  browser: string
  errorCode: string
  watchedDelta: number
  currentTime: number
  duration: number
  organizationId: string
}

/**
 * Playback telemetry sink.
 *
 * Write and read are separate capabilities on purpose: writing forwards rows to
 * the delivery worker, while reading is an ordinary HTTPS call to the Analytics
 * Engine SQL API. A deployment can legitimately report
 * `write: none, read: cloudflare-sql`.
 */
export type AnalyticsPort = {
  canWritePlayback: boolean
  /** Returns how many rows were accepted by the sink; always 0 when unavailable. */
  writePlayback(rows: PlaybackRow[]): Promise<number>
}

/**
 * Fire-and-forget work that must outlive the response.
 *
 * Node has no `ctx.waitUntil`, so the promise is tracked with a logged catch.
 */
export type BackgroundRun = (work: Promise<unknown>, label: string) => void

/**
 * The only thing background work needs from a platform context.
 *
 * Structural rather than `ExecutionContext` so the runtime layer does not depend
 * on Cloudflare types — Hono's `ExecutionContext` and the Node stand-in both
 * satisfy it.
 */
export type WaitUntilLike = {
  waitUntil(work: Promise<unknown>): void
}

/** One configuration problem, and whether it prevents starting at all. */
export type DeploymentProblem = {
  message: string
  /** True when the composition root must refuse to start. */
  fatal: boolean
}

/** Configuration problems and notices, as reported by the boot log. */
export type RuntimeDiagnostics = {
  problems: DeploymentProblem[]
  advisories: string[]
}

export type RuntimeCapabilities = {
  readonly runtime: RuntimeName
  readonly shape: DeploymentShape
  /** Validated configuration, resolved once. */
  readonly config: ClipMuxConfig
  /**
   * The deployment's string environment, resolved once.
   *
   * Kept because a number of deep modules (maintenance sweeps, sweep limits,
   * provider settings) legitimately take an env map as a *parameter*; this is
   * the one map they are all handed.
   */
  readonly env: EnvLike
  readonly logLevel: LogLevel
  readonly db: Db
  readonly objectStore: S3Client
  readonly auth: Auth
  readonly rateLimiter: RateLimiterFactory
  readonly analytics: AnalyticsPort
  readonly background: BackgroundRun
  readonly logger: Logger
  /**
   * Configuration problems and notices for this deployment.
   *
   * Part of the capabilities because the boot log and `GET /health/config` both
   * report them, and re-deriving them per request would resolve the deployment
   * twice.
   */
  readonly problems: DeploymentProblem[]
  readonly advisories: string[]
  /**
   * Process-local maintenance. Present on the Node composition root so the
   * timer and `POST /api/internal/sweep` share one single-flight runner.
   */
  readonly runMaintenancePass?: () => Promise<unknown>
}
