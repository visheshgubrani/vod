import { describe, expect, it } from 'vitest'
import {
  deployReportLines,
  deploySummaryLine,
  runDeployPhase,
  unfinishedSteps,
  type DeployReport,
} from '../src/deploy'
import { describeModalAuth } from '../src/modal'
import type { DeployPort } from '../src/deployPort'
import type { EntryList } from '../src/mapping'
import type { CheckRow } from '../src/verify'
import type { WizardAnswers } from '../src/types'

/**
 * The deploy phase is where "some of it worked" used to look like success, and
 * where the self-hosted provider deployed a delivery worker and no API. Those
 * are ordering properties, so they are asserted against a fake port that records
 * every call — printed text cannot prove that the API deploy still happened.
 */

const SECRET = 'a'.repeat(64)

function answers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    target: 'dev',
    runtime: 'workers',
    db: { kind: 'neon', url: 'postgresql://user:pass@ep-x.aws.neon.tech/vod' },
    queue: { kind: 'direct' },
    rateLimit: { kind: 'memory' },
    transcodeProvider: 'modal',
    uploadsEnabled: true,
    accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    r2AccessKeyId: 'r2-key',
    r2SecretAccessKey: 'r2-secret',
    rawBucket: 'openvod-raw',
    transcodedBucket: 'openvod-transcoded',
    frontendUrl: 'http://localhost:3000',
    groqApiKey: 'gsk_test',
    ...overrides,
  }
}

function credsEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://user:pass@ep-x.aws.neon.tech/vod',
    DB_DRIVER: 'neon-http',
    ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    RAW_BUCKET_NAME: 'openvod-raw',
    TRANSCODED_BUCKET_NAME: 'openvod-transcoded',
    TRANSCODE_PROVIDER: 'modal',
    TRANSCODE_INGEST_SECRET: SECRET,
    JWT_SECRET: SECRET,
    BETTER_AUTH_SECRET: SECRET,
    BACKEND_URL: 'https://api.example.workers.dev',
    ...overrides,
  }
}

interface Harness {
  port: DeployPort
  calls: string[]
  config: Record<string, string>
  failOn: (call: string, message?: string) => void
  modalAvailable: boolean
}

function harness(config: Record<string, string> = credsEnv()): Harness {
  const calls: string[] = []
  const failures = new Map<string, string>()
  const state: Harness = {
    calls,
    config: { ...config },
    modalAvailable: true,
    failOn: (call, message = `${call} failed`) => failures.set(call, message),
    port: undefined as unknown as DeployPort,
  }

  const run = <T>(name: string, value: T): T => {
    calls.push(name)
    const failure = failures.get(name)
    if (failure !== undefined) throw new Error(failure)
    return value
  }

  state.port = {
    log: { step: () => {}, success: () => {}, warn: () => {}, info: () => {} },
    confirm: async () => true,
    askPassword: async () => '',
    ensureCfLogin: async () => run('ensureCfLogin', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'),
    ensureBucket: async (name) => void run(`ensureBucket:${name}`, undefined),
    applyBucketCors: async (bucket) => void run(`applyBucketCors:${bucket}`, undefined),
    patchDeliveryBucket: () => run('patchDeliveryBucket', true),
    offerAnalyticsToken: async () => run('offerAnalyticsToken', null),
    prepareModal: async () => run('prepareModal', state.modalAvailable ? '/repo/transcoding/.venv/bin/modal' : null),
    cleanLegacySecrets: async () => void run('cleanLegacySecrets', undefined),
    uploadModalSecrets: async (_bin, payload) => {
      calls.push('uploadModalSecrets')
      const failure = failures.get('uploadModalSecrets')
      if (failure !== undefined) throw new Error(failure)
      return { callbackHosts: payload.values['ALLOWED_CALLBACK_HOSTS'] ?? null }
    },
    deployModal: async () => run('deployModal', 'https://acme--openvod-transcode.modal.run'),
    refreshModalCallbacks: async (_bin, payload, previous) =>
      run('refreshModalCallbacks', payload.values['ALLOWED_CALLBACK_HOSTS'] ?? previous),
    deployWorker: async (pkg) =>
      run(
        `deployWorker:${pkg}`,
        pkg === 'delivery'
          ? 'https://openvod-delivery.acme.workers.dev'
          : 'https://openvod-api.acme.workers.dev',
      ),
    putWorkerSecrets: async (pkg) => void run(`putWorkerSecrets:${pkg}`, undefined),
    dbMigrate: async () => void run('dbMigrate', undefined),
    composeMigrate: async () => void run('composeMigrate', undefined),
    composeUp: async () => void run('composeUp', undefined),
    hasDocker: () => true,
    readConfig: () => state.config,
    writeConfig: (updates: EntryList) => {
      for (const [key, value] of updates) state.config[key] = value
    },
    lintConfig: (): { rows: CheckRow[]; failed: boolean } => ({ rows: [], failed: false }),
    probeHealth: async () => void run('probeHealth', undefined),
    cleanup: () => {},
  }
  return state
}

describe('describeModalAuth', () => {
  it('reports a workspace for an authenticated CLI, and never the token', () => {
    const text = describeModalAuth({ state: 'authenticated', workspace: 'acme' })
    expect(text).toBe('Modal CLI authenticated (workspace acme)')
    expect(text).not.toContain('ak-')
  })

  it('omits the workspace when the CLI did not report one', () => {
    expect(describeModalAuth({ state: 'authenticated', workspace: null })).toBe(
      'Modal CLI authenticated',
    )
  })

  it('says plainly when the credentials are missing or rejected', () => {
    const text = describeModalAuth({ state: 'unauthenticated', workspace: null })
    expect(text).toContain('not authenticated')
    expect(text).toContain('rejected')
  })

  it('describes an unverifiable probe as a question, not a success', () => {
    const text = describeModalAuth({ state: 'unverified', workspace: null })
    expect(text).toContain('could not verify')
    expect(text).not.toContain('authenticated')
  })
})

describe('runDeployPhase — Modal + Workers (dev target)', () => {
  it('runs the full sequence and reports complete', async () => {
    const h = harness()
    const report = await runDeployPhase('/repo', answers(), h.port)

    expect(report.complete).toBe(true)
    expect(report.result.modalUrl).toContain('modal.run')
    expect(report.result.apiUrl).toContain('workers.dev')
    expect(report.result.deliveryUrl).toContain('workers.dev')
    // The API deploy must come after the migration, and the callback refresh
    // after both the Modal and API steps.
    const order = h.calls
    expect(order.indexOf('ensureCfLogin')).toBeLessThan(order.indexOf('ensureBucket:openvod-raw'))
    expect(order.indexOf('dbMigrate')).toBeLessThan(order.indexOf('deployWorker:server'))
    expect(order.indexOf('deployWorker:server')).toBeLessThan(
      order.indexOf('refreshModalCallbacks'),
    )
    expect(h.config['MODAL_WEBHOOK_URL']).toContain('modal.run')
    expect(h.config['DELIVERY_URL']).toContain('workers.dev')
  })
})

describe('runDeployPhase — failures', () => {
  it('keeps deploying the independent steps when Modal fails, and reports incomplete', async () => {
    const h = harness()
    h.failOn('deployModal', 'modal deploy failed')

    const report = await runDeployPhase('/repo', answers(), h.port)

    // The Modal step failed…
    expect(report.steps.find((step) => step.id === 'modal')?.status).toBe('failed')
    // …but the delivery worker, its secret and the API still went out.
    expect(h.calls).toContain('deployWorker:delivery')
    expect(h.calls).toContain('putWorkerSecrets:delivery')
    expect(h.calls).toContain('deployWorker:server')
    expect(report.result.apiUrl).toBe('https://openvod-api.acme.workers.dev')
    // The callback refresh depends on the Modal secret, so it is blocked, not attempted.
    expect(report.steps.find((step) => step.id === 'modal-callbacks')?.status).toBe('blocked')
    expect(h.calls).not.toContain('refreshModalCallbacks')

    expect(report.complete).toBe(false)
    const unfinished = unfinishedSteps(report)
    expect(unfinished.map((step) => step.id)).toEqual(['modal', 'modal-callbacks'])
    expect(unfinished[0].resume).toContain('modal deploy')
    expect(deploySummaryLine(report)).toContain('incomplete')
  })

  it('blocks the Cloudflare-dependent steps when the login fails, and still migrates', async () => {
    const h = harness()
    h.failOn('ensureCfLogin', 'wrangler login did not complete')

    const report = await runDeployPhase('/repo', answers(), h.port)

    for (const id of ['buckets', 'delivery-config', 'modal', 'delivery-worker'] as const) {
      expect(report.steps.find((step) => step.id === id)?.status).toBe('blocked')
    }
    // Migrations do not need Cloudflare, so they still run.
    expect(h.calls).toContain('dbMigrate')
    // Nothing was deployed: the API worker needs wrangler auth too.
    expect(h.calls).not.toContain('deployWorker:delivery')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(report.complete).toBe(false)
    const unfinished = unfinishedSteps(report)
    expect(unfinished.find((step) => step.id === 'cf-login')?.resume).toContain('wrangler login')
  })

  it('does not attempt the API deploy when the migration failed', async () => {
    const h = harness()
    h.failOn('dbMigrate', 'database unreachable')

    const report = await runDeployPhase('/repo', answers(), h.port)

    expect(report.steps.find((step) => step.id === 'migrate')?.status).toBe('failed')
    expect(report.steps.find((step) => step.id === 'api')?.status).toBe('blocked')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(report.complete).toBe(false)
  })
})

describe('runDeployPhase — self-hosted provider', () => {
  it('never touches Modal, and still deploys the delivery worker and the API', async () => {
    const h = harness(credsEnv({ TRANSCODE_PROVIDER: 'self-hosted', UPLOADS_ENABLED: 'false' }))
    const report = await runDeployPhase(
      '/repo',
      answers({ transcodeProvider: 'self-hosted', uploadsEnabled: false, rawBucket: '' }),
      h.port,
    )

    expect(h.calls).not.toContain('prepareModal')
    expect(h.calls).not.toContain('uploadModalSecrets')
    expect(h.calls).not.toContain('deployModal')
    // The bug this replaces: the self-hosted path deployed delivery and stopped.
    expect(h.calls).toContain('deployWorker:delivery')
    expect(h.calls).toContain('deployWorker:server')
    expect(h.calls).toContain('dbMigrate')
    // No raw bucket and no CORS: nothing uploads.
    expect(h.calls).not.toContain('ensureBucket:openvod-raw')
    expect(h.calls).toContain('ensureBucket:openvod-transcoded')
    expect(h.calls).not.toContain('applyBucketCors:openvod-raw')
    expect(report.complete).toBe(true)
  })
})

describe('runDeployPhase — deploy target', () => {
  it('migrates and brings up Compose, and never deploys the API worker', async () => {
    const h = harness({ POSTGRES_PASSWORD: SECRET, JWT_SECRET: SECRET })
    const report = await runDeployPhase(
      '/repo',
      answers({
        target: 'deploy',
        runtime: 'node',
        db: { kind: 'local' },
        transcodeProvider: 'self-hosted',
        uploadsEnabled: false,
      }),
      h.port,
    )

    expect(h.calls).toContain('composeMigrate')
    expect(h.calls).toContain('composeUp')
    expect(h.calls).not.toContain('dbMigrate')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(report.result.apiUrl).toBe('http://localhost:8787')
    expect(report.complete).toBe(true)
  })
})

describe('runDeployPhase — dev target with the Node runtime', () => {
  it('deploys the Cloudflare pieces and leaves the local API alone', async () => {
    const h = harness()
    const report = await runDeployPhase(
      '/repo',
      answers({ runtime: 'node', db: { kind: 'local' } }),
      h.port,
    )

    expect(h.calls).toContain('deployWorker:delivery')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(h.calls).not.toContain('composeUp')
    expect(report.steps.find((step) => step.id === 'api')?.status).toBe('skipped')
    expect(report.steps.find((step) => step.id === 'migrate')?.status).toBe('skipped')
    expect(report.complete).toBe(true)
  })
})

describe('deployReportLines', () => {
  it('lists what is left, with the command that finishes it', () => {
    const report: DeployReport = {
      target: 'dev',
      configPath: '/repo/server/.dev.vars',
      complete: false,
      result: { apiUrl: null, deliveryUrl: null, modalUrl: null },
      steps: [
        { id: 'cf-login', label: 'Cloudflare login & account', status: 'ok' },
        {
          id: 'delivery-worker',
          label: 'Deploy the delivery worker',
          status: 'failed',
          detail: 'no workers.dev URL was parsed',
          resume: 'cd delivery && pnpm exec wrangler deploy',
        },
      ],
    }
    const lines = deployReportLines(report).join('\n')
    expect(lines).toContain('✓ Cloudflare login & account')
    expect(lines).toContain('✗ Deploy the delivery worker')
    expect(lines).toContain('Not finished:')
    expect(lines).toContain('wrangler deploy')
  })
})
