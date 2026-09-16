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

import type { EntryList } from './mapping'
import { SERVER_KEY_ORDER, transcodeProvider, uploadsEnabled } from './mapping'
import type { ConfigTarget, WizardAnswers } from './types'
import { WizardError } from './errors'
import { pairingCommand } from './pairing'
import { primaryConfigPath } from './envio'
import { clipmuxCredsFromEnv, MODAL_CREDS_SECRET } from './modal'
import { bucketCorsOrigins, createDeployPort, type DeployPort } from './deployPort'
import { MIN_SECRET_LENGTH } from './verify'

export interface DeployResult {
  apiUrl: string | null
  deliveryUrl: string | null
  modalUrl: string | null
}

export type DeployStepId =
  | 'cf-login'
  | 'buckets'
  | 'delivery-config'
  | 'modal'
  | 'delivery-worker'
  | 'delivery-secret'
  | 'migrate'
  | 'api'
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
 * What a wizard-selected shape cannot do, said once, at the moment it is chosen.
 *
 * Playback telemetry is written through the Analytics Engine *binding*, which
 * exists on Cloudflare Workers only. A Node API (a Compose container, or
 * `pnpm dev` locally) therefore reads analytics and records none, and the
 * dashboard shows honest zeros for every view metric. Nothing about the install
 * is broken — but nothing in the deploy output used to say so, which is how this
 * arrived as a bug report.
 *
 * Deliberately an advisory and not a step: it is a capability of the chosen
 * shape, not a step that failed. Bandwidth analytics keep working either way,
 * because the delivery worker is always deployed and meters its own egress.
 */
export function playbackAnalyticsAdvisory(shape: 'compose' | 'local'): string {
  const recovery =
    shape === 'compose'
      ? 'Deploy the API as a Worker instead (`cd server && pnpm exec wrangler deploy`) if you need playback telemetry.'
      : '`pnpm dev:workers` runs the API on Workers — it needs a reachable cloud database (Neon + DB_DRIVER=neon-http), not the local dev Postgres.'
  return (
    'Playback analytics will not be recorded: writing them needs the Analytics Engine ' +
    `PLAYBACK_ANALYTICS binding, and this API runs on Node. ${recovery}`
  )
}

const RESUME: Record<DeployStepId, string | undefined> = {
  'cf-login': 'pnpm --filter vod-api exec wrangler login',
  buckets: './scripts/bootstrap.sh --deploy   (re-run; bucket creation is idempotent)',
  'delivery-config': './scripts/bootstrap.sh --deploy   (re-run)',
  modal: 'cd transcoding && .venv/bin/modal setup && .venv/bin/modal deploy main.py',
  'delivery-worker': 'cd delivery && pnpm exec wrangler deploy',
  'delivery-secret': 'cd delivery && pnpm exec wrangler secret put JWT_SECRET',
  migrate: 'pnpm db:migrate   (dev target) or pnpm docker:migrate   (deploy target)',
  api: 'pnpm docker:up   (deploy target) or: cd server && pnpm exec wrangler deploy',
  'modal-callbacks': './scripts/bootstrap.sh --deploy   (re-run once the API URL is known)',
  report: undefined,
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
  const io = port ?? createDeployPort({ root, target })
  const provider = transcodeProvider(answers)
  const wantsModal = provider === 'modal'
  const wantsUploads = uploadsEnabled(answers)

  const steps: DeployStepResult[] = []
  const failed = new Set<DeployStepId>()
  /** Blocked is not failed — but it propagates exactly the same way. */
  const blocked = new Set<DeployStepId>()
  const result: DeployResult = { apiUrl: null, deliveryUrl: null, modalUrl: null }
  let modalBin: string | null = null
  let uploadedCallbackHosts: string | null = null
  let apiConfigured = false

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

    // ── 1. Cloudflare auth + account ─────────────────────────────────────
    await step({ id: 'cf-login', label: 'Cloudflare login & account', dependsOn: [] }, async () => {
      const loggedIn = await io.ensureCfLogin()
      if (!loggedIn) {
        throw new Error('wrangler login did not complete — approve it in the browser and re-run')
      }
      const effective = answers.accountId.trim() || loggedIn
      if (effective !== loggedIn) {
        io.log.warn(
          `env ACCOUNT_ID (${effective}) differs from the logged-in account (${loggedIn}) — provisioning uses ${loggedIn}`,
        )
      }
      io.writeConfig([
        ['ACCOUNT_ID', effective],
        ['SWEEP_ENABLED', 'true'],
      ])

      const current = io.readConfig() ?? {}
      if (!current['CLOUDFLARE_ANALYTICS_TOKEN']?.trim()) {
        const token = await io.offerAnalyticsToken()
        if (token !== null) {
          io.writeConfig([['CLOUDFLARE_ANALYTICS_TOKEN', token]])
          io.log.success('Cloudflare analytics token saved')
        }
      }
      return `account ${loggedIn}`
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
        return patched ? 'updated' : 'already correct'
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
        'self-hosted provider — nothing to deploy to Modal',
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
        label: 'Upload the delivery JWT secret',
        dependsOn: ['delivery-worker'],
      },
      async () => {
        const jwt = io.readConfig()?.['JWT_SECRET'] ?? ''
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
        await io.putWorkerSecrets('delivery', [['JWT_SECRET', jwt]])
        return 'JWT_SECRET uploaded'
      },
    )

    // ── 6. Migrations ────────────────────────────────────────────────────
    //
    // Exactly one migration path per run, decided by the target: a `deploy` run
    // migrates the Compose database, a Workers run migrates the database in its
    // own config file, and a dev/Node run leaves migrations to `pnpm db:migrate`.
    if (target === 'deploy') {
      await step(
        {
          id: 'migrate',
          label: 'Apply migrations (docker compose run --rm migrate)',
          dependsOn: [],
        },
        async () => {
          if (!io.hasDocker()) {
            throw new Error('docker was not found — the deploy target runs the Compose stack')
          }
          await io.composeMigrate()
          return 'migrations applied to the Compose database'
        },
      )
    } else if (answers.runtime === 'workers') {
      await step({ id: 'migrate', label: 'Apply migrations to DATABASE_URL', dependsOn: [] }, async () => {
        const databaseUrl = io.readConfig()?.['DATABASE_URL'] ?? ''
        if (!databaseUrl) throw new Error(`DATABASE_URL is missing from ${configPath}`)
        await io.dbMigrate(databaseUrl)
        return 'migrations applied'
      })
    } else {
      skip(
        { id: 'migrate', label: 'Apply migrations', dependsOn: [] },
        'dev target with the Node runtime — run `pnpm db:migrate` yourself',
      )
    }

    // ── 7. API ───────────────────────────────────────────────────────────
    if (target === 'deploy') {
      await step({ id: 'api', label: 'Bring up the Compose stack', dependsOn: ['migrate'] }, async () => {
        await io.composeUp()
        result.apiUrl = 'http://localhost:8787'
        apiConfigured = true
        return 'API http://localhost:8787 · dashboard http://localhost:3000'
      })
      io.log.warn(playbackAnalyticsAdvisory('compose'))
    } else if (answers.runtime === 'workers') {
      await step(
        {
          id: 'api',
          label: 'Deploy the API worker + secrets',
          // A Workers deploy needs wrangler auth as well as a migrated database.
          dependsOn: ['migrate', 'cf-login'],
        },
        async () => {
          const apiUrl = await io.deployWorker('server')
          if (apiUrl !== null) {
            io.writeConfig([
              ['BETTER_AUTH_URL', apiUrl],
              ['BACKEND_URL', apiUrl],
            ])
            result.apiUrl = apiUrl
          } else {
            io.log.warn('API deploy finished but no workers.dev URL was parsed')
          }
          const updated = io.readConfig()
          if (!updated) throw new Error(`${configPath} disappeared mid-deploy`)
          const entries: EntryList = ([...SERVER_KEY_ORDER, 'SWEEP_ENABLED'] as readonly string[]).map(
            (key) => [key, updated[key] ?? ''] as const,
          )
          await io.putWorkerSecrets('server', entries)
          apiConfigured = true
          return apiUrl ?? 'deployed (URL not parsed)'
        },
      )
    } else {
      skip(
        { id: 'api', label: 'Deploy the API', dependsOn: [] },
        'dev target with the Node runtime — the API runs here via `pnpm dev`',
      )
      io.log.warn(playbackAnalyticsAdvisory('local'))
      apiConfigured = true
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
        wantsModal ? 'the Modal step was skipped' : 'self-hosted provider',
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
        await io.probeHealth(probeUrl)
        if (provider === 'self-hosted') {
          io.log.info(`Pair a machine to start encoding:\n  ${pairingCommand(result.apiUrl ?? undefined)}`)
        }
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
