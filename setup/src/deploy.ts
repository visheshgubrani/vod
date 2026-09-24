/**
 * The provision & deploy phase, as a dependency-aware step graph.
 *
 * Three rules shape this file:
 *
 *   1. **Independent steps continue after a failure.** A Modal workspace that
 *      refuses to deploy must not stop the delivery worker, the API or the
 *      migrations — those are the pieces that make the installation usable, and
 *      the operator can finish Modal later with one command.
 *   2. **Dependent steps are skipped, not attempted.** Refreshing the Modal
 *      callback allowlist without an API URL, or deploying the delivery worker
 *      without a patched `wrangler.jsonc`, produces a confident-looking
 *      deployment that cannot work.
 *   3. **An incomplete requested deployment is a failure.** The report is
 *      returned, every unfinished step carries the command that finishes it, and
 *      the caller exits nonzero — "some of it worked" is not success.
 *
 * Every side effect goes through `DeployPort`, so the ordering is testable with
 * a fake port (see setup/tests/deploy.test.ts). Network and auth actions happen
 * only when this runs, which is only when the user asked for a deploy.
 */

import { analyticsEnabled, transcodeProvider, uploadsEnabled } from './mapping'
import type { ConfigTarget, WizardAnswers } from './types'
import { WizardError } from './errors'
import { primaryConfigPath } from './envio'
import { clipmuxCredsFromEnv, MODAL_CREDS_SECRET } from './modal'
import { bucketCorsOrigins, createDeployPort, type DeployPort } from './deployPort'
import { MIN_SECRET_LENGTH } from './verify'
import { hostInstallPorts } from './ports'
import { requiredHealthChecks } from './readiness'

export interface DeployResult {
  apiUrl: string | null
  deliveryUrl: string | null
  modalUrl: string | null
}

export type DeployStepId =
  | 'ports'
  | 'cf-login'
  | 'buckets'
  | 'delivery-config'
  | 'modal'
  | 'delivery-worker'
  | 'delivery-secret'
  | 'delivery-analytics'
  | 'build'
  | 'local-drain'
  | 'migrate'
  | 'api'
  | 'readiness'
  | 'local-worker'
  | 'local-worker-stop'
  | 'modal-callbacks'
  | 'report'

export type DeployStepStatus = 'ok' | 'skipped' | 'failed' | 'blocked'

export interface DeployStepResult {
  id: DeployStepId
  label: string
  status: DeployStepStatus
  detail?: string
  /** What to run to finish this step by hand. */
  resume?: string
}

export interface DeployReport {
  target: ConfigTarget
  configPath: string
  steps: DeployStepResult[]
  /** False when a requested step did not happen (failed or blocked). */
  complete: boolean
  result: DeployResult
}

/** Steps that did not happen. */
export function unfinishedSteps(report: DeployReport): DeployStepResult[] {
  return report.steps.filter((step) => step.status === 'failed' || step.status === 'blocked')
}

/** The report as printable lines — what happened, and what is left. */
export function deployReportLines(report: DeployReport): string[] {
  const icon: Record<DeployStepStatus, string> = {
    ok: '✓',
    skipped: '○',
    failed: '✗',
    blocked: '✗',
  }
  const lines = report.steps.map((step) => {
    const detail = step.detail !== undefined && step.detail !== '' ? ` — ${step.detail}` : ''
    return `${icon[step.status]} ${step.label}${detail}`
  })
  const unfinished = unfinishedSteps(report)
  if (unfinished.length > 0) {
    lines.push('', 'Not finished:')
    for (const step of unfinished) {
      lines.push(`  · ${step.label}${step.detail !== undefined ? ` (${step.detail})` : ''}`)
      if (step.resume !== undefined) lines.push(`      ${step.resume}`)
    }
  }
  return lines
}

/** One line summarising how much of the requested deployment happened. */
export function deploySummaryLine(report: DeployReport): string {
  const unfinished = unfinishedSteps(report)
  if (unfinished.length === 0) {
    return 'Deployment complete.'
  }
  return (
    `Deployment incomplete — ${unfinished.length} step${unfinished.length === 1 ? '' : 's'} did not finish. ` +
    'The list below says what is left and how to finish it.'
  )
}

/**
 * What turning analytics off means, said once, when it is chosen.
 *
 * Media delivery is unaffected. Existing Analytics Engine datasets are not
 * deleted. Re-enable by writing matching ANALYTICS_ENABLED=true values and the
 * shared ingest secret, then re-running `--deploy`.
 */
export function analyticsDisabledAdvisory(): string {
  return (
    'Analytics are disabled: playback and bandwidth events will not be collected, ' +
    'and the dashboard will show a disabled state rather than usage. Media delivery ' +
    'is unaffected. Re-enable with ANALYTICS_ENABLED=true and a shared ANALYTICS_INGEST_SECRET.'
  )
}

const RESUME: Record<DeployStepId, string | undefined> = {
  ports: 'stop the other listener, then re-run the installer',
  'cf-login': 'cd delivery && pnpm exec wrangler login --device --browser=false',
  buckets: './scripts/bootstrap.sh --deploy   (re-run; bucket creation is idempotent)',
  'delivery-config': './scripts/bootstrap.sh --deploy   (re-run)',
  modal: 'cd transcoding && .venv/bin/modal setup && .venv/bin/modal deploy main.py',
  'delivery-worker': 'cd delivery && pnpm exec wrangler deploy',
  'delivery-secret': 'cd delivery && pnpm exec wrangler secret put JWT_SECRET',
  'delivery-analytics':
    'cd delivery && pnpm exec wrangler secret put ANALYTICS_INGEST_SECRET && curl $DELIVERY_URL/health/config',
  build: 'docker compose build api web && docker compose run --rm migrate',
  'local-drain': 'cancel or drain local jobs in Encoding, then re-run the installer',
  migrate: 'pnpm db:migrate   (dev target) or docker compose run --rm migrate   (deploy target)',
  api: 'pnpm docker:up   (deploy target) or pnpm dev   (dev target)',
  readiness: 'curl the configured origin /health/config until ready: true',
  'local-worker': './scripts/install.sh   (resume worker startup after the API is ready)',
  'local-worker-stop': 'let local jobs finish or cancel them in Encoding, then re-run `./scripts/bootstrap.sh --deploy` so it verifies the queue before stopping the worker',
  'modal-callbacks': './scripts/bootstrap.sh --deploy   (re-run once the API URL is known)',
  report: undefined,
}

export function withTranscoderProfile(profiles: string): string {
  const parts = profiles
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (!parts.includes('transcoder')) parts.push('transcoder')
  return parts.join(',')
}

function accessNote(access: 'localhost' | 'domain'): string {
  if (access === 'localhost') {
    return (
      'This installation is bound to loopback. It is reachable at http://localhost. ' +
      'The installer does not open firewall ports or create a tunnel.'
    )
  }
  return (
    'Point the hostname at this machine and allow inbound TCP 80 and 443. ' +
    'Caddy needs those ports reachable from the internet to issue a certificate. ' +
    'The installer does not modify firewalls or create a tunnel.'
  )
}

interface StepSpec {
  id: DeployStepId
  label: string
  dependsOn: readonly DeployStepId[]
}

/** Run the whole phase. `port` is injected so tests can drive a fake. */
export async function runDeployPhase(
  root: string,
  answers: WizardAnswers,
  port?: DeployPort,
): Promise<DeployReport> {
  const target: ConfigTarget = answers.target ?? 'dev'
  const configPath = primaryConfigPath(root, target)
  const io = port ?? createDeployPort({ root, target, deviceLogin: answers.hostInstall === true })
  const provider = transcodeProvider(answers)
  const wantsModal = provider === 'modal'
  const wantsUploads = uploadsEnabled(answers)
  const wantsAnalytics = analyticsEnabled(answers)
  const hostInstall = answers.hostInstall === true
  const publicOrigin = hostInstall ? answers.frontendUrl.trim().replace(/\/+$/, '') : null
  const proxyProfiles = (answers.proxy?.profiles ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')

  const steps: DeployStepResult[] = []
  const failed = new Set<DeployStepId>()
  /** Blocked is not failed — but it propagates exactly the same way. */
  const blocked = new Set<DeployStepId>()
  const result: DeployResult = { apiUrl: null, deliveryUrl: null, modalUrl: null }
  let modalBin: string | null = null
  let uploadedCallbackHosts: string | null = null
  let apiConfigured = false
  let switchingFromLocal = false

  const record = (step: DeployStepResult): boolean => {
    steps.push(step)
    if (step.status === 'failed') failed.add(step.id)
    if (step.status === 'blocked') blocked.add(step.id)
    return step.status === 'ok' || step.status === 'skipped'
  }

  const labelOf = (id: DeployStepId): string =>
    steps.find((step) => step.id === id)?.label ?? id

  /** Run one step, or record why it did not run. */
  const step = async (
    spec: StepSpec,
    work: () => Promise<string | void> | string | void,
  ): Promise<boolean> => {
    // Transitive on purpose: a step whose dependency was itself blocked must not
    // be attempted. Without this, a failed Cloudflare login blocked the bucket
    // step and then the delivery worker deployed anyway, against whatever
    // account wrangler happened to still be pointed at.
    const blocker = spec.dependsOn.find((id) => failed.has(id) || blocked.has(id))
    if (blocker !== undefined) {
      return record({
        id: spec.id,
        label: spec.label,
        status: 'blocked',
        detail: `${labelOf(blocker)} did not complete`,
        ...(RESUME[spec.id] !== undefined ? { resume: RESUME[spec.id] } : {}),
      })
    }
    io.log.step(spec.label)
    try {
      const detail = await work()
      return record({
        id: spec.id,
        label: spec.label,
        status: 'ok',
        ...(typeof detail === 'string' ? { detail } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      io.log.warn(`${spec.label}: ${message}`)
      return record({
        id: spec.id,
        label: spec.label,
        status: 'failed',
        detail: message,
        ...(RESUME[spec.id] !== undefined ? { resume: RESUME[spec.id] } : {}),
      })
    }
  }

  const skip = (spec: StepSpec, detail: string): void => {
    record({ id: spec.id, label: spec.label, status: 'skipped', detail })
  }

  try {
    const initial = io.readConfig()
    if (!initial) {
      throw new WizardError(
        `${configPath} is missing — configure it first (./scripts/bootstrap.sh --target ${target})`,
      )
    }
    io.log.info('Deploy phase — idempotent: if anything interrupts you, re-run to resume.')

    if (hostInstall) {
      await step({ id: 'ports', label: 'Check required host ports', dependsOn: [] }, async () => {
        const access = answers.access === 'domain' ? 'domain' : 'localhost'
        const bind = answers.proxy?.bindAddress ?? (access === 'domain' ? '0.0.0.0' : '127.0.0.1')
        await io.checkHostPorts(hostInstallPorts(bind, access))
        return access === 'domain'
          ? 'ports 80 and 443 are available (or already this installation)'
          : 'port 80 is available (or already this installation)'
      })
      io.log.info(
        accessNote(answers.access === 'domain' ? 'domain' : 'localhost'),
      )
    } else {
      skip({ id: 'ports', label: 'Check required host ports', dependsOn: [] }, 'not a host install')
    }

    // ── 1. Cloudflare auth + account ─────────────────────────────────────
    await step({ id: 'cf-login', label: 'Cloudflare login & account', dependsOn: [] }, async () => {
      const loggedIn = await io.ensureCfLogin()
      if (!loggedIn) {
        throw new Error(
          hostInstall
            ? 'wrangler login did not complete — approve the device code and re-run'
            : 'wrangler login did not complete — approve it in the browser and re-run',
        )
      }
      const accounts = await io.cfAccounts()
      const wanted = answers.accountId.trim().toLowerCase()
      let effective = loggedIn
      if (hostInstall) {
        if (wanted) {
          if (accounts.length > 0 && !accounts.includes(wanted) && wanted !== loggedIn) {
            throw new Error(
              `ACCOUNT_ID ${wanted} does not match the logged-in Cloudflare account ` +
                `(${accounts.join(', ') || loggedIn})`,
            )
          }
          effective = wanted
        } else if (accounts.length > 1) {
          throw new Error(
            `wrangler whoami reports multiple accounts (${accounts.join(', ')}) — ` +
              'set ACCOUNT_ID to the one this installation should use',
          )
        } else {
          effective = accounts[0] ?? loggedIn
        }
      } else {
        effective = wanted || loggedIn
        if (wanted && wanted !== loggedIn) {
          io.log.warn(
            `env ACCOUNT_ID (${wanted}) differs from the logged-in account (${loggedIn}) — provisioning uses ${loggedIn}`,
          )
          effective = loggedIn
        }
      }
      io.useCfAccount(effective)
      const existingSweep = (io.readConfig()?.['SWEEP_ENABLED'] ?? '').trim()
      const updates: Array<readonly [string, string]> = [['ACCOUNT_ID', effective]]
      if (existingSweep === '') updates.push(['SWEEP_ENABLED', 'true'])
      io.writeConfig(updates)

      const current = io.readConfig() ?? {}
      if (wantsAnalytics && !current['CLOUDFLARE_ANALYTICS_TOKEN']?.trim()) {
        const token = await io.offerAnalyticsToken()
        if (token !== null) {
          io.writeConfig([['CLOUDFLARE_ANALYTICS_TOKEN', token]])
          io.log.success('Cloudflare analytics token saved')
        }
      }
      return `account ${effective}`
    })

    // ── 2. Buckets + CORS ────────────────────────────────────────────────
    //
    // The raw bucket exists to serve *uploads*, not transcoding, so it is only
    // provisioned when uploads are on. Creating one anyway is not harmless: it
    // puts an unused bucket on the owner's account.
    await step(
      {
        id: 'buckets',
        label: wantsUploads
          ? `R2 buckets (${answers.rawBucket}, ${answers.transcodedBucket}) + CORS`
          : `R2 bucket (${answers.transcodedBucket})`,
        dependsOn: ['cf-login'],
      },
      async () => {
        if (wantsUploads) {
          await io.ensureBucket(answers.rawBucket)
          io.log.success(`R2 bucket ${answers.rawBucket} ready`)
        }
        await io.ensureBucket(answers.transcodedBucket)
        io.log.success(`R2 bucket ${answers.transcodedBucket} ready`)
        if (wantsUploads) {
          await io.applyBucketCors(answers.rawBucket, bucketCorsOrigins(answers.frontendUrl))
          return 'raw + transcoded, browser-upload CORS applied'
        }
        return 'transcoded only — uploads are off, so no raw bucket and no CORS policy'
      },
    )

    // ── 3. Delivery worker config ────────────────────────────────────────
    await step(
      {
        id: 'delivery-config',
        label: 'Point delivery/wrangler.jsonc at the transcoded bucket',
        dependsOn: ['cf-login'],
      },
      () => {
        const patched = io.patchDeliveryBucket(answers.transcodedBucket)
        const analyticsPatched = io.patchDeliveryAnalytics(wantsAnalytics)
        const bucket = patched ? 'bucket updated' : 'bucket already correct'
        const datasets = wantsAnalytics
          ? analyticsPatched
            ? 'analytics bindings enabled'
            : 'analytics bindings already present'
          : analyticsPatched
            ? 'analytics bindings removed'
            : 'analytics bindings already absent'
        return `${bucket}, ${datasets}`
      },
    )

    // ── 4. Modal (only when it is the provider) ──────────────────────────
    if (wantsModal) {
      await step(
        { id: 'modal', label: 'Modal environment, secrets & deploy', dependsOn: ['cf-login'] },
        async () => {
          modalBin = await io.prepareModal()
          if (modalBin === null) {
            throw new Error('Modal is not usable (not installed, not authenticated, or skipped)')
          }
          await io.cleanLegacySecrets(modalBin)

          const config = io.readConfig()
          if (!config) throw new Error(`${configPath} disappeared during the Modal step`)
          // Built from the config file, never from the in-memory answers: a
          // bucket or callback host edited by hand has to reach the transcoder,
          // and a stale answer silently pointing at the wrong bucket is the kind
          // of bug that only shows up as a failed encode.
          const creds = clipmuxCredsFromEnv(config)
          if (creds.problems.length > 0) {
            throw new Error(
              `the ${MODAL_CREDS_SECRET} Modal secret is built from ${configPath}, and that ` +
                `file is incomplete:\n  - ` +
                creds.problems.join('\n  - '),
            )
          }
          for (const advisory of creds.advisories) io.log.warn(advisory)

          const uploaded = await io.uploadModalSecrets(modalBin, creds, answers.groqApiKey)
          uploadedCallbackHosts = uploaded.callbackHosts

          const modalUrl = await io.deployModal(modalBin)
          if (modalUrl === null) {
            throw new Error(
              'modal deploy finished but no *.modal.run URL was parsed — set MODAL_WEBHOOK_URL by hand',
            )
          }
          result.modalUrl = modalUrl
          io.writeConfig([['MODAL_WEBHOOK_URL', modalUrl]])
          return modalUrl
        },
      )
    } else {
      skip(
        { id: 'modal', label: 'Modal environment, secrets & deploy', dependsOn: [] },
        'local provider — no Modal service is needed',
      )
    }

    // ── 5. Delivery worker (always Cloudflare) ───────────────────────────
    //
    // In every configuration, including a local-only one: it is how a player
    // gets signed bytes, and skipping it produces an installation that
    // transcodes perfectly and cannot play anything.
    await step(
      { id: 'delivery-worker', label: 'Deploy the delivery worker', dependsOn: ['delivery-config'] },
      async () => {
        const url = await io.deployWorker('delivery')
        if (url === null) {
          throw new Error('no workers.dev URL was parsed — set DELIVERY_URL by hand')
        }
        result.deliveryUrl = url
        io.writeConfig([['DELIVERY_URL', url]])
        return url
      },
    )

    await step(
      {
        id: 'delivery-secret',
        label: 'Upload the delivery worker secrets',
        dependsOn: ['delivery-worker'],
      },
      async () => {
        const config = io.readConfig()
        const jwt = config?.['JWT_SECRET'] ?? ''
        // Length and blankness are checked *here*, not only in lintServerEnv:
        // `putWorkerSecrets` drops empty values and returns without an error, so
        // without this guard the step would report "JWT_SECRET uploaded" for a
        // worker that received no signing key — a deploy report asserting the
        // exact opposite of the truth, and every signed video 401s.
        if (jwt.trim().length < MIN_SECRET_LENGTH) {
          throw new Error(
            `JWT_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters — ` +
              'the delivery worker cannot verify playback tokens without it',
          )
        }
        const entries: Array<readonly [string, string]> = [
          ['JWT_SECRET', jwt],
          ['ANALYTICS_ENABLED', wantsAnalytics ? 'true' : 'false'],
        ]
        if (wantsAnalytics) {
          const ingest = config?.['ANALYTICS_INGEST_SECRET'] ?? ''
          if (ingest.trim().length < MIN_SECRET_LENGTH) {
            throw new Error(
              `ANALYTICS_INGEST_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters — ` +
                'the delivery worker cannot accept playback telemetry without it',
            )
          }
          entries.push(['ANALYTICS_INGEST_SECRET', ingest])
        }
        await io.putWorkerSecrets('delivery', entries)
        return wantsAnalytics
          ? 'JWT_SECRET and ANALYTICS_INGEST_SECRET uploaded'
          : 'JWT_SECRET uploaded (analytics disabled)'
      },
    )

    if (wantsAnalytics) {
      await step(
        {
          id: 'delivery-analytics',
          label: 'Verify delivery analytics capability',
          dependsOn: ['delivery-secret'],
        },
        async () => {
          const url = result.deliveryUrl ?? io.readConfig()?.['DELIVERY_URL'] ?? null
          const ingest = io.readConfig()?.['ANALYTICS_INGEST_SECRET'] ?? ''
          await io.probeDeliveryHealth(url, ingest)
          return 'delivery analytics bindings and ingest secret verified'
        },
      )
    } else {
      skip(
        { id: 'delivery-analytics', label: 'Verify delivery analytics capability', dependsOn: [] },
        'analytics disabled — ingest secret and dataset writes are skipped',
      )
      io.log.warn(analyticsDisabledAdvisory())
    }

    // ── 6. Build, then migrate, then start ───────────────────────────────
    //
    // The migrate service uses the API image. Building only during `compose up`
    // is too late: migrate would run an older (or missing) image.
    if (target === 'deploy') {
      if (wantsModal) {
        await step(
          {
            id: 'local-drain',
            label: 'Pause local admission and drain transcodes before switching to Modal',
            dependsOn: [],
          },
          async () => {
            const config = io.readConfig() ?? {}
            const origin = config['BACKEND_URL']?.trim() || config['BETTER_AUTH_URL']?.trim()
            if (!origin) return 'no existing API origin is configured'
            switchingFromLocal = await io.pauseLocalAdmission(origin)
            if (!switchingFromLocal) return 'no running local-provider API was detected'
            const drained = await io.assertLocalJobsDrained(origin)
            if (!drained) throw new Error('the local queue is not drained')
            return 'local admission is paused and the existing queue is drained'
          },
        )
      } else {
        skip(
          { id: 'local-drain', label: 'Pause local admission and drain transcodes before switching to Modal', dependsOn: [] },
          'local provider selected',
        )
      }
      await step(
        {
          id: 'build',
          label: 'Build application images',
          dependsOn: [
            ...(hostInstall ? ['ports' as const] : []),
            ...(wantsModal ? ['local-drain' as const] : []),
          ],
        },
        async () => {
          if (!io.hasDocker()) {
            throw new Error('docker was not found — the deploy target runs the Compose stack')
          }
          await io.composeBuild({ services: ['api', 'web'] })
          if (!wantsModal) {
            await io.composeBuild({ services: ['transcoder'], profiles: ['transcoder'] })
            return 'api, web and local transcoder images built'
          }
          return 'api and web images built'
        },
      )
      await step(
        {
          id: 'migrate',
          label: 'Apply migrations (docker compose run --rm migrate)',
          dependsOn: ['build'],
        },
        async () => {
          await io.composeMigrate()
          return 'migrations applied to the Compose database'
        },
      )
    } else {
      skip({ id: 'build', label: 'Build application images', dependsOn: [] }, 'dev target')
      skip(
        { id: 'migrate', label: 'Apply migrations', dependsOn: [] },
        'dev target — run `pnpm db:migrate` yourself',
      )
    }

    // ── 7. API ───────────────────────────────────────────────────────────
    if (target === 'deploy') {
      await step({ id: 'api', label: 'Bring up the Compose stack', dependsOn: ['migrate'] }, async () => {
        const configuredProfiles = (io.readConfig()?.['COMPOSE_PROFILES'] ?? proxyProfiles.join(','))
          .split(',').map((profile) => profile.trim()).filter(Boolean)
        const profiles = [...new Set([
          ...configuredProfiles.filter((profile) => wantsModal ? profile !== 'transcoder' : true),
          ...(!wantsModal ? ['transcoder'] : []),
        ])]
        io.writeConfig([['COMPOSE_PROFILES', profiles.join(',')]])
        await io.composeUp(profiles.length > 0 ? profiles : undefined)
        result.apiUrl = publicOrigin ?? 'http://localhost:8787'
        apiConfigured = true
        if (publicOrigin) return `origin ${publicOrigin}`
        return 'API http://localhost:8787 · dashboard http://localhost:3000'
      })
    } else {
      skip(
        { id: 'api', label: 'Deploy the API', dependsOn: [] },
        'dev target — the API runs here via `pnpm dev`',
      )
      apiConfigured = true
    }

    if (target === 'deploy' && wantsModal && switchingFromLocal) {
      await step(
        {
          id: 'local-worker-stop',
          label: 'Stop the local transcoder after the provider switch',
          dependsOn: ['api', 'local-drain'],
        },
        async () => {
          const config = io.readConfig() ?? {}
          const origin = config['BACKEND_URL']?.trim() || config['BETTER_AUTH_URL']?.trim()
          if (!origin) throw new Error('the API origin is missing, so the local queue cannot be rechecked')
          const drained = await io.assertLocalJobsDrained(origin)
          if (!drained) throw new Error('local jobs became outstanding after the provider switch')
          await io.stopLocalWorker()
          return 'local queue is still drained; worker stopped and unrelated Compose profiles remain enabled'
        },
      )
    } else {
      skip(
        { id: 'local-worker-stop', label: 'Stop the local transcoder after the provider switch', dependsOn: [] },
        wantsModal ? 'no prior local-provider API was detected' : 'local provider selected',
      )
    }

    if (hostInstall && publicOrigin) {
      await step(
        { id: 'readiness', label: 'Wait for dashboard and API readiness', dependsOn: ['api'] },
        async () => {
          await io.waitForOrigin(publicOrigin, requiredHealthChecks(answers))
          return `${publicOrigin} is serving the dashboard and reports ready: true`
        },
      )
    } else {
      skip(
        { id: 'readiness', label: 'Wait for dashboard and API readiness', dependsOn: [] },
        'not a host install — readiness is advisory via the health probe',
      )
    }

    if (target === 'deploy' && !wantsModal) {
      await step(
        { id: 'local-worker', label: 'Wait for the local transcoder', dependsOn: ['api', ...(hostInstall ? ['readiness' as const] : [])] },
        async () => {
          const config = io.readConfig()
          const origin = publicOrigin ?? config?.['BETTER_AUTH_URL'] ?? 'http://localhost:8787'
          await io.waitForLocalWorker(origin)
          return 'local transcoder is online and reporting capabilities'
        },
      )
    } else {
      skip(
        { id: 'local-worker', label: 'Wait for the local transcoder', dependsOn: [] },
        wantsModal ? 'Modal provider — no local transcoder image is built or started' : 'dev target — start the worker explicitly when needed',
      )
    }

    // ── 8. Refresh the Modal callback allowlist ──────────────────────────
    //
    // The API builds `callbackUrl` from BACKEND_URL, so that is the host the
    // transcoder must be allowed to call. Doing it only once the API host is
    // known is the point: an early allowlist would contain localhost and
    // silently refuse every callback.
    if (wantsModal && modalBin !== null && apiConfigured) {
      await step(
        { id: 'modal-callbacks', label: 'Refresh Modal callback hosts', dependsOn: ['modal', 'api'] },
        async () => {
          const config = io.readConfig()
          if (!config) throw new Error(`${configPath} disappeared mid-deploy`)
          const creds = clipmuxCredsFromEnv(config)
          const bin = modalBin as string
          const updated = await io.refreshModalCallbacks(bin, creds, uploadedCallbackHosts)
          if (updated === uploadedCallbackHosts) return 'already correct'
          uploadedCallbackHosts = updated
          return updated ?? 'unchanged'
        },
      )
    } else {
      skip(
        { id: 'modal-callbacks', label: 'Refresh Modal callback hosts', dependsOn: [] },
        wantsModal ? 'the Modal step was skipped' : 'local provider',
      )
    }

    // ── 9. Report ────────────────────────────────────────────────────────
    await step(
      { id: 'report', label: 'Configuration check & health probe', dependsOn: [] },
      async () => {
        const { rows, failed: lintFailed } = io.lintConfig()
        io.log.info(
          rows
            .map((row) => `${row.ok ? '✓' : row.advisory ? '○' : '✗'} ${row.text}`)
            .join('\n'),
        )
        if (lintFailed) {
          io.log.warn(`Some keys are still missing — see the rows above and ${configPath}`)
        }
        const probeUrl = result.apiUrl ?? io.readConfig()?.['BETTER_AUTH_URL'] ?? null
        if (!hostInstall) await io.probeHealth(probeUrl)
        return lintFailed ? 'configuration incomplete' : 'configuration looks complete'
      },
    )

    const report: DeployReport = { target, configPath, steps, complete: true, result }
    report.complete = unfinishedSteps(report).length === 0
    return report
  } finally {
    io.cleanup()
  }
}
