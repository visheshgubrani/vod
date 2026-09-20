/**
 * The real `DeployPort`: every side effect the deploy phase performs, behind
 * one interface.
 *
 * The graph in deploy.ts decides *what* happens and in which order; this file
 * is the only place that touches Cloudflare, Modal, Docker, the filesystem or
 * the terminal. That split is what makes the ordering testable — a fake port
 * proves that a Modal failure still deploys the API, which no assertion about
 * printed text can.
 */

import type { EntryList } from './mapping'
import type { CheckRow } from './verify'
import type { WizardAnswers } from './types'
import { clipmuxCredsFromEnv, type ModalCredsPayload } from './modal'
import {
  applyBucketCors,
  browserUploadCorsOrigins,
  cfAccountIds,
  deployWorker,
  ensureBucket,
  ensureCfLogin,
  makeTempDir,
  patchDeliveryBucket,
  patchDeliveryAnalytics,
  putWorkerSecrets,
  dbMigrate,
  type TempDir,
} from './cloudflare'
import {
  deleteModalSecret,
  deployModalPipeline,
  forceOverwriteModalSecret,
  legacySecretsPresent,
  listModalSecretNames,
  MODAL_CREDS_SECRET,
  MODAL_GROQ_SECRET,
  prepareModalEnvironment,
  putModalSecret,
} from './modal'
import { analyticsTokenTemplateUrl } from './parsers'
import { lintDeployEnv, lintServerEnv, MIN_SECRET_LENGTH } from './verify'
import { findOnPath, runCapture, runInherit } from './runners'
import { readTargetConfig, upsertTargetConfig } from './envio'
import type { ConfigTarget } from './types'
import { dockerCmd } from './dockerCli'
import { checkHostPorts, type HostPortNeed } from './ports'
import { waitForOriginReady } from './readiness'
import {
  askConfirm,
  askPassword,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  printCheckRows,
} from './ui'

/** Keys whose *values* must never be echoed; everything else in the secret is
 * configuration (bucket names, allowlisted hosts) and is safe to show. */
const CREDS_SECRET_KEYS = new Set([
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'TRANSCODE_INGEST_SECRET',
])

/**
 * Show exactly what was uploaded, masked where it matters.
 *
 * The bucket names and callback hosts are the values most likely to be wrong,
 * and they are not secrets — printing them is what turns "secrets should match
 * the env" from a promise into something the operator can verify.
 */
export function reportCredsPayload(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) =>
    CREDS_SECRET_KEYS.has(key) ? `${key} = ${mask(value)}` : `${key} = ${value}`,
  )
  logInfo(`${MODAL_CREDS_SECRET} (built from the configured env file):\n${lines.join('\n')}`)
}

function mask(value: string): string {
  if (!value) return '(empty)'
  if (value.length <= 8) return '••••'
  return `••••${value.length - 4} chars`
}

export type AgentCredentialStatus =
  | { kind: 'valid' }
  | { kind: 'missing' }
  | { kind: 'rejected'; detail: string }
  | { kind: 'unreachable'; detail: string }

export interface DeployPort {
  log: {
    step: (message: string) => void
    success: (message: string) => void
    warn: (message: string) => void
    info: (message: string) => void
  }
  /** Interactive: may prompt the user. */
  confirm: (message: string, initialValue?: boolean) => Promise<boolean>
  askPassword: (message: string) => Promise<string>

  ensureCfLogin: () => Promise<string | null>
  /** Distinct Cloudflare account ids from `wrangler whoami`. */
  cfAccounts: () => Promise<string[]>
  /** Pin subsequent wrangler provisioning to this Cloudflare account. */
  useCfAccount: (accountId: string) => void
  ensureBucket: (name: string) => Promise<void>
  applyBucketCors: (bucket: string, origins: string[]) => Promise<void>
  patchDeliveryBucket: (bucket: string) => boolean
  /** Add or remove Analytics Engine dataset bindings. */
  patchDeliveryAnalytics: (enabled: boolean) => boolean
  /** Set up the optional Cloudflare analytics read token; null when declined. */
  offerAnalyticsToken: () => Promise<string | null>

  prepareModal: () => Promise<string | null>
  cleanLegacySecrets: (bin: string) => Promise<void>
  uploadModalSecrets: (
    bin: string,
    payload: ModalCredsPayload,
    groqApiKey: string | undefined,
  ) => Promise<{ callbackHosts: string | null }>
  deployModal: (bin: string) => Promise<string | null>
  /** Push new callback hosts; returns the hosts now in the secret. */
  refreshModalCallbacks: (
    bin: string,
    payload: ModalCredsPayload,
    previousHosts: string | null,
  ) => Promise<string | null>

  deployWorker: (pkg: 'delivery') => Promise<string | null>
  putWorkerSecrets: (pkg: 'delivery', entries: EntryList) => Promise<void>
  dbMigrate: (databaseUrl: string) => Promise<void>
  composeBuild: (input: { services: readonly string[]; profiles?: readonly string[] }) => Promise<void>
  composeMigrate: () => Promise<void>
  composeUp: (profiles?: readonly string[]) => Promise<void>
  hasDocker: () => boolean
  checkHostPorts: (needs: readonly HostPortNeed[]) => Promise<void>
  waitForOrigin: (origin: string, requiredChecks?: readonly string[]) => Promise<void>
  pairTranscoder: (code: string) => Promise<void>
  inspectAgentCredential: () => Promise<AgentCredentialStatus>
  agentDoctor: () => Promise<void>
  startTranscoder: () => Promise<void>

  readConfig: () => Record<string, string> | undefined
  writeConfig: (updates: EntryList) => void
  lintConfig: () => { rows: CheckRow[]; failed: boolean }
  probeHealth: (baseUrl: string | null) => Promise<void>
  probeDeliveryHealth: (baseUrl: string | null, ingestSecret: string) => Promise<void>
  /** Release the port's resources (temp files). Always called. */
  cleanup: () => void
}

export interface DeployPortOptions {
  root: string
  target: ConfigTarget
  /** Host installs use wrangler device login (SSH-safe). */
  deviceLogin?: boolean
}

/** Probe `<api>/health/config`, reporting readiness without ever a secret. */
async function probeHealth(baseUrl: string | null): Promise<void> {
  if (!baseUrl) return
  const url = `${baseUrl.replace(/\/+$/, '')}/health/config`
  logInfo(`Probing ${url} …`)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) {
      logWarn(`GET ${url} returned HTTP ${response.status} — check the deployment`)
      return
    }
    const body = (await response.json()) as {
      ready?: boolean
      problems?: string[]
      advisories?: string[]
    }
    if (body.ready) {
      logSuccess('API reports ready: true — open the dashboard /setup page to create an org')
    } else {
      logWarn(
        `API reports ready: false${body.problems?.length ? ` — ${body.problems.join('; ')}` : ''}`,
      )
    }
  } catch {
    logWarn(`could not reach ${url} (is the API up?) — re-check with: curl ${url}`)
  }
}

/**
 * Confirm the delivery worker can write analytics and shares the ingest secret.
 *
 * `/health/config` is secret-free and can report `ingestConfigured: true` while
 * both writer capabilities are `"none"`. An authenticated empty batch is what
 * proves the secret actually matches.
 */
export async function verifyDeliveryAnalytics(input: {
  baseUrl: string
  ingestSecret: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch
  const origin = input.baseUrl.replace(/\/+$/, '')
  const healthUrl = `${origin}/health/config`
  const health = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(20_000) })
  if (!health.ok) {
    throw new Error(`GET ${healthUrl} returned HTTP ${health.status}`)
  }
  const body = (await health.json()) as {
    analyticsEnabled?: boolean
    ingestConfigured?: boolean
    playbackWrite?: string
    bandwidthWrite?: string
  }
  if (body.analyticsEnabled !== true || body.ingestConfigured !== true) {
    throw new Error(
      `delivery ${healthUrl} does not report analytics enabled with an ingest secret ` +
        `(analyticsEnabled=${String(body.analyticsEnabled)}, ingestConfigured=${String(body.ingestConfigured)})`,
    )
  }
  if (body.playbackWrite !== 'analytics-engine' || body.bandwidthWrite !== 'analytics-engine') {
    throw new Error(
      `delivery ${healthUrl} does not have analytics dataset bindings ` +
        `(playbackWrite=${String(body.playbackWrite)}, bandwidthWrite=${String(body.bandwidthWrite)})`,
    )
  }
  if (input.ingestSecret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `ANALYTICS_INGEST_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters — ` +
        'cannot verify ingest',
    )
  }
  const ingestUrl = `${origin}/internal/analytics/playback`
  const ingest = await fetchImpl(ingestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.ingestSecret}`,
    },
    body: JSON.stringify({ events: [] }),
    signal: AbortSignal.timeout(20_000),
  })
  if (ingest.status === 401 || ingest.status === 403) {
    throw new Error(`delivery ingest secret was rejected (HTTP ${ingest.status})`)
  }
  if (!ingest.ok) {
    throw new Error(`delivery empty-batch ingest returned HTTP ${ingest.status}`)
  }
}

/** Probe `<delivery>/health/config` for the enabled analytics capability. */
async function probeDeliveryHealth(baseUrl: string | null, ingestSecret: string): Promise<void> {
  if (!baseUrl) {
    throw new Error('DELIVERY_URL is missing — deploy the delivery worker first')
  }
  logInfo(`Probing ${baseUrl.replace(/\/+$/, '')}/health/config …`)
  await verifyDeliveryAnalytics({ baseUrl, ingestSecret })
  logSuccess('Delivery worker reports analytics enabled')
}

/**
 * Remove the pre-rename Modal secrets, when the workspace still has them.
 *
 * `transcoding/main.py` references only the new names, so the old ones are dead
 * weight — but deleting cloud resources is not a decision this wizard gets to
 * make on its own.
 */
async function cleanLegacySecrets(bin: string): Promise<void> {
  let existing: string[]
  try {
    existing = await listModalSecretNames(bin)
  } catch {
    return
  }
  const legacy = legacySecretsPresent(existing)
  if (legacy.length === 0) return

  logWarn(`this Modal workspace still has the pre-rename secret(s): ${legacy.join(', ')}`)
  const remove = await askConfirm(
    `Delete ${legacy.join(', ')}? The new secrets replace them and nothing references them any more.`,
    true,
  )
  if (!remove) {
    logInfo(`left in place — remove them with: modal secret delete ${legacy.join(' ')}`)
    return
  }
  for (const name of legacy) {
    if (await deleteModalSecret(bin, name)) {
      logSuccess(`Deleted legacy Modal secret ${name}`)
    } else {
      logWarn(`could not delete ${name} — run: modal secret delete ${name}`)
    }
  }
}

export function createDeployPort(options: DeployPortOptions): DeployPort {
  const { root, target, deviceLogin } = options
  const temp: TempDir = makeTempDir()
  let wranglerAccount: string | undefined

  const compose = (...args: string[]): string[] => dockerCmd('compose', ...args)

  const runCompose = async (args: string[], message: string): Promise<void> => {
    const code = await runInherit(compose(...args), { cwd: root })
    if (code !== 0) throw new Error(`${message} — check the compose logs`)
  }

  const runAgent = async (args: string[]): Promise<{ code: number | null; output: string }> => {
    const argv = compose(
      '--profile',
      'transcoder',
      'run',
      '--rm',
      '--no-deps',
      'transcoder',
      '--api',
      'http://api:4080',
      ...args,
    )
    const result = await runCapture(argv, { cwd: root, timeoutMs: 0 })
    return { code: result.code, output: `${result.stdout}\n${result.stderr}` }
  }

  const classifyAgent = (code: number | null, output: string): AgentCredentialStatus => {
    const text = output.toLowerCase()
    if (text.includes('no token') || text.includes('no agent token')) return { kind: 'missing' }
    if (text.includes('rejected')) return { kind: 'rejected', detail: output.trim().split(/\r?\n/).pop() ?? 'rejected' }
    if (code !== 0 && (text.includes('could not reach') || text.includes('connection refused'))) {
      return { kind: 'unreachable', detail: output.trim().split(/\r?\n/).pop() ?? 'could not reach the API' }
    }
    if (code === 0) return { kind: 'valid' }
    return { kind: 'unreachable', detail: output.trim().slice(-200) || 'agent doctor failed' }
  }

  const port: DeployPort = {
    log: {
      step: logStep,
      success: logSuccess,
      warn: logWarn,
      info: logInfo,
    },
    confirm: (message, initialValue) => askConfirm(message, initialValue),
    askPassword: (message) => askPassword(message),

    ensureCfLogin: () => ensureCfLogin(root, { device: deviceLogin === true }),
    cfAccounts: () => cfAccountIds(root),
    useCfAccount: (accountId) => {
      wranglerAccount = accountId
    },
    ensureBucket: (name) => ensureBucket(root, name, wranglerAccount),
    applyBucketCors: (bucket, origins) =>
      applyBucketCors(root, bucket, origins, temp, wranglerAccount),
    patchDeliveryBucket: (bucket) => patchDeliveryBucket(root, bucket),
    patchDeliveryAnalytics: (enabled) => patchDeliveryAnalytics(root, enabled),

    offerAnalyticsToken: async () => {
      const addAnalytics = await askConfirm('Set up optional Cloudflare usage analytics now?', false)
      if (!addAnalytics) return null
      logInfo(
        `Open this Cloudflare token template, create the token, then paste it here:\n${analyticsTokenTemplateUrl()}`,
      )
      const token = await askPassword('Cloudflare Account Analytics Read token')
      return token.trim() === '' ? null : token.trim()
    },

    prepareModal: () => prepareModalEnvironment(root),
    cleanLegacySecrets,
    uploadModalSecrets: async (bin, payload, groqApiKey) => {
      await putModalSecret(bin, MODAL_CREDS_SECRET, payload.values, {
        force: forceOverwriteModalSecret(MODAL_CREDS_SECRET),
        tempDir: temp.path,
      })
      reportCredsPayload(payload.values)
      await putModalSecret(
        bin,
        MODAL_GROQ_SECRET,
        { GROQ_API_KEY: groqApiKey?.trim() || 'unused' },
        { tempDir: temp.path },
      )
      return { callbackHosts: payload.values['ALLOWED_CALLBACK_HOSTS'] ?? null }
    },
    deployModal: (bin) => deployModalPipeline(root, bin),
    refreshModalCallbacks: async (bin, payload, previousHosts) => {
      const hosts = payload.values['ALLOWED_CALLBACK_HOSTS'] ?? null
      if (payload.problems.length > 0) return previousHosts
      if (hosts === null || hosts === previousHosts) return previousHosts
      await putModalSecret(bin, MODAL_CREDS_SECRET, payload.values, {
        force: true,
        tempDir: temp.path,
      })
      return hosts
    },

    deployWorker: (pkg) => deployWorker(root, pkg, wranglerAccount),
    putWorkerSecrets: (pkg, entries) =>
      putWorkerSecrets(root, pkg, entries, temp, wranglerAccount),
    dbMigrate: (databaseUrl) => dbMigrate(root, databaseUrl),
    composeBuild: async (input) => {
      const profiles = (input.profiles ?? []).flatMap((profile) => ['--profile', profile])
      await runCompose([...profiles, 'build', ...input.services], 'docker compose build failed')
    },
    composeMigrate: async () => {
      await runCompose(
        ['--profile', 'tools', 'run', '--rm', 'migrate'],
        'docker compose run --rm migrate failed',
      )
    },
    composeUp: async (profiles) => {
      const extra = (profiles ?? []).flatMap((profile) => ['--profile', profile])
      await runCompose([...extra, 'up', '-d'], 'docker compose up failed')
      await runCompose(
        [...extra, 'up', '-d', '--force-recreate', '--no-deps', 'api'],
        'API container recreation failed',
      )
    },
    hasDocker: () => findOnPath('docker') !== null,
    checkHostPorts,
    waitForOrigin: (origin, requiredChecks) => waitForOriginReady({ origin, requiredChecks }),
    pairTranscoder: async (code) => {
      const result = await runAgent(['pair', '--code', code])
      if (result.code !== 0) {
        throw new Error(result.output.trim().split(/\r?\n/).pop() || 'pairing failed')
      }
    },
    inspectAgentCredential: async () => {
      const result = await runAgent(['doctor'])
      return classifyAgent(result.code, result.output)
    },
    agentDoctor: async () => {
      const result = await runAgent(['doctor'])
      if (result.code !== 0) {
        throw new Error(result.output.trim().slice(-400) || 'agent doctor failed')
      }
    },
    startTranscoder: async () => {
      await runCompose(['--profile', 'transcoder', 'up', '-d', 'transcoder'], 'could not start the transcoder')
    },

    readConfig: () => readTargetConfig(root, target),
    writeConfig: (updates) => upsertTargetConfig(root, target, updates),
    lintConfig: () => {
      const env = readTargetConfig(root, target) ?? {}
      return target === 'deploy' ? lintDeployEnv(env) : lintServerEnv(env)
    },
    probeHealth,
    probeDeliveryHealth,
    cleanup: () => temp.cleanup(),
  }

  return port
}

/** Origins the raw-bucket CORS policy must allow for browser uploads. */
export function bucketCorsOrigins(frontendUrl: string): string[] {
  return browserUploadCorsOrigins(frontendUrl)
}
