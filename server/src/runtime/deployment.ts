/**
 * Resolve "what is this deployment?" — once, purely, and never by throwing.
 *
 * Every choosable axis is decided here and nowhere else: transcode provider,
 * Modal dispatch transport, rate-limit store, analytics sinks. `RuntimeCapabilities`
 * is then built from this answer, so the composition root contains wiring and
 * no decisions.
 *
 * Two kinds of problem come out:
 *  - **fatal** — the environment cannot work at all. The root refuses to start
 *    (an unrecognised `TRANSCODE_PROVIDER`).
 *  - **non-fatal** — a missing or optional capability. The app boots and
 *    `/health/config` reports it, which is how `database: false` stays visible
 *    rather than becoming a boot crash loop for someone half-configured.
 */

import {
  loadConfig,
  loadProviderSettings,
  parseLogLevel,
  type EnvLike,
  type LogLevel,
  type ClipMuxConfig,
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

function value(env: EnvLike, key: string): string | null {
  const raw = env[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export function resolveDeployment(env: EnvLike): DeploymentResolution {
  const config = loadConfig(env)
  const problems: DeploymentProblem[] = config.problems.map((message) => ({
    message,
    fatal: false,
  }))

  // A wrong provider name silently keeps the old provider; refuse instead.
  const providerSettings = loadProviderSettings(env)
  for (const message of providerSettings.problems) {
    problems.push({ message, fatal: true })
  }

  const rateLimit = resolveRateLimitConfig(env)
  for (const message of rateLimit.problems) {
    problems.push({ message, fatal: true })
  }

  const isProduction = env['NODE_ENV'] === 'production'
  const canForwardPlayback =
    config.analyticsEnabled &&
    Boolean(config.deliveryUrl) &&
    Boolean(config.analyticsIngestSecret)

  const shape: DeploymentShape = {
    runtime: 'node',
    dbTransport: 'postgres-js',
    rateLimitStore: rateLimit.store,
    transcodeProvider: config.transcodeProvider,
    selfHostedEnabled: config.selfHostedEnabled,
    modalDispatch: value(env, 'QSTASH_TOKEN') ? 'qstash' : 'direct-http',
    analyticsEnabled: config.analyticsEnabled,
    analyticsWrite: canForwardPlayback ? 'delivery-worker' : 'none',
    analyticsRead:
      config.analyticsEnabled && config.accountId && config.cloudflareAnalyticsToken
        ? 'cloudflare-sql'
        : 'none',
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
