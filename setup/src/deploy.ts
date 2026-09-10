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
  dbPush,
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
import { findOnPath, runInherit } from './runners'
import { readServerEnv, upsertServerEnv } from './envio'
import { askConfirm, logInfo, logStep, logSuccess, logWarn } from './ui'
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
export async function runDeployPhase(
  root: string,
  answers: WizardAnswers,
): Promise<DeployResult> {
  const serverEnv = readServerEnv(root)
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
      upsertServerEnv(root, [['ACCOUNT_ID', effectiveAccountId]])
      logInfo('ACCOUNT_ID in server/.dev.vars updated to the logged-in account')
    }

    // ── 2. Buckets + CORS + delivery config ─────────────────────────────
    logStep(`Creating R2 buckets (${answers.rawBucket}, ${answers.transcodedBucket})`)
    await ensureBucket(root, answers.rawBucket)
    logSuccess(`R2 bucket ${answers.rawBucket} ready`)
    await ensureBucket(root, answers.transcodedBucket)
    logSuccess(`R2 bucket ${answers.transcodedBucket} ready`)

    logStep(`Applying S3 CORS to ${answers.rawBucket} for browser uploads`)
    await applyBucketCors(root, answers.rawBucket, [answers.frontendUrl], temp)
    logSuccess('CORS policy applied (GET/PUT/HEAD, ETag exposed)')

    logStep('Pointing delivery/wrangler.jsonc at the transcoded bucket')
    const patched = patchDeliveryBucket(root, answers.transcodedBucket)
    logSuccess(patched ? 'delivery/wrangler.jsonc updated' : 'delivery/wrangler.jsonc already correct')

    // ── 3. Modal CLI + auth + secrets + deploy ──────────────────────────
    let modalBin = await findModalBin()
    if (!modalBin) {
      const install = await askConfirm(
        'Modal CLI is not installed. Install it now (uv tool → pipx → python venv)?',
        true,
      )
      if (install) modalBin = await installModalCli()
      else logWarn('Skipping Modal — deploy the pipeline yourself: see README "Deploy the transcoder"')
    }

    if (modalBin) {
      const authed = await modalAuthed(modalBin)
      if (!authed) {
        const setup = await askConfirm(
          'Modal CLI is not authenticated. Run modal setup now (opens your browser)?',
          true,
        )
        if (setup) {
          await runModalSetup(modalBin)
        } else {
          logWarn('Skipping Modal auth — run `modal setup` yourself, then re-run --deploy')
        }
      }
      if (authed || (await modalAuthed(modalBin))) {
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

        const modalUrl = await deployModalPipeline(root, modalBin)
        if (modalUrl) {
          upsertServerEnv(root, [['MODAL_WEBHOOK_URL', modalUrl]])
          result.modalUrl = modalUrl
          logSuccess(`MODAL_WEBHOOK_URL=${modalUrl}`)
        } else {
          logWarn(
            'modal deploy finished but no *.modal.run URL was parsed — paste the URL into server/.dev.vars (MODAL_WEBHOOK_URL)',
          )
        }
      }
    }

    // ── 4. API runtime ───────────────────────────────────────────────────
    if (answers.runtime === 'compose') {
      if (!findOnPath('docker')) {
        throw new WizardError(
          'docker was not found — the compose runtime needs Docker. Install it and re-run with --deploy.',
        )
      }
      logStep('docker compose up -d (Postgres + API + dashboard)')
      const code = await runInherit(['docker', 'compose', 'up', '-d'], { cwd: root })
      if (code !== 0) {
        throw new WizardError('docker compose up failed — check the compose logs and re-run')
      }
      result.apiUrl = 'http://localhost:8787'
      logSuccess('Compose is up — API http://localhost:8787 · dashboard http://localhost:3000')
    } else {
      const databaseUrl = serverEnv['DATABASE_URL'] ?? ''
      if (!databaseUrl) throw new WizardError('DATABASE_URL missing from server/.dev.vars')
      await dbPush(root, databaseUrl)

      const apiUrl = await deployWorker(root, 'server')
      if (apiUrl) {
        upsertServerEnv(root, [
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
      const secretEntries = (SERVER_KEY_ORDER as readonly string[]).map((key) => [
        key,
        updated[key] ?? '',
      ]) as Array<readonly [string, string]>
      logStep('Uploading API secrets (wrangler secret bulk)')
      await putWorkerSecrets(root, 'server', secretEntries, temp)
      logSuccess('API secrets uploaded')
    }

    // ── 5. Delivery worker (always Cloudflare) ───────────────────────────
    const deliveryUrl = await deployWorker(root, 'delivery')
    if (deliveryUrl) {
      upsertServerEnv(root, [['DELIVERY_URL', deliveryUrl]])
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

    // ── 6. Refresh Modal callback hosts once the API host is known ───────
    const apiHost =
      answers.runtime === 'workers'
        ? hostOf(result.apiUrl)
        : hostOf(serverEnv['BETTER_AUTH_URL'] ?? null)
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
        )
        logSuccess('r2-creds ALLOWED_CALLBACK_HOSTS updated')
      }
    }

    // ── 7. Local env report + health probe ───────────────────────────────
    const finalEnv = readServerEnv(root)
    if (finalEnv) {
      const { rows, failed } = lintServerEnv(finalEnv)
      for (const row of rows) {
        if (row.ok) logSuccess(row.text)
        else if (row.advisory) logInfo(`${row.text} — optional / advisory`)
        else logWarn(row.text)
      }
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
