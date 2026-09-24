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
 * where the local provider deployed a delivery worker and no API. Those
 * are ordering properties, so they are asserted against a fake port that records
 * every call — printed text cannot prove that the API deploy still happened.
 */

const SECRET = 'a'.repeat(64)

function answers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    target: 'dev',
    db: { kind: 'existing', url: 'postgresql://user:pass@db.example.com/vod' },
    queue: { kind: 'direct' },
    rateLimit: { kind: 'memory' },
    transcodeProvider: 'modal',
    uploadsEnabled: true,
    analyticsEnabled: true,
    accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    r2AccessKeyId: 'r2-key',
    r2SecretAccessKey: 'r2-secret',
    rawBucket: 'clipmux-raw',
    transcodedBucket: 'clipmux-transcoded',
    frontendUrl: 'http://localhost:3000',
    groqApiKey: 'gsk_test',
    ...overrides,
  }
}

function credsEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://user:pass@db.example.com/vod',
    ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    RAW_BUCKET_NAME: 'clipmux-raw',
    TRANSCODED_BUCKET_NAME: 'clipmux-transcoded',
    TRANSCODE_PROVIDER: 'modal',
    TRANSCODE_INGEST_SECRET: SECRET,
    JWT_SECRET: SECRET,
    BETTER_AUTH_SECRET: SECRET,
    ANALYTICS_ENABLED: 'true',
    ANALYTICS_INGEST_SECRET: SECRET,
    BACKEND_URL: 'http://localhost:8787',
    ...overrides,
  }
}

interface Harness {
  port: DeployPort
  calls: string[]
  config: Record<string, string>
  /** Every secret upload, as (package, entries) — the payload matters, not just the call. */
  secrets: Array<{ pkg: 'delivery'; entries: EntryList }>
  /** Warn lines, because an advisory nobody sees is not an advisory. */
  warnings: string[]
  failOn: (call: string, message?: string) => void
  modalAvailable: boolean
  accounts: string[]
  drainDetected: boolean
  drainChecks: number
}

function harness(config: Record<string, string> = credsEnv()): Harness {
  const calls: string[] = []
  const secrets: Harness['secrets'] = []
  const warnings: string[] = []
  const failures = new Map<string, string>()
  const state: Harness = {
    calls,
    secrets,
    warnings,
    config: { ...config },
    modalAvailable: true,
    accounts: ['a1b2c3d4e5f60718293a4b5c6d7e8f90'],
    drainDetected: false,
    drainChecks: 0,
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
    log: {
      step: () => {},
      success: () => {},
      warn: (message) => void warnings.push(message),
      info: () => {},
    },
    confirm: async () => true,
    askPassword: async () => '',
    ensureCfLogin: async () => run('ensureCfLogin', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'),
    cfAccounts: async () => run('cfAccounts', state.accounts),
    ensureBucket: async (name) => void run(`ensureBucket:${name}`, undefined),
    applyBucketCors: async (bucket) => void run(`applyBucketCors:${bucket}`, undefined),
    patchDeliveryBucket: () => run('patchDeliveryBucket', true),
    patchDeliveryAnalytics: (enabled) => run(`patchDeliveryAnalytics:${enabled}`, true),
    offerAnalyticsToken: async () => run('offerAnalyticsToken', null),
    prepareModal: async () => run('prepareModal', state.modalAvailable ? '/repo/transcoding/.venv/bin/modal' : null),
    cleanLegacySecrets: async () => void run('cleanLegacySecrets', undefined),
    uploadModalSecrets: async (_bin, payload) => {
      calls.push('uploadModalSecrets')
      const failure = failures.get('uploadModalSecrets')
      if (failure !== undefined) throw new Error(failure)
      return { callbackHosts: payload.values['ALLOWED_CALLBACK_HOSTS'] ?? null }
    },
    deployModal: async () => run('deployModal', 'https://acme--clipmux-transcode.modal.run'),
    refreshModalCallbacks: async (_bin, payload, previous) =>
      run('refreshModalCallbacks', payload.values['ALLOWED_CALLBACK_HOSTS'] ?? previous),
    deployWorker: async (pkg) =>
      run(`deployWorker:${pkg}`, 'https://clipmux-delivery.acme.workers.dev'),
    putWorkerSecrets: async (pkg, entries) => {
      secrets.push({ pkg, entries })
      run(`putWorkerSecrets:${pkg}`, undefined)
    },
    dbMigrate: async () => void run('dbMigrate', undefined),
    composeBuild: async (input) => void run(`composeBuild:${input.services.join(',')}`, undefined),
    composeMigrate: async () => void run('composeMigrate', undefined),
    composeUp: async (profiles) =>
      void run(profiles && profiles.length > 0 ? `composeUp:${profiles.join(',')}` : 'composeUp', undefined),
    hasDocker: () => true,
    checkHostPorts: async () => void run('checkHostPorts', undefined),
    waitForOrigin: async (origin) => void run(`waitForOrigin:${origin}`, undefined),
    waitForLocalWorker: async (origin) => void run(`waitForLocalWorker:${origin}`, undefined),
    pauseLocalAdmission: async (origin) => run(`pauseLocalAdmission:${origin}`, state.drainDetected),
    assertLocalJobsDrained: async (origin) => {
      const name = `assertLocalJobsDrained:${origin}`
      state.drainChecks += 1
      calls.push(name)
      const failure = failures.get(`${name}#${state.drainChecks}`) ?? failures.get(name)
      if (failure !== undefined) throw new Error(failure)
      return true
    },
    stopLocalWorker: async () => void run('stopLocalWorker', undefined),
    useCfAccount: (id) => void run(`useCfAccount:${id}`, undefined),
    readConfig: () => state.config,
    writeConfig: (updates: EntryList) => {
      for (const [key, value] of updates) state.config[key] = value
    },
    lintConfig: (): { rows: CheckRow[]; failed: boolean } => ({ rows: [], failed: false }),
    probeHealth: async () => void run('probeHealth', undefined),
    probeDeliveryHealth: async (_url, secret) => {
      calls.push(secret ? 'probeDeliveryHealth:secret' : 'probeDeliveryHealth')
      const failure = failures.get('probeDeliveryHealth')
      if (failure !== undefined) throw new Error(failure)
    },
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

describe('runDeployPhase — Modal + delivery (dev target)', () => {
  it('runs the full sequence and reports complete', async () => {
    const h = harness()
    const report = await runDeployPhase('/repo', answers(), h.port)

    expect(report.complete).toBe(true)
    expect(report.result.modalUrl).toContain('modal.run')
    expect(report.result.apiUrl).toBeNull()
    expect(report.result.deliveryUrl).toContain('workers.dev')
    const order = h.calls
    expect(order.indexOf('ensureCfLogin')).toBeLessThan(order.indexOf('ensureBucket:clipmux-raw'))
    expect(order.indexOf('deployWorker:delivery')).toBeLessThan(order.indexOf('putWorkerSecrets:delivery'))
    expect(order.indexOf('putWorkerSecrets:delivery')).toBeLessThan(order.indexOf('probeDeliveryHealth:secret'))
    expect(h.config['MODAL_WEBHOOK_URL']).toContain('modal.run')
    expect(h.config['DELIVERY_URL']).toContain('workers.dev')
    expect(h.calls).not.toContain('deployWorker:server')
  })
})

describe('runDeployPhase — the delivery JWT secret must actually be uploaded', () => {
  it('sends the configured secret to the delivery worker', async () => {
    const h = harness()
    const report = await runDeployPhase('/repo', answers(), h.port)

    const upload = h.secrets.find((entry) => entry.pkg === 'delivery')
    expect(upload?.entries).toEqual([
      ['JWT_SECRET', SECRET],
      ['ANALYTICS_ENABLED', 'true'],
      ['ANALYTICS_INGEST_SECRET', SECRET],
    ])
    expect(report.steps.find((step) => step.id === 'delivery-secret')?.status).toBe('ok')
  })

  // `putWorkerSecrets` drops empty values and returns early *without an error*,
  // so the step used to unwrap it and report "JWT_SECRET uploaded" for a worker
  // that received no signing key at all — a deploy report asserting the exact
  // opposite of the truth, and every signed video 401s.
  for (const [label, value] of [
    ['missing', undefined],
    ['blank', ''],
    ['whitespace-only', '   '],
    ['shorter than 32 characters', 'tooshort'],
  ] as const) {
    it(`fails the step when JWT_SECRET is ${label}`, async () => {
      const env = credsEnv()
      if (value === undefined) delete env['JWT_SECRET']
      else env['JWT_SECRET'] = value
      const h = harness(env)

      const report = await runDeployPhase('/repo', answers(), h.port)

      expect(report.steps.find((step) => step.id === 'delivery-secret')?.status).toBe('failed')
      expect(report.complete).toBe(false)
      // Nothing was uploaded for delivery, so nothing may claim it was.
      expect(h.secrets.filter((entry) => entry.pkg === 'delivery')).toEqual([])
      expect(h.calls).not.toContain('putWorkerSecrets:delivery')
    })
  }
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
    expect(h.calls).not.toContain('deployWorker:server')
    expect(report.result.apiUrl).toBeNull()
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
    // Migrations on the dev target are left to `pnpm db:migrate`.
    expect(h.calls).not.toContain('dbMigrate')
    expect(h.calls).not.toContain('deployWorker:delivery')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(report.complete).toBe(false)
    const unfinished = unfinishedSteps(report)
    expect(unfinished.find((step) => step.id === 'cf-login')?.resume).toContain('wrangler login')
  })

  it('does not attempt Compose when the migration failed on the deploy target', async () => {
    const h = harness({ POSTGRES_PASSWORD: SECRET, JWT_SECRET: SECRET, ANALYTICS_INGEST_SECRET: SECRET })
    h.failOn('composeMigrate', 'database unreachable')

    const report = await runDeployPhase(
      '/repo',
      answers({
        target: 'deploy',
        db: { kind: 'local' },
        transcodeProvider: 'local',
        uploadsEnabled: false,
      }),
      h.port,
    )

    expect(report.steps.find((step) => step.id === 'migrate')?.status).toBe('failed')
    expect(report.steps.find((step) => step.id === 'api')?.status).toBe('blocked')
    expect(h.calls).not.toContain('composeUp')
    expect(report.complete).toBe(false)
  })
})

describe('runDeployPhase — local provider', () => {
  it('never touches Modal, and still deploys the delivery worker and the API', async () => {
    const h = harness(credsEnv({ TRANSCODE_PROVIDER: 'local', UPLOADS_ENABLED: 'false' }))
    const report = await runDeployPhase(
      '/repo',
      answers({ transcodeProvider: 'local', uploadsEnabled: false, rawBucket: '' }),
      h.port,
    )

    expect(h.calls).not.toContain('prepareModal')
    expect(h.calls).not.toContain('uploadModalSecrets')
    expect(h.calls).not.toContain('deployModal')
    // The bug this replaces: the local path deployed delivery and stopped.
    expect(h.calls).toContain('deployWorker:delivery')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(h.calls).not.toContain('dbMigrate')
    // No raw bucket and no CORS: nothing uploads.
    expect(h.calls).not.toContain('ensureBucket:clipmux-raw')
    expect(h.calls).toContain('ensureBucket:clipmux-transcoded')
    expect(h.calls).not.toContain('applyBucketCors:clipmux-raw')
    expect(report.complete).toBe(true)
  })
})

describe('runDeployPhase — deploy target', () => {

  it('pauses admission, checks the queue before rebuilding, then rechecks before stopping the worker', async () => {
    const h = harness(credsEnv({
      TRANSCODE_PROVIDER: 'modal',
      COMPOSE_PROFILES: 'proxy,transcoder',
    }))
    h.drainDetected = true
    const report = await runDeployPhase(
      '/repo',
      answers({ target: 'deploy', db: { kind: 'local' }, transcodeProvider: 'modal' }),
      h.port,
    )

    const order = h.calls
    const firstDrain = order.indexOf('assertLocalJobsDrained:http://localhost:8787')
    const finalDrain = order.lastIndexOf('assertLocalJobsDrained:http://localhost:8787')
    expect(order.indexOf('pauseLocalAdmission:http://localhost:8787')).toBeLessThan(firstDrain)
    expect(firstDrain).toBeLessThan(order.indexOf('composeBuild:api,web'))
    expect(order.indexOf('composeUp:proxy')).toBeLessThan(order.indexOf('stopLocalWorker'))
    expect(order.indexOf('composeUp:proxy')).toBeLessThan(finalDrain)
    expect(finalDrain).toBeLessThan(order.indexOf('stopLocalWorker'))
    expect(order).not.toContain('composeBuild:transcoder')
    expect(h.config['COMPOSE_PROFILES']).toBe('proxy')
    expect(report.steps.find((step) => step.id === 'local-worker-stop')?.status).toBe('ok')
  })

  it('blocks a Modal switch when local jobs are still outstanding', async () => {
    const h = harness(credsEnv({ TRANSCODE_PROVIDER: 'modal' }))
    h.drainDetected = true
    h.failOn('assertLocalJobsDrained:http://localhost:8787', '2 local transcode jobs remain queued or active')
    const report = await runDeployPhase(
      '/repo',
      answers({ target: 'deploy', db: { kind: 'local' }, transcodeProvider: 'modal' }),
      h.port,
    )

    expect(report.steps.find((step) => step.id === 'local-drain')?.status).toBe('failed')
    expect(report.steps.find((step) => step.id === 'build')?.status).toBe('blocked')
    expect(h.calls).not.toContain('composeMigrate')
    expect(h.calls).not.toContain('stopLocalWorker')
  })
  it('does not stop the worker if a final drain check finds newly outstanding work', async () => {
    const h = harness(credsEnv({ TRANSCODE_PROVIDER: 'modal' }))
    h.drainDetected = true
    h.failOn(
      'assertLocalJobsDrained:http://localhost:8787#2',
      '1 local transcode job remains queued or active',
    )
    const report = await runDeployPhase(
      '/repo',
      answers({ target: 'deploy', db: { kind: 'local' }, transcodeProvider: 'modal' }),
      h.port,
    )

    expect(h.drainChecks).toBe(2)
    const stopStep = report.steps.find((step) => step.id === 'local-worker-stop')
    expect(stopStep?.status).toBe('failed')
    expect(stopStep?.resume).toContain('verifies the queue before stopping the worker')
    expect(stopStep?.resume).not.toContain('docker compose --profile transcoder stop')
    expect(h.calls).not.toContain('stopLocalWorker')
  })

  it('migrates and brings up Compose, and never deploys the API worker', async () => {
    const h = harness({ POSTGRES_PASSWORD: SECRET, JWT_SECRET: SECRET, ANALYTICS_INGEST_SECRET: SECRET })
    const report = await runDeployPhase(
      '/repo',
      answers({
        target: 'deploy',
        db: { kind: 'local' },
        transcodeProvider: 'local',
        uploadsEnabled: false,
      }),
      h.port,
    )

    expect(h.calls).toContain('composeMigrate')
    expect(h.calls).toContain('composeUp:transcoder')
    expect(h.calls).not.toContain('dbMigrate')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(report.result.apiUrl).toBe('http://localhost:8787')
    expect(report.complete).toBe(true)
    const order = h.calls
    expect(order.indexOf('composeBuild:api,web')).toBeLessThan(order.indexOf('composeMigrate'))
    expect(order.indexOf('composeMigrate')).toBeLessThan(order.indexOf('composeUp:transcoder'))
  })

  it('says analytics are off when the operator disabled them', async () => {
    const h = harness()
    await runDeployPhase(
      '/repo',
      answers({
        target: 'deploy',
        db: { kind: 'local' },
        transcodeProvider: 'local',
        uploadsEnabled: false,
        analyticsEnabled: false,
      }),
      h.port,
    )

    const advisory = h.warnings.find((line) => line.includes('Analytics are disabled'))
    expect(advisory).toBeDefined()
    expect(advisory).toContain('ANALYTICS_INGEST_SECRET')
    expect(h.calls).not.toContain('probeDeliveryHealth')
    expect(h.calls).not.toContain('probeDeliveryHealth:secret')
    const upload = h.secrets.find((entry) => entry.pkg === 'delivery')
    expect(upload?.entries).toEqual([
      ['JWT_SECRET', SECRET],
      ['ANALYTICS_ENABLED', 'false'],
    ])
  })
})

describe('runDeployPhase — dev target', () => {
  it('deploys the Cloudflare pieces and leaves the local API alone', async () => {
    const h = harness()
    const report = await runDeployPhase('/repo', answers({ db: { kind: 'local' } }), h.port)

    expect(h.calls).toContain('deployWorker:delivery')
    expect(h.calls).not.toContain('deployWorker:server')
    expect(h.calls).not.toContain('composeUp')
    expect(report.steps.find((step) => step.id === 'api')?.status).toBe('skipped')
    expect(report.steps.find((step) => step.id === 'migrate')?.status).toBe('skipped')
    expect(report.complete).toBe(true)
    expect(h.calls).toContain('probeDeliveryHealth:secret')
  })

  it('skips analytics verification when analytics are off', async () => {
    const h = harness()
    await runDeployPhase('/repo', answers({ analyticsEnabled: false }), h.port)

    expect(h.calls).not.toContain('probeDeliveryHealth')
    expect(h.calls).not.toContain('probeDeliveryHealth:secret')
    expect(h.warnings.some((line) => line.includes('Analytics are disabled'))).toBe(true)
  })

  it('does not offer an analytics read token when analytics are off', async () => {
    const h = harness()
    await runDeployPhase('/repo', answers({ analyticsEnabled: false }), h.port)

    expect(h.calls).not.toContain('offerAnalyticsToken')
    expect(h.calls).toContain('patchDeliveryAnalytics:false')
  })

  it('patches analytics dataset bindings on when analytics are enabled', async () => {
    const h = harness()
    await runDeployPhase('/repo', answers(), h.port)

    expect(h.calls).toContain('patchDeliveryAnalytics:true')
    expect(h.calls).toContain('offerAnalyticsToken')
  })
})

describe('runDeployPhase — SWEEP_ENABLED', () => {
  it('defaults SWEEP_ENABLED to true when the config does not set it', async () => {
    const h = harness()
    expect(h.config['SWEEP_ENABLED']).toBeUndefined()

    await runDeployPhase('/repo', answers(), h.port)

    expect(h.config['SWEEP_ENABLED']).toBe('true')
  })

  it('preserves an existing SWEEP_ENABLED=false on a replica', async () => {
    const h = harness(credsEnv({ SWEEP_ENABLED: 'false' }))

    await runDeployPhase('/repo', answers(), h.port)

    expect(h.config['SWEEP_ENABLED']).toBe('false')
  })
})

function hostInstallAnswers(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return answers({
    target: 'deploy',
    db: { kind: 'local' },
    hostInstall: true,
    access: 'localhost',
    transcodeProvider: 'local',
    uploadsEnabled: false,
    frontendUrl: 'http://localhost',
    proxy: {
      enabled: true,
      site: 'http://localhost',
      bindAddress: '127.0.0.1',
      profiles: 'proxy',
    },
    ...overrides,
  })
}

describe('runDeployPhase — host install', () => {
  it('builds images before migrating, then waits for the origin', async () => {
    const h = harness()
    const report = await runDeployPhase('/repo', hostInstallAnswers(), h.port)

    const order = h.calls
    expect(order.indexOf('checkHostPorts')).toBeLessThan(order.indexOf('composeBuild:api,web'))
    expect(order.indexOf('composeBuild:api,web')).toBeLessThan(order.indexOf('composeMigrate'))
    expect(order.indexOf('composeMigrate')).toBeLessThan(order.indexOf('composeUp:proxy,transcoder'))
    expect(order.indexOf('composeUp:proxy,transcoder')).toBeLessThan(order.indexOf('waitForOrigin:http://localhost'))
    expect(order.indexOf('waitForOrigin:http://localhost')).toBeLessThan(order.indexOf('waitForLocalWorker:http://localhost'))
    expect(h.config['COMPOSE_PROFILES']).toBe('proxy,transcoder')
    expect(report.result.apiUrl).toBe('http://localhost')
    expect(report.complete).toBe(true)
  })

  it('makes installation incomplete when origin readiness fails', async () => {
    const h = harness()
    h.failOn('waitForOrigin:http://localhost', 'API reports ready: false')

    const report = await runDeployPhase('/repo', hostInstallAnswers(), h.port)

    expect(report.steps.find((step) => step.id === 'readiness')?.status).toBe('failed')
    expect(report.steps.find((step) => step.id === 'local-worker')?.status).toBe('blocked')
    expect(h.calls).not.toContain('waitForLocalWorker:http://localhost')
    expect(report.complete).toBe(false)
  })

  it('fails when the logged-in Cloudflare account does not match ACCOUNT_ID', async () => {
    const h = harness()
    h.accounts = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']

    const report = await runDeployPhase(
      '/repo',
      hostInstallAnswers({ accountId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
      h.port,
    )

    expect(report.steps.find((step) => step.id === 'cf-login')?.status).toBe('failed')
    expect(report.steps.find((step) => step.id === 'cf-login')?.detail).toMatch(/does not match/)
    expect(report.complete).toBe(false)
  })

  it('requires local worker readiness before reporting a complete install', async () => {
    const h = harness()
    h.failOn('waitForLocalWorker:http://localhost', 'worker heartbeat timed out')

    const report = await runDeployPhase('/repo', hostInstallAnswers(), h.port)

    expect(h.calls).toContain('composeUp:proxy,transcoder')
    expect(report.steps.find((step) => step.id === 'local-worker')?.status).toBe('failed')
    expect(report.complete).toBe(false)
  })

  it('applies the selected Cloudflare account before provisioning resources', async () => {
    const wanted = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const h = harness()
    h.accounts = [wanted]

    await runDeployPhase('/repo', hostInstallAnswers({ accountId: wanted }), h.port)

    expect(h.calls.indexOf(`useCfAccount:${wanted}`)).toBeGreaterThanOrEqual(0)
    expect(h.calls.indexOf(`useCfAccount:${wanted}`)).toBeLessThan(
      h.calls.indexOf('ensureBucket:clipmux-transcoded'),
    )
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
