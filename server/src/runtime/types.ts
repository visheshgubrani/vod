/**
 * The runtime seam: what the application needs from whichever platform runs it.
 *
 * OpenVOD serves the same Hono app from two very different places — Cloudflare
 * Workers (no TCP sockets, bindings instead of env vars, `ctx.waitUntil`, an
 * Analytics Engine binding) and Node (`@hono/node-server`, `process.env`, real
 * sockets, no bindings). Before this module the app discovered which one it was
 * on *implicitly*: a middleware copied `c.env` into `process.env` on every
 * request so that modules which were written against ambient env would work on
 * Workers, and the Node entry asserted `process.env as unknown as Bindings` so
 * the type checker would agree that an `AnalyticsEngineDataset` existed.
 *
 * Now each platform builds one `RuntimeCapabilities` object at its own
 * composition root, and everything downstream receives it. Consequences that
 * matter:
 *
 *  - Adding a platform means writing one composition root, not auditing every
 *    module for which globals happen to exist.
 *  - A capability a platform genuinely lacks (`analytics.canWritePlayback` on
 *    Node) is a value the app can branch on and report, instead of a runtime
 *    surprise on a request.
 *  - Nothing reads ambient state, so a test can build capabilities directly —
 *    including a Workers-shaped one, which was previously impossible because
 *    the Workers path only existed as a side effect of `process.env`.
 */

import type { S3Client } from '@aws-sdk/client-s3'
import type {
  DbTransport,
  EnvLike,
  LogLevel,
  OpenVodConfig,
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

export type AnalyticsWriteSink = 'workers-analytics-engine' | 'none'
export type AnalyticsReadSource = 'cloudflare-sql' | 'none'

/**
 * The resolved answer to "what is this deployment?".
 *
 * Deliberately flat and secret-free: it is what `/health/config` publishes and
 * what the dashboard renders, so an operator can see which provider, transport
 * and store are actually in use rather than inferring it from defaults.
 */
export type DeploymentShape = {
  runtime: RuntimeName
  dbTransport: DbTransport
  rateLimitStore: RateLimitStoreKind
  transcodeProvider: TranscodeProvider
  selfHostedEnabled: boolean
  /** Self-hosted jobs are queued in Postgres; this is the Modal transport. */
  modalDispatch: ModalDispatchTransport
  analyticsWrite: AnalyticsWriteSink
  analyticsRead: AnalyticsReadSource
  uploadsEnabled: boolean
  /** Always the Cloudflare Worker in delivery/ — there is no Node delivery. */
  deliveryRuntime: 'cloudflare-worker'
  deliveryUrl: string | null
}

/** One playback telemetry row, as the delivery client reports it. */
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
}

/**
 * Playback telemetry sink.
 *
 * Write and read are separate capabilities on purpose: writing needs a Workers
 * Analytics Engine *binding*, while reading is an ordinary HTTPS call to the
 * Analytics Engine SQL API and therefore works on both runtimes. A deployment
 * can legitimately report `write: none, read: cloudflare-sql`.
 */
export type AnalyticsPort = {
  canWritePlayback: boolean
  /** Returns how many rows were accepted; always 0 when unavailable. */
  writePlayback(organizationId: string, rows: PlaybackRow[]): number
}

/**
 * Fire-and-forget work that must outlive the response.
 *
 * Workers get `ctx.waitUntil`; Node has no equivalent, so the promise is
 * tracked with a logged catch. Both are expressed here so call sites cannot
 * assume a Workers-only object exists.
 */
export type BackgroundRun = (work: Promise<unknown>, label: string) => void

/**
 * The only thing background work needs from a platform context.
 *
 * Structural rather than `ExecutionContext` so the runtime layer does not depend
 * on either platform's type — Hono's `ExecutionContext`, Cloudflare's global and
 * the Node stand-in all satisfy it.
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
  readonly config: OpenVodConfig
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
   * Upgrade the isolate capabilities for one request.
   *
   * The Workers background runner wraps the *invocation's* `ExecutionContext`,
   * which does not exist until a request arrives, so the app cannot be handed a
   * complete capability set at construction time. Present only on that runtime;
   * when absent the runtime is used as-is.
   */
  readonly forRequest?: (executionCtx: WaitUntilLike) => RuntimeCapabilities
}
