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
  deployWorker,
  ensureBucket,
  ensureCfLogin,
  makeTempDir,
  patchDeliveryBucket,
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
import { findOnPath, runInherit } from './runners'
import { readTargetConfig, upsertTargetConfig } from './envio'
import { lintDeployEnv, lintServerEnv } from './verify'
import type { ConfigTarget } from './types'
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
  ensureBucket: (name: string) => Promise<void>
  applyBucketCors: (bucket: string, origins: string[]) => Promise<void>
  patchDeliveryBucket: (bucket: string) => boolean
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

  deployWorker: (pkg: 'server' | 'delivery') => Promise<string | null>
  putWorkerSecrets: (pkg: 'server' | 'delivery', entries: EntryList) => Promise<void>
  dbMigrate: (databaseUrl: string) => Promise<void>
  composeMigrate: () => Promise<void>
  composeUp: () => Promise<void>
  hasDocker: () => boolean

  readConfig: () => Record<string, string> | undefined
  writeConfig: (updates: EntryList) => void
  lintConfig: () => { rows: CheckRow[]; failed: boolean }
  probeHealth: (baseUrl: string | null) => Promise<void>
  /** Release the port's resources (temp files). Always called. */
  cleanup: () => void
}

export interface DeployPortOptions {
  root: string
  target: ConfigTarget
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
  const { root, target } = options
  const temp: TempDir = makeTempDir()

  const port: DeployPort = {
    log: {
      step: logStep,
      success: logSuccess,
      warn: logWarn,
      info: logInfo,
    },
    confirm: (message, initialValue) => askConfirm(message, initialValue),
    askPassword: (message) => askPassword(message),

    ensureCfLogin: () => ensureCfLogin(root),
    ensureBucket: (name) => ensureBucket(root, name),
    applyBucketCors: (bucket, origins) => applyBucketCors(root, bucket, origins, temp),
    patchDeliveryBucket: (bucket) => patchDeliveryBucket(root, bucket),

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

    deployWorker: (pkg) => deployWorker(root, pkg),
    putWorkerSecrets: (pkg, entries) => putWorkerSecrets(root, pkg, entries, temp),
    dbMigrate: (databaseUrl) => dbMigrate(root, databaseUrl),
    composeMigrate: async () => {
      const code = await runInherit(['docker', 'compose', 'run', '--rm', 'migrate'], { cwd: root })
      if (code !== 0) {
        throw new Error('docker compose run --rm migrate failed — check the compose logs')
      }
    },
    composeUp: async () => {
      const up = await runInherit(['docker', 'compose', 'up', '-d'], { cwd: root })
      if (up !== 0) throw new Error('docker compose up failed — check the compose logs')
      // The API container has to pick up the URLs the deploy just discovered.
      const api = await runInherit(
        ['docker', 'compose', 'up', '-d', '--force-recreate', '--no-deps', 'api'],
        { cwd: root },
      )
      if (api !== 0) throw new Error('API container recreation failed — check the compose logs')
    },
    hasDocker: () => findOnPath('docker') !== null,

    readConfig: () => readTargetConfig(root, target),
    writeConfig: (updates) => upsertTargetConfig(root, target, updates),
    lintConfig: () => {
      const env = readTargetConfig(root, target) ?? {}
      return target === 'deploy' ? lintDeployEnv(env) : lintServerEnv(env)
    },
    probeHealth,
    cleanup: () => temp.cleanup(),
  }

  return port
}

/** Origins the raw-bucket CORS policy must allow for browser uploads. */
export function bucketCorsOrigins(frontendUrl: string): string[] {
  return browserUploadCorsOrigins(frontendUrl)
}
