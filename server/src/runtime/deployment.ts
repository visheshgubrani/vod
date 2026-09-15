/**
 * Resolve "what is this deployment?" — once, purely, and never by throwing.
 *
 * Every axis the plan calls choosable is decided here and nowhere else:
 * Postgres transport, transcode provider, Modal dispatch transport, rate-limit
 * store, analytics sinks. `RuntimeCapabilities` is then built from this answer,
 * so the composition roots contain wiring and no decisions.
 *
 * Two kinds of problem come out:
 *  - **fatal** — the environment cannot work at all on this runtime. The roots
 *    refuse to start, because the alternative is a deployment that looks healthy
 *    and fails on the second request (`DB_DRIVER=pg` on Workers) or silently
 *    enforces per-isolate limits (a TCP `REDIS_URL` on Workers).
 *  - **non-fatal** — a missing or optional capability. The app boots and
 *    `/health/config` reports it, which is how `database: false` stays visible
 *    rather than becoming a boot crash loop for someone half-configured.
 */

import {
  dbTransportFromEnv,
  loadConfig,
  loadProviderSettings,
  parseLogLevel,
  type EnvLike,
  type LogLevel,
  type ClipMuxConfig,
  type RuntimeName,
} from '../lib/config'
import { resolveRateLimitConfig, type RateLimitConfig } from '../lib/rateLimit'
import type { DeploymentProblem, DeploymentShape } from './types'

export type { DeploymentProblem }

export type DeploymentResolution = {
  config: ClipMuxConfig
  shape: DeploymentShape
  rateLimit: RateLimitConfig
  problems: DeploymentProblem[]
  advisories: string[]
  logLevel: LogLevel
}

export type DeploymentInputs = {
  /**
   * Whether the Workers Analytics Engine binding is actually present.
   *
   * Bindings are not strings, so they cannot appear in the env map this function
   * reads; the Workers root passes what it found. Always false on Node, where
   * playback telemetry has no sink.
   */
  hasPlaybackAnalyticsBinding?: boolean
}

function value(env: EnvLike, key: string): string | null {
  const raw = env[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export function resolveDeployment(
  env: EnvLike,
  runtime: RuntimeName,
  inputs: DeploymentInputs = {},
): DeploymentResolution {
  const config = loadConfig(env)
  const problems: DeploymentProblem[] = config.problems.map((message) => ({
    message,
    fatal: false,
  }))

  const dbTransport = dbTransportFromEnv(env['DB_DRIVER'])

  // ── Impossible combinations ───────────────────────────────────────────────
  if (runtime === 'workers' && dbTransport === 'postgres-js') {
    problems.push({
      fatal: true,
      message:
        'DB_DRIVER=pg cannot work on Cloudflare Workers: the runtime forbids '
        + 'reusing a TCP socket across requests, so the first query succeeds and '
        + 'the rest fail. Set DB_DRIVER=neon-http with a Neon URL, or run the API '
        + 'on Node (`pnpm dev`, or the Docker deployment).',
    })
  }

  // A wrong provider name silently keeps the old provider; refuse instead.
  const providerSettings = loadProviderSettings(env)
  for (const message of providerSettings.problems) {
    problems.push({ message, fatal: true })
  }

  const rateLimit = resolveRateLimitConfig(env, runtime)
  for (const message of rateLimit.problems) {
    problems.push({ message, fatal: true })
  }

  const isProduction = env['NODE_ENV'] === 'production'

  const shape: DeploymentShape = {
    runtime,
    dbTransport,
    rateLimitStore: rateLimit.store,
    transcodeProvider: config.transcodeProvider,
    selfHostedEnabled: config.selfHostedEnabled,
    modalDispatch: value(env, 'QSTASH_TOKEN') ? 'qstash' : 'direct-http',
    analyticsWrite:
      runtime === 'workers' && inputs.hasPlaybackAnalyticsBinding
        ? 'workers-analytics-engine'
        : 'none',
    analyticsRead:
      config.accountId && config.cloudflareAnalyticsToken ? 'cloudflare-sql' : 'none',
    uploadsEnabled: config.uploadsEnabled,
    deliveryRuntime: 'cloudflare-worker',
    deliveryUrl: config.deliveryUrl,
  }

  // `ready` answers "can this deployment work?", and a fatal problem is exactly
  // the case where the answer is no even though every individual setting looked
  // acceptable. `config` is freshly built above, so widening it here cannot
  // affect anyone else's copy.
  if (problems.some((problem) => problem.fatal)) {
    config.ready = false
  }

  return {
    config,
    shape,
    rateLimit,
    problems,
    advisories: config.advisories,
    logLevel: parseLogLevel(env, isProduction),
  }
}

/** Just the fatal messages, for the roots' boot gate. */
export function fatalProblems(resolution: DeploymentResolution): string[] {
  return resolution.problems.filter((problem) => problem.fatal).map((p) => p.message)
}
