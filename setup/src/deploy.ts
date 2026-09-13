/**
 * Opt-in provision & deploy phase. Order matters: Modal deploys first so the
 * API secrets include MODAL_WEBHOOK_URL; the delivery worker must always be
 * deployed (playback is Cloudflare-only); compose boots Postgres+API+web
 * locally. Every step preflights and tolerates re-runs (resume-safe).
 *
 * This module performs network/auth actions only when invoked explicitly
 * (--deploy or the interactive "deploy now" choice) — never during the plain
 * configure flow.
 */

import type { WizardAnswers } from './types'
import { SERVER_KEY_ORDER } from './mapping'
import { WizardError } from './errors'
import {
  applyBucketCors,
  cfAccountId,
  dbMigrate,
  deployWorker,
  ensureBucket,
  ensureCfLogin,
  makeTempDir,
  patchDeliveryBucket,
  putWorkerSecrets,
  type TempDir,
} from './cloudflare'
import {
  deployModalPipeline,
  findModalBin,
  installModalCli,
  modalAuthed,
  putModalSecret,
  r2CredsValues,
  runModalSetup,
} from './modal'
import { analyticsTokenTemplateUrl } from './parsers'
import { findOnPath, runInherit } from './runners'
import { readServerEnv, upsertDeployEnv, upsertServerEnv } from './envio'
import type { EntryList } from './mapping'
import { askConfirm, askPassword, logInfo, logStep, logSuccess, logWarn, printCheckRows, withSpinner } from './ui'
import { lintServerEnv } from './verify'

export interface DeployResult {
  apiUrl: string | null
  deliveryUrl: string | null
  modalUrl: string | null
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  const match = /^https?:\/\/([^/:?#]+)/.exec(url)
  return match ? match[1] : null
}

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
      logWarn(`API reports ready: false${body.problems?.length ? ` — ${body.problems.join('; ')}` : ''}`)
    }
  } catch {
    logWarn(`could not reach ${url} (is the API up?) — re-check with: curl ${url}`)
  }
}

/**
 * Run the full provision & deploy phase. Reads .dev.vars at the start for the
 * shared secrets (JWT, ingest secret) and upserts URLs as deploys succeed, so
 * the files always reflect reality.
 */
/**
 * Write deploy-phase values into every config file this runtime reads.
 *
 * `server/.dev.vars` is always updated (it is the local record of what was
 * deployed). A Compose deployment reads the root `.env` instead, so a Node
 * deployment mirrors into it as well — see `upsertDeployEnv`.
 */
function makeEnvWriter(
  root: string,
  runtime: WizardAnswers['runtime'],
): (updates: EntryList) => void {
  return (updates) => {
    upsertServerEnv(root, updates)
    if (runtime === 'node') {
      upsertDeployEnv(root, updates)
    }
  }
}

export async function runDeployPhase(
  root: string,
  answers: WizardAnswers,
): Promise<DeployResult> {
  const serverEnv = readServerEnv(root)
  const writeEnv = makeEnvWriter(root, answers.runtime)
  if (!serverEnv) {
    throw new WizardError(
      'server/.dev.vars is missing — configure the environment first (./scripts/bootstrap.sh)',
    )
  }

  const result: DeployResult = { apiUrl: null, deliveryUrl: null, modalUrl: null }
  const temp: TempDir = makeTempDir()
  try {
    logInfo('Deploy phase — idempotent: if anything interrupts you, re-run to resume.')

    // ── 1. Cloudflare auth + account ─────────────────────────────────────
    logStep('Cloudflare — checking wrangler login')
    const loggedAccountId = await ensureCfLogin(root)
    if (!loggedAccountId) {
      throw new WizardError(
        'wrangler login did not complete. Run ./scripts/bootstrap.sh --deploy again after logging in (pnpm exec wrangler login from server/).',
      )
    }
    const effectiveAccountId = answers.accountId.trim() || loggedAccountId
    if (effectiveAccountId !== loggedAccountId) {
      logWarn(
        `env ACCOUNT_ID (${effectiveAccountId}) differs from the logged-in account (${loggedAccountId}) — provisioning uses ${loggedAccountId}`,
      )
    }
    if (effectiveAccountId !== serverEnv['ACCOUNT_ID']) {
      writeEnv([['ACCOUNT_ID', effectiveAccountId]])
      logInfo('ACCOUNT_ID in server/.dev.vars updated to the logged-in account')
    }
    writeEnv([['SWEEP_ENABLED', 'true']])

    const currentEnv = readServerEnv(root)
    if (!currentEnv) throw new WizardError('server/.dev.vars disappeared during deploy setup')
    if (!currentEnv['CLOUDFLARE_ANALYTICS_TOKEN']?.trim()) {
      const addAnalytics = await askConfirm(
        'Set up optional Cloudflare usage analytics now?',
        false,
      )
      if (addAnalytics) {
        logInfo(
          `Open this Cloudflare token template, create the token, then paste it here:\n${analyticsTokenTemplateUrl()}`,
        )
        const analyticsToken = await askPassword('Cloudflare Account Analytics Read token')
        if (!analyticsToken) {
          throw new WizardError(
            'Cloudflare analytics token was empty — re-run --deploy and paste the token when prompted',
          )
        }
        writeEnv([['CLOUDFLARE_ANALYTICS_TOKEN', analyticsToken]])
        logSuccess('Cloudflare analytics token saved')
      }
    }

    // ── 2. Buckets + CORS + delivery config ─────────────────────────────
    //
    // The raw bucket exists to serve *uploads*, not transcoding, so provisioning
    // it is conditional on uploads being enabled. A local-only installation —
    // self-hosted provider, uploads off — needs no raw bucket, no CORS policy
    // and no Modal account, and creating them anyway is not a harmless
    // no-op: it puts an unused public bucket on the owner's account.
    const wantsUploads = answers.uploadsEnabled !== false
    const wantsModal = (answers.transcodeProvider ?? 'modal') === 'modal'

    if (wantsUploads) {
      logStep(`Creating R2 buckets (${answers.rawBucket}, ${answers.transcodedBucket})`)
      await ensureBucket(root, answers.rawBucket)
      logSuccess(`R2 bucket ${answers.rawBucket} ready`)
      await ensureBucket(root, answers.transcodedBucket)
      logSuccess(`R2 bucket ${answers.transcodedBucket} ready`)

      logStep(`Applying S3 CORS to ${answers.rawBucket} for browser uploads`)
      await applyBucketCors(root, answers.rawBucket, [answers.frontendUrl], temp)
      logSuccess('CORS policy applied (GET/PUT/HEAD, ETag exposed)')
    } else {
      logStep('Browser uploads are disabled — provisioning only the transcoded bucket')
      await ensureBucket(root, answers.transcodedBucket)
      logSuccess(`R2 bucket ${answers.transcodedBucket} ready`)
      logInfo(
        'No raw bucket and no CORS policy were created. Files on your machines ' +
          'are read directly by the transcoder agent.',
      )
    }

    logStep('Pointing delivery/wrangler.jsonc at the transcoded bucket')
    const patched = patchDeliveryBucket(root, answers.transcodedBucket)
    logSuccess(patched ? 'delivery/wrangler.jsonc updated' : 'delivery/wrangler.jsonc already correct')

    // ── 3. Modal CLI + auth + secrets + deploy ──────────────────────────
    if (!wantsModal) {
      logStep('Provider is self-hosted — skipping Modal deployment entirely')
      logInfo(
        'Pair a machine to start encoding:\n' +
          '  docker compose --profile transcoder run --rm transcoder \\\n' +
          '    pair --api <your API URL> --code <CODE FROM THE DASHBOARD>',
      )
      await finishDeployWithoutModal(root, answers, temp)
      return result
    }

    let modalBin = await findModalBin()
    if (!modalBin) {
      const install = await askConfirm(
        'Modal CLI is not installed. Install it now (uv tool → pipx → python venv)?',
        true,
      )
      if (install) {
        modalBin = await withSpinner(
          'Installing the Modal CLI…',
          () => installModalCli(),
          'Modal CLI installed',
        )
      }
      else logWarn('Skipping Modal — deploy the pipeline yourself: see README "Deploy the transcoder"')
    }

    if (modalBin) {
      const status = await modalAuthed(modalBin)
      let authed = status.authed
      if (authed) {
        logSuccess(
          `Modal CLI authenticated${status.profile ? ` (profile ${status.profile})` : ''}`,
        )
      } else {
        const setup = await askConfirm(
          'Modal CLI is not authenticated. Run modal setup now (opens your browser)?',
          true,
        )
        if (setup) {
          const setupOk = await runModalSetup(modalBin)
          if (setupOk) {
            authed = true
            logSuccess('Modal CLI authenticated after setup')
          } else {
            const retry = await modalAuthed(modalBin)
            authed = retry.authed
            if (authed) {
              logSuccess(
                `Modal CLI authenticated${retry.profile ? ` (profile ${retry.profile})` : ''}`,
              )
            }
          }
        } else {
          logWarn('Skipping Modal auth — run `modal setup` yourself, then re-run --deploy')
        }
      }
      if (authed) {
        const ingestSecret = serverEnv['TRANSCODE_INGEST_SECRET'] ?? ''
        logStep('Uploading Modal secrets (r2-creds, groq-creds)')
        await putModalSecret(
          modalBin,
          'r2-creds',
          r2CredsValues({
            accountId: effectiveAccountId,
            accessKeyId: serverEnv['R2_ACCESS_KEY_ID'] ?? answers.r2AccessKeyId,
            secretAccessKey: serverEnv['R2_SECRET_ACCESS_KEY'] ?? answers.r2SecretAccessKey,
            transcodedBucket: answers.transcodedBucket,
            rawBucket: answers.rawBucket,
            ingestSecret,
            callbackHosts: 'localhost',
          }),
        )
        await putModalSecret(modalBin, 'groq-creds', {
          GROQ_API_KEY: answers.groqApiKey?.trim() || 'unused',
        })
        logSuccess('Modal secrets r2-creds + groq-creds ready')

        const modalUrl = await deployModalPipeline(root)
        if (modalUrl) {
          writeEnv([['MODAL_WEBHOOK_URL', modalUrl]])
          result.modalUrl = modalUrl
          logSuccess(`MODAL_WEBHOOK_URL=${modalUrl}`)
        } else {
          logWarn(
            'modal deploy finished but no *.modal.run URL was parsed — paste the URL into server/.dev.vars (MODAL_WEBHOOK_URL)',
          )
        }
      }
    }

    // ── 4. Delivery worker (always Cloudflare) ───────────────────────────
    const deliveryUrl = await deployWorker(root, 'delivery')
    if (deliveryUrl) {
      writeEnv([['DELIVERY_URL', deliveryUrl]])
      result.deliveryUrl = deliveryUrl
      logSuccess(`Delivery worker deployed: ${deliveryUrl}`)
    } else {
      logWarn('delivery deploy finished but no workers.dev URL was parsed — set DELIVERY_URL by hand')
    }
    const jwt = readServerEnv(root)?.['JWT_SECRET']
    if (jwt) {
      logStep('Uploading delivery JWT_SECRET')
      await putWorkerSecrets(root, 'delivery', [['JWT_SECRET', jwt]], temp)
      logSuccess('Delivery JWT_SECRET uploaded')
    }

    // ── 5. API runtime ───────────────────────────────────────────────────
    if (answers.runtime === 'node') {
      if (!findOnPath('docker')) {
        throw new WizardError(
          'docker was not found — the Node runtime deploys with Docker Compose. Install Docker and re-run with --deploy.',
        )
      }
      // The deployment stack is configured by the root `.env`, not by
      // server/.dev.vars — the two files answer different questions.
      logStep('docker compose run --rm migrate (apply migrations)')
      const migrate = await runInherit(['docker', 'compose', 'run', '--rm', 'migrate'], {
        cwd: root,
      })
      if (migrate !== 0) {
        throw new WizardError(
          'docker compose run --rm migrate failed — check the compose logs and re-run',
        )
      }
      logStep('docker compose up -d (Postgres + Redis + API + dashboard)')
      const code = await runInherit(['docker', 'compose', 'up', '-d'], { cwd: root })
      if (code !== 0) {
        throw new WizardError('docker compose up failed — check the compose logs and re-run')
      }
      logStep('Recreating the API container with generated deployment URLs')
      const apiCode = await runInherit(
        ['docker', 'compose', 'up', '-d', '--force-recreate', '--no-deps', 'api'],
        { cwd: root },
      )
      if (apiCode !== 0) {
        throw new WizardError('API container recreation failed — check the compose logs and re-run')
      }
      result.apiUrl = 'http://localhost:8787'
      logSuccess('Compose is up — API http://localhost:8787 · dashboard http://localhost:3000')
    } else {
      const databaseUrl = serverEnv['DATABASE_URL'] ?? ''
      if (!databaseUrl) throw new WizardError('DATABASE_URL missing from server/.dev.vars')
      await dbMigrate(root, databaseUrl)

      const apiUrl = await deployWorker(root, 'server')
      if (apiUrl) {
        writeEnv([
          ['BETTER_AUTH_URL', apiUrl],
          ['BACKEND_URL', apiUrl],
        ])
        result.apiUrl = apiUrl
        logSuccess(`API deployed: ${apiUrl}`)
      } else {
        logWarn('API deploy finished but no workers.dev URL was parsed')
      }

      const updated = readServerEnv(root)
      if (!updated) throw new WizardError('server/.dev.vars disappeared mid-deploy')
      const secretEntries = ([...SERVER_KEY_ORDER, 'SWEEP_ENABLED'] as readonly string[]).map((key) => [
        key,
        updated[key] ?? '',
      ]) as Array<readonly [string, string]>
      logStep('Uploading API secrets (wrangler secret bulk)')
      await putWorkerSecrets(root, 'server', secretEntries, temp)
      logSuccess('API secrets uploaded')
    }

    // ── 6. Refresh Modal callback hosts once the API host is known ───────
    const apiHost =
      answers.runtime === 'workers'
        ? hostOf(result.apiUrl)
        : hostOf(readServerEnv(root)?.['BETTER_AUTH_URL'] ?? null)
    if (modalBin && apiHost && apiHost !== 'localhost') {
      const env = readServerEnv(root)
      if (env) {
        logStep('Refreshing ALLOWED_CALLBACK_HOSTS on the r2-creds Modal secret')
        await putModalSecret(
          modalBin,
          'r2-creds',
          r2CredsValues({
            accountId: effectiveAccountId,
            accessKeyId: env['R2_ACCESS_KEY_ID'] ?? '',
            secretAccessKey: env['R2_SECRET_ACCESS_KEY'] ?? '',
            transcodedBucket: answers.transcodedBucket,
            rawBucket: answers.rawBucket,
            ingestSecret: env['TRANSCODE_INGEST_SECRET'] ?? '',
            callbackHosts: ['localhost', apiHost].join(','),
          }),
          { force: true },
        )
        logSuccess('r2-creds ALLOWED_CALLBACK_HOSTS updated')
      }
    }

    // ── 7. Local env report + health probe ───────────────────────────────
    const finalEnv = readServerEnv(root)
    if (finalEnv) {
      const { rows, failed } = lintServerEnv(finalEnv)
      printCheckRows(rows)
      if (failed) {
        logWarn('Some BYOK keys are still missing — see the rows above and server/.dev.vars.example')
      }
    }
    await probeHealth(result.apiUrl ?? serverEnv['BETTER_AUTH_URL'] ?? null)
    return result
  } finally {
    temp.cleanup()
  }
}

/**
 * Finish a deploy that has no Modal component.
 *
 * Everything except the Modal steps still has to happen — the delivery worker,
 * the API secrets and the health probe are all provider-independent — so this
 * shares the tail of the main phase rather than returning early with an
 * unfinished deployment.
 */
async function finishDeployWithoutModal(
  root: string,
  answers: WizardAnswers,
  temp: TempDir,
): Promise<void> {
  const result: DeployResult = { apiUrl: null, deliveryUrl: null, modalUrl: null }
  const writeEnv = makeEnvWriter(root, answers.runtime)

  // The delivery worker is Cloudflare in every configuration, including a
  // local-only one: it is how a player gets signed bytes. Skipping it here would
  // produce an installation that transcodes perfectly and cannot play anything.
  logStep('Deploying the delivery worker')
  try {
    const deliveryUrl = await deployWorker(root, 'delivery')
    if (deliveryUrl) {
      writeEnv([['DELIVERY_URL', deliveryUrl]])
      result.deliveryUrl = deliveryUrl
      logSuccess(`Delivery worker deployed: ${deliveryUrl}`)
    } else {
      logWarn('delivery deploy finished but no workers.dev URL was parsed — set DELIVERY_URL by hand')
    }
    const jwt = readServerEnv(root)?.['JWT_SECRET']
    if (jwt) {
      logStep('Uploading delivery JWT_SECRET')
      await putWorkerSecrets(root, 'delivery', [['JWT_SECRET', jwt]], temp)
      logSuccess('Delivery JWT_SECRET uploaded')
    }
  } catch (error) {
    logWarn(
      `Delivery deployment failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'Playback will not work until it is deployed.',
    )
  }

  logStep('Checking configuration')
  const env = readServerEnv(root)
  if (env) {
    const { rows, failed } = lintServerEnv(env)
    printCheckRows(rows)
    if (failed) {
      logWarn('Some keys are still missing — see the rows above and server/.dev.vars.example')
    }
  }

  await probeHealth(env?.['BETTER_AUTH_URL'] ?? null)
  void answers
  void temp
  return
}
