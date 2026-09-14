#!/usr/bin/env tsx
/**
 * OpenVOD bootstrap wizard entrypoint (run by scripts/bootstrap.sh after the
 * toolchain check; also runnable directly once node + pnpm exist).
 *
 *   ./scripts/bootstrap.sh                 interactive configure
 *   ./scripts/bootstrap.sh --force         regenerate existing .dev.vars
 *   ./scripts/bootstrap.sh --answers a.json  headless configure (no TTY needed)
 *   ./scripts/bootstrap.sh --deploy        provision & deploy (Cloudflare/Modal)
 *   ./scripts/bootstrap.sh --check [url]   lint .dev.vars (+ probe /health/config)
 *
 * Design: configure never touches the network; deploy only runs when asked.
 * Headless runs never use the TUI; the deploy phase requires a terminal
 * because auth flows (wrangler/modal login) are interactive.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DbKind,
  Prefill,
  QueueKind,
  RateLimitKind,
  RuntimeKind,
  SecretSet,
  WizardAnswers,
} from './types'
import { DEFAULT_ANSWERS } from './types'
import {
  buildDeployEnvEntries,
  buildDeliveryEntries,
  buildServerEntries,
  deriveAnswersFromEnv,
  validateAnswers,
  warningsFor,
} from './mapping'
import {
  deployEnvPath,
  deliveryVarsPath,
  ensureDeployEnv,
  readDeliveryEnv,
  readServerEnv,
  serverVarsPath,
  writeEnvPair,
} from './envio'
import { newSecretSet } from './secret'
import { WizardError } from './errors'
import { askQuestions } from './questions'
import { cfAccountId } from './cloudflare'
import { runDeployPhase } from './deploy'
import { lintEnvFiles, type CheckRow } from './verify'
import { summaryText } from './display'
import { linksNote, type LinkKind } from './links'
import {
  announceCancel,
  askConfirm,
  askSelect,
  CancelledError,
  color,
  formatCheckRow,
  intro,
  isTty,
  logStep,
  logSuccess,
  logWarn,
  note,
  outro,
  printCheckRows,
  printError,
  printHelp,
  printOk,
  withSpinner,
} from './ui'

interface CliOptions {
  help: boolean
  force: boolean
  deploy: boolean
  answersPath: string | undefined
  checkEnabled: boolean
  checkUrl: string | undefined
  prefill: Prefill
}

function usageError(message: string): never {
  printError(message)
  printHelp()
  process.exit(2)
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    force: false,
    deploy: false,
    answersPath: undefined,
    checkEnabled: false,
    checkUrl: undefined,
    prefill: {},
  }

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) usageError(`${flag} requires a value`)
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--force':
        options.force = true
        break
      case '--deploy':
        options.deploy = true
        break
      case '--skip-deploy':
        // Accepted for compatibility; configure-only is the default flow now.
        break
      case '--answers': {
        options.answersPath = next(i, arg)
        i += 1
        break
      }
      case '--check':
        options.checkEnabled = true
        if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
          options.checkUrl = argv[i + 1]
          i += 1
        }
        break
      case '--runtime': {
        const value = next(i, arg)
        // 'compose' was the old name for the Node runtime; still accepted so an
        // existing script or answers file does not break.
        if (value !== 'workers' && value !== 'node' && value !== 'compose') {
          usageError(`--runtime must be workers|node, got ${value}`)
        }
        options.prefill.runtime = (value === 'compose' ? 'node' : value) as RuntimeKind
        i += 1
        break
      }
      case '--db': {
        const value = next(i, arg)
        if (value !== 'neon' && value !== 'local' && value !== 'existing') {
          usageError(`--db must be neon|local|existing, got ${value}`)
        }
        options.prefill.dbKind = value as DbKind
        i += 1
        break
      }
      case '--queue': {
        const value = next(i, arg)
        if (value !== 'direct' && value !== 'qstash') {
          usageError(`--queue must be direct|qstash, got ${value}`)
        }
        options.prefill.queueKind = value as QueueKind
        i += 1
        break
      }
      case '--ratelimit': {
        const value = next(i, arg)
        if (value !== 'memory' && value !== 'upstash') {
          usageError(`--ratelimit must be memory|upstash, got ${value}`)
        }
        options.prefill.rateLimitKind = value as RateLimitKind
        i += 1
        break
      }
      default:
        usageError(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** Walk up from cwd to the pnpm workspace root. */
function findRepoRoot(): string {
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) {
      throw new WizardError(
        'could not find pnpm-workspace.yaml — run the wizard from inside the OpenVOD repo clone',
      )
    }
    dir = parent
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
}

function loadAnswersFile(path: string): WizardAnswers {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new WizardError(
      `could not read answers file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WizardError('answers file must be a JSON object (see --help for the schema)')
  }
  const answers = raw as Partial<WizardAnswers>
  const dbKind = answers.db?.kind
  const queueKind = answers.queue?.kind
  const rateKind = answers.rateLimit?.kind
  if (dbKind !== 'neon' && dbKind !== 'local' && dbKind !== 'existing') {
    throw new WizardError('answers db.kind must be "neon", "local" or "existing"')
  }
  if (queueKind !== 'direct' && queueKind !== 'qstash') {
    throw new WizardError('answers queue.kind must be "direct" or "qstash"')
  }
  if (rateKind !== 'memory' && rateKind !== 'redis' && rateKind !== 'upstash') {
    throw new WizardError('answers rateLimit.kind must be "memory", "redis" or "upstash"')
  }
  const merged: WizardAnswers = {
    runtime: answers.runtime === 'workers' ? 'workers' : 'node',
    db: { kind: dbKind, ...(answers.db?.url ? { url: answers.db.url } : {}) },
    queue: { kind: queueKind, ...(answers.queue?.token ? { token: answers.queue.token } : {}) },
    rateLimit: {
      kind: rateKind,
      ...(answers.rateLimit?.url ? { url: answers.rateLimit.url } : {}),
      ...(answers.rateLimit?.restUrl ? { restUrl: answers.rateLimit.restUrl } : {}),
      ...(answers.rateLimit?.token ? { token: answers.rateLimit.token } : {}),
    },
    accountId: (answers.accountId ?? '').toString().trim(),
    r2AccessKeyId: (answers.r2AccessKeyId ?? '').toString().trim(),
    r2SecretAccessKey: (answers.r2SecretAccessKey ?? '').toString().trim(),
    rawBucket: (answers.rawBucket ?? DEFAULT_ANSWERS.rawBucket).toString().trim(),
    transcodedBucket: (answers.transcodedBucket ?? DEFAULT_ANSWERS.transcodedBucket)
      .toString()
      .trim(),
    frontendUrl: (answers.frontendUrl ?? DEFAULT_ANSWERS.frontendUrl).toString().trim(),
    groqApiKey: answers.groqApiKey?.toString().trim() || undefined,
  }
  return merged
}

function nextStepsText(answers: WizardAnswers): string {
  const dashboard = `${color.cmd('pnpm dev')}   →  http://localhost:3000/setup`
  const delivery = 'Playback still needs the Cloudflare delivery worker:'
  if (answers.runtime === 'workers') {
    return [
      'Develop:',
      `  ${color.cmd('pnpm dev:workers')}                     ${color.muted('# wrangler dev :8787 + dashboard :3000')}`,
      `  ${color.muted('The Workers runtime needs DB_DRIVER=neon-http with a Neon URL.')}`,
      `Verify:  ${color.cmd('./scripts/bootstrap.sh --check http://localhost:8787')}`,
      '',
      'Deploy:',
      `  ${color.cmd('./scripts/bootstrap.sh --deploy')}      ${color.muted('(Cloudflare + Modal provision & deploy)')}`,
      `  ${delivery}`,
    ].join('\n')
  }
  return [
    'Develop (this machine):',
    `  ${color.cmd('pnpm dev:infra')}                       ${color.muted('# Postgres :5433 + Redis :6382')}`,
    `  ${color.cmd('pnpm db:migrate')}`,
    `  ${dashboard}`,
    '',
    'Deploy (Docker, end users):',
    `  ${color.cmd('cp .env.example .env')}                 ${color.muted('# deployment config (not server/.dev.vars)')}`,
    `  ${color.cmd('pnpm docker:migrate && pnpm docker:up')}`,
    `  ${delivery}`,
    `  ${color.cmd('./scripts/bootstrap.sh --deploy')}      ${color.muted('# or: cd delivery && pnpm exec wrangler deploy')}`,
  ].join('\n')
}

/** Where to send someone for each key the verifier can report as missing. */
const MISSING_KEY_LINKS: Record<string, LinkKind> = {
  DATABASE_URL: 'neon',
  ACCOUNT_ID: 'cfAccountId',
  R2_ACCESS_KEY_ID: 'r2ApiTokens',
  R2_SECRET_ACCESS_KEY: 'r2ApiTokens',
  MODAL_WEBHOOK_URL: 'modal',
  GROQ_API_KEY: 'groq',
  QSTASH_TOKEN: 'qstash',
  UPSTASH_REDIS_REST_URL: 'upstash',
  UPSTASH_REDIS_REST_TOKEN: 'upstash',
}

/** Links for the providers behind every *failing* (non-advisory) row. */
function missingLinkKinds(rows: readonly CheckRow[]): LinkKind[] {
  const kinds: LinkKind[] = []
  for (const row of rows) {
    if (row.ok || row.advisory || row.key === undefined) continue
    const kind = MISSING_KEY_LINKS[row.key]
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/** The wizard is part of the repo, so it reports the repo's own version. */
function repoVersion(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

async function runCheck(root: string, checkUrl: string | undefined): Promise<boolean> {
  const serverEnv = readServerEnv(root)
  const deliveryEnv = readDeliveryEnv(root)
  const { rows, failed } = lintEnvFiles(serverEnv, deliveryEnv)
  printCheckRows(rows)
  if (failed) {
    const kinds = missingLinkKinds(rows)
    if (kinds.length > 0) note(linksNote(kinds), 'Where to get what is missing')
  }
  if (checkUrl !== undefined) {
    const base = checkUrl.replace(/\/+$/, '')
    // eslint-disable-next-line no-console
    console.log(color.muted(`→ Probing ${base}/health/config …`))
    try {
      const response = await fetch(`${base}/health/config`, {
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        // eslint-disable-next-line no-console
        console.log(color.fail(`✗ HTTP ${response.status}`))
        return false
      }
      const body = (await response.json()) as {
        ready?: boolean
        checks?: Record<string, boolean>
        problems?: string[]
        advisories?: string[]
      }
      // eslint-disable-next-line no-console
      console.log(`ready: ${String(body.ready)}`)
      for (const [key, ok] of Object.entries(body.checks ?? {})) {
        // eslint-disable-next-line no-console
        console.log(`  ${ok ? color.ok('✓') : color.muted('○')} ${key}`)
      }
      for (const problem of body.problems ?? []) {
        // eslint-disable-next-line no-console
        console.log(color.fail(`✗ ${problem}`))
      }
      for (const advisory of body.advisories ?? []) {
        // eslint-disable-next-line no-console
        console.log(color.muted(`○ ${advisory}`))
      }
      return Boolean(body.ready)
    } catch {
      // eslint-disable-next-line no-console
      console.log(color.fail(`✗ could not reach ${base}/health/config`))
      return false
    }
  }
  return !failed
}

/** Headless configure: validate answers, write env files, plain-text report. */
function headlessConfigure(root: string, opts: CliOptions): WizardAnswers {
  const answers = loadAnswersFile(opts.answersPath as string)
  const problems = validateAnswers(answers)
  if (problems.length > 0) {
    throw new WizardError(`answers are incomplete:\n  - ${problems.join('\n  - ')}`)
  }
  const secrets = newSecretSet()
  writeEnvPair(
    root,
    buildServerEntries(answers, secrets),
    buildDeliveryEntries(secrets),
    opts.force,
  )
  printOk(`Wrote ${serverVarsPath(root)} and ${deliveryVarsPath(root)} (mode 0600)`)
  noteDeployEnv(root, answers, secrets)
  const report = lintEnvFiles(readServerEnv(root), readDeliveryEnv(root))
  printCheckRows(report.rows)
  return answers
}

/**
 * Offer the deployment config too, for a Docker deployment.
 *
 * Written only when absent: an operator's `.env` holds real domains and image
 * tags, and quietly replacing those with localhost defaults would be worse than
 * saying nothing. A Workers deployment does not use it at all.
 */
function noteDeployEnv(root: string, answers: WizardAnswers, secrets: SecretSet): void {
  if (answers.runtime !== 'node') return
  const wrote = ensureDeployEnv(root, buildDeployEnvEntries(answers, secrets))
  if (wrote) {
    printOk(
      `Wrote ${deployEnvPath(root)} — the DOCKER deployment config (edit the public ` +
        'URLs before exposing it)',
    )
  } else {
    printOk(`${deployEnvPath(root)} already exists — left untouched`)
  }
}

async function interactiveConfigure(root: string, opts: CliOptions): Promise<WizardAnswers> {
  let accountIdDefault: string | null = null
  try {
    accountIdDefault = await withSpinner(
      'Checking for an existing wrangler login…',
      () => cfAccountId(root),
      undefined,
    )
  } catch {
    accountIdDefault = null
  }
  const answers = await askQuestions({
    prefill: opts.prefill,
    accountIdDefault: accountIdDefault ?? undefined,
  })

  const problems = validateAnswers(answers)
  if (problems.length > 0) {
    throw new WizardError(`answers are incomplete:\n  - ${problems.join('\n  - ')}`)
  }

  note(summaryText(answers), 'Your choices')
  const warnings = warningsFor(answers)
  if (warnings.length > 0) logWarn(warnings.join('\n'))

  const exists = existsSync(serverVarsPath(root)) || existsSync(deliveryVarsPath(root))
  const message = exists
    ? 'Overwrite the existing .dev.vars files with these settings? (keys the wizard does not manage are preserved)'
    : 'Write server/.dev.vars + delivery/.dev.vars with these settings?'
  const confirmed = await askConfirm(message, true)
  if (!confirmed) {
    announceCancel()
    process.exit(0)
  }

  const secrets = newSecretSet()
  writeEnvPair(
    root,
    buildServerEntries(answers, secrets),
    buildDeliveryEntries(secrets),
    opts.force,
  )
  logSuccess(`Wrote ${serverVarsPath(root)} and ${deliveryVarsPath(root)} (mode 0600, secrets never logged)`)
  noteDeployEnv(root, answers, secrets)
  return answers
}

type ExistingAction = 'verify' | 'reconfigure' | 'deploy' | 'next' | 'exit'

/**
 * What to do when server/.dev.vars already exists.
 *
 * Re-running the wizard used to be a hard error ("already exists — re-run with
 * --force"), which turned the second run — the normal way to deploy, verify or
 * tweak — into a failure. This is the same menu shape the create-* CLIs ship.
 */
async function askExistingAction(root: string): Promise<ExistingAction> {
  const serverEnv = readServerEnv(root) ?? {}
  const report = lintEnvFiles(serverEnv, readDeliveryEnv(root))
  note(
    report.rows.map(formatCheckRow).join('\n'),
    report.failed ? 'Existing configuration (incomplete)' : 'Existing configuration',
  )

  return askSelect<ExistingAction>(
    'server/.dev.vars already exists — what now?',
    [
      {
        value: 'verify',
        label: 'Verify it',
        hint: 're-check every key without printing secrets',
      },
      {
        value: 'reconfigure',
        label: 'Reconfigure',
        hint: 're-run the wizard; keys it does not manage are preserved',
      },
      {
        value: 'deploy',
        label: 'Provision & deploy',
        hint: 'Cloudflare + Modal, using this .dev.vars',
      },
      {
        value: 'next',
        label: 'Show next steps',
        hint: 'develop, migrate, deploy',
      },
      { value: 'exit', label: 'Exit', hint: 'nothing is written' },
    ],
    'verify',
  )
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    printHelp()
    return
  }

  const root = findRepoRoot()
  process.umask(0o077)

  // pnpm exec scopes its cwd to the package dir; resolve a relative answers
  // path against the repo root so `--answers ./file.json` works everywhere.
  if (opts.answersPath !== undefined && !isAbsolutePath(opts.answersPath)) {
    opts.answersPath = join(root, opts.answersPath)
  }

  if (opts.checkEnabled) {
    const ok = await runCheck(root, opts.checkUrl)
    if (!ok) process.exitCode = 1
    return
  }

  const interactive = isTty()
  if (!interactive) {
    if (opts.answersPath === undefined) {
      // No terminal and an existing configuration means "nothing to do", not
      // "failure". Report what is there and how to change it, then exit 0.
      const configured = readServerEnv(root)
      if (configured !== undefined && !opts.force) {
        const report = lintEnvFiles(configured, readDeliveryEnv(root))
        printCheckRows(report.rows)
        const kinds = report.failed ? missingLinkKinds(report.rows) : []
        if (kinds.length > 0) note(linksNote(kinds), 'Where to get what is missing')
        printOk(
          `${serverVarsPath(root)} already exists — nothing changed. ` +
            'Reconfigure with --force, or edit the file and re-run --check.',
        )
        return
      }
      throw new WizardError(
        'this wizard needs an interactive terminal.\n' +
          'Headless runs: create an answers JSON file (see --help) and pass --answers <file>.',
      )
    }
    if (opts.deploy) {
      throw new WizardError(
        'the provision & deploy phase is interactive (wrangler/modal browser logins) — run it from a terminal',
      )
    }
    const answers = headlessConfigure(root, opts)
    // eslint-disable-next-line no-console
    console.log(`\n${nextStepsText(answers)}`)
    return
  }

  intro(repoVersion(root))

  const envExists = existsSync(serverVarsPath(root)) || existsSync(deliveryVarsPath(root))

  let answers: WizardAnswers
  let deployNow = opts.deploy
  if (!envExists || opts.force) {
    answers = await interactiveConfigure(root, opts)
  } else if (opts.deploy) {
    // Explicit flag: deploy with what is already configured, no menu.
    const env = readServerEnv(root)
    if (!env) throw new WizardError(`${serverVarsPath(root)} is missing — configure first`)
    answers = deriveAnswersFromEnv(env)
    logWarn('Using the existing server/.dev.vars — pass --force to regenerate it first')
  } else {
    // A second run is a normal thing to do, not an error: show what is already
    // configured and let the user pick what they came for.
    const action = await askExistingAction(root)

    if (action === 'exit') {
      outro('Nothing changed')
      return
    }
    if (action === 'reconfigure') {
      answers = await interactiveConfigure(root, { ...opts, force: true })
    } else {
      const env = readServerEnv(root)
      if (!env) throw new WizardError(`${serverVarsPath(root)} is missing — configure first`)
      answers = deriveAnswersFromEnv(env)
      if (action === 'deploy') {
        logWarn('Using the existing server/.dev.vars — pass --force to regenerate it first')
        deployNow = true
      } else {
        // 'verify' and 'next' are read-only: report, then print next steps.
        if (action === 'verify') await runCheck(root, undefined)
        note(nextStepsText(answers), 'Next steps')
        outro('Done')
        return
      }
    }
  }

  if (deployNow) {
    logStep('Provision & deploy phase')
    await runDeployPhase(root, answers)
  } else if (!envExists || opts.force) {
    note(linksNote(['modal']), 'Transcoding runs on Modal')
    const choice = await askSelect<'later' | 'deploy'>(
      'Provision and deploy to Cloudflare + Modal now?',
      [
        {
          value: 'later',
          label: 'Not now — local environment only (recommended first run)',
          hint: 're-run anytime with: ./scripts/bootstrap.sh --deploy',
        },
        {
          value: 'deploy',
          label: 'Yes — Cloudflare login, R2 buckets, Modal pipeline, worker deploys',
          hint: 'longer; needs Cloudflare + Modal accounts',
        },
      ],
      'later',
    )
    if (choice === 'deploy') {
      await runDeployPhase(root, answers)
    }
  }

  const serverEnv = readServerEnv(root)
  if (serverEnv) {
    const report = lintEnvFiles(serverEnv, readDeliveryEnv(root))
    note(report.rows.map(formatCheckRow).join('\n'), 'Environment check')
    if (report.failed) {
      logWarn('Some keys are still missing — see rows above, or re-run the wizard')
      const kinds = missingLinkKinds(report.rows)
      if (kinds.length > 0) note(linksNote(kinds), 'Where to get what is missing')
    } else {
      logSuccess('Environment looks configured')
    }
  }

  note(nextStepsText(answers), 'Next steps')
  outro('Done — happy streaming')
}

main().catch((error: unknown) => {
  if (error instanceof CancelledError) {
    announceCancel()
    process.exitCode = 130
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  printError(message)
  process.exitCode = 1
})
