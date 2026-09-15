#!/usr/bin/env tsx
/**
 * OpenVOD bootstrap wizard entrypoint (run by scripts/bootstrap.sh after the
 * toolchain check; also runnable directly once node + pnpm exist).
 *
 *   ./scripts/bootstrap.sh                 interactive configure
 *   ./scripts/bootstrap.sh --force         regenerate existing config
 *   ./scripts/bootstrap.sh --answers a.json  headless configure (no TTY needed)
 *   ./scripts/bootstrap.sh --deploy        provision & deploy (Cloudflare/Modal)
 *   ./scripts/bootstrap.sh --check [url]   lint the config (+ probe /health/config)
 *
 * Design: one run owns ONE configuration target (dev: server/.dev.vars +
 * delivery/.dev.vars; deploy: the root .env). Choices are asked first, then the
 * machine is checked against them, then credentials are collected, then — only
 * when asked — the infrastructure phase runs.
 *
 * Configure never touches the network; deploy only runs when asked. Headless
 * runs never use the TUI; the deploy phase requires a terminal because auth
 * flows (wrangler/modal login) are interactive.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ConfigTarget,
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
  buildDeployConfig,
  buildDeliveryEntries,
  buildDevConfig,
  deriveAnswersFromConfig,
  transcodeProvider,
  validateAnswers,
  validateChoices,
  validateCredentials,
  warningsFor,
} from './mapping'
import type { ChoiceShape } from './mapping'
import {
  deliveryVarsPath,
  existingTargets,
  primaryConfigPath,
  readDeliveryEnv,
  readTargetConfig,
  serverVarsPath,
  upsertTargetConfig,
  writeTargetConfig,
} from './envio'
import { preservedSecretKeys, secretSetFor } from './secret'
import { WizardError } from './errors'
import { askChoices, askCredentials } from './questions'
import { runPreflight } from './preflight'
import { systemShapeFromAnswers } from './system'
import { cfAccountId } from './cloudflare'
import { deployReportLines, deploySummaryLine, runDeployPhase } from './deploy'
import { lintDeployEnv, lintEnvFiles, type CheckRow } from './verify'
import { summaryText } from './display'
import { linksNote, type LinkKind } from './links'
import { agentApiUrlNote, pairingCommand } from './pairing'
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
  doctor: boolean
  force: boolean
  rotateSecrets: boolean
  deploy: boolean
  answersPath: string | undefined
  checkEnabled: boolean
  checkUrl: string | undefined
  target: ConfigTarget | undefined
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
    doctor: false,
    force: false,
    rotateSecrets: false,
    deploy: false,
    answersPath: undefined,
    checkEnabled: false,
    checkUrl: undefined,
    target: undefined,
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
      case '--doctor':
        options.doctor = true
        break
      case '--force':
        options.force = true
        break
      case '--rotate-secrets':
        options.rotateSecrets = true
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
      case '--target': {
        const value = next(i, arg)
        if (value !== 'dev' && value !== 'deploy') {
          usageError(`--target must be dev|deploy, got ${value}`)
        }
        options.target = value
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
        if (value !== 'memory' && value !== 'redis' && value !== 'upstash') {
          usageError(`--ratelimit must be memory|redis|upstash, got ${value}`)
        }
        options.prefill.rateLimitKind = value as RateLimitKind
        i += 1
        break
      }
      case '--transcode': {
        const value = next(i, arg)
        if (value !== 'modal' && value !== 'self-hosted') {
          usageError(`--transcode must be modal|self-hosted, got ${value}`)
        }
        options.prefill.transcodeProvider = value
        i += 1
        break
      }
      case '--uploads': {
        const value = next(i, arg)
        if (value !== 'on' && value !== 'off') {
          usageError(`--uploads must be on|off, got ${value}`)
        }
        options.prefill.uploadsEnabled = value === 'on'
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
  const target = answers.target
  if (target !== undefined && target !== 'dev' && target !== 'deploy') {
    throw new WizardError('answers target must be "dev" or "deploy"')
  }
  if (dbKind !== 'neon' && dbKind !== 'local' && dbKind !== 'existing') {
    throw new WizardError('answers db.kind must be "neon", "local" or "existing"')
  }
  if (queueKind !== 'direct' && queueKind !== 'qstash') {
    throw new WizardError('answers queue.kind must be "direct" or "qstash"')
  }
  if (rateKind !== 'memory' && rateKind !== 'redis' && rateKind !== 'upstash') {
    throw new WizardError('answers rateLimit.kind must be "memory", "redis" or "upstash"')
  }
  const provider = answers.transcodeProvider
  if (provider !== undefined && provider !== 'modal' && provider !== 'self-hosted') {
    throw new WizardError('answers transcodeProvider must be "modal" or "self-hosted"')
  }
  const merged: WizardAnswers = {
    ...(target !== undefined ? { target } : {}),
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
    ...(provider !== undefined ? { transcodeProvider: provider } : {}),
    ...(answers.selfHostedEnabled !== undefined
      ? { selfHostedEnabled: answers.selfHostedEnabled === true }
      : {}),
    ...(answers.uploadsEnabled !== undefined
      ? { uploadsEnabled: answers.uploadsEnabled !== false }
      : {}),
    frontendUrl: (answers.frontendUrl ?? DEFAULT_ANSWERS.frontendUrl).toString().trim(),
    groqApiKey: answers.groqApiKey?.toString().trim() || undefined,
  }
  return merged
}

/** The `--deploy` / `--check` flag suffix that keeps a run on its target. */
function targetFlag(target: ConfigTarget): string {
  return target === 'deploy' ? ' --target deploy' : ''
}

function nextStepsText(answers: WizardAnswers): string {
  const target = answers.target ?? 'dev'
  const local = transcodeProvider(answers) === 'self-hosted'
  const pairing = local
    ? ['', 'Encode on this machine (self-hosted provider):', `  ${pairingCommand()}`]
    : []

  if (target === 'deploy') {
    return [
      'Run the stack (Docker Compose):',
      `  ${color.cmd('pnpm docker:migrate')}                 ${color.muted('# migrate the .env database')}`,
      `  ${color.cmd('pnpm docker:up')}                      ${color.muted('# Postgres + Redis + API + dashboard')}`,
      `  ${color.muted('Dashboard http://localhost:3000 · API http://localhost:8787')}`,
      `  ${color.muted('NEXT_PUBLIC_* URLs are baked into the dashboard at build time — rebuild `web` when the domain changes.')}`,
      '',
      'Cloudflare + transcoder (delivery is always the Cloudflare Worker):',
      `  ${color.cmd(`./scripts/bootstrap.sh --deploy${targetFlag(target)}`)}`,
      ...pairing,
      ...(local ? ['', agentApiUrlNote(undefined, true)] : []),
      '',
      'Verify:',
      `  ${color.cmd('./scripts/bootstrap.sh --check')}`,
    ].join('\n')
  }

  const dashboard = `${color.cmd('pnpm dev')}   →  http://localhost:3000/setup`
  const delivery = 'Playback still needs the Cloudflare delivery worker:'
  const deployBlock = [
    'Deploy (Cloudflare + Modal):',
    `  ${color.cmd(`./scripts/bootstrap.sh --deploy${targetFlag(target)}`)}`,
    `  ${delivery}`,
    ...pairing,
  ]
  if (answers.runtime === 'workers') {
    return [
      'Develop:',
      `  ${color.cmd('pnpm dev:workers')}                     ${color.muted('# wrangler dev :8787 + dashboard :3000')}`,
      `  ${color.muted('The Workers runtime needs DB_DRIVER=neon-http with a Neon URL.')}`,
      `Verify:  ${color.cmd('./scripts/bootstrap.sh --check http://localhost:8787')}`,
      '',
      ...deployBlock,
      '',
      'Deploying the API itself with Docker Compose is a different configuration:',
      `  ${color.cmd('./scripts/bootstrap.sh --target deploy')}`,
    ].join('\n')
  }
  return [
    'Develop (this machine):',
    `  ${color.cmd('pnpm dev:infra')}                       ${color.muted('# Postgres :5433 + Redis :6382')}`,
    `  ${color.cmd('pnpm db:migrate')}`,
    `  ${dashboard}`,
    '',
    ...deployBlock,
    '',
    'Running the API for end users with Docker Compose is a different configuration:',
    `  ${color.cmd('./scripts/bootstrap.sh --target deploy')}`,
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

/** Lint the selected target's configuration, whatever shape it has. */
function lintTarget(root: string, target: ConfigTarget): { rows: CheckRow[]; failed: boolean } {
  if (target === 'deploy') {
    const env = readTargetConfig(root, 'deploy')
    if (!env) {
      return {
        rows: [{ ok: false, text: '.env missing — run ./scripts/bootstrap.sh --target deploy first' }],
        failed: true,
      }
    }
    return lintDeployEnv(env)
  }
  return lintEnvFiles(readTargetConfig(root, 'dev'), readDeliveryEnv(root))
}

async function runCheck(
  root: string,
  target: ConfigTarget,
  checkUrl: string | undefined,
): Promise<boolean> {
  const { rows, failed } = lintTarget(root, target)
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

/**
 * Secrets for this write: whatever the target file already has, unless the
 * caller asked to rotate. Reusing them is what keeps a reconfiguration from
 * invalidating playback tokens or locking the operator out of a database whose
 * volume still has the previous password.
 */
function secretsForWrite(
  root: string,
  target: ConfigTarget,
  options: { rotate: boolean },
): { secrets: SecretSet; preserved: string[] } {
  const existing = readTargetConfig(root, target)
  return {
    secrets: secretSetFor(existing, { rotate: options.rotate }),
    preserved: preservedSecretKeys(existing, { rotate: options.rotate }),
  }
}

function reportPreservedSecrets(preserved: readonly string[]): void {
  if (preserved.length === 0) return
  logSuccess(`Kept the existing ${preserved.join(', ')} (pass --rotate-secrets to replace them)`)
}

/** Write the target's configuration from the answers. */
function writeConfiguredTarget(
  root: string,
  answers: WizardAnswers,
  secrets: SecretSet,
  force: boolean,
): string[] {
  const target = answers.target ?? 'dev'
  const writes =
    target === 'deploy'
      ? { primary: buildDeployConfig(answers, secrets) }
      : {
          primary: buildDevConfig(answers, secrets),
          delivery: buildDeliveryEntries(secrets),
        }
  return writeTargetConfig(root, target, writes, force)
}

function describeWritten(paths: readonly string[]): string {
  return paths.join(' and ')
}

/** Headless configure: validate answers, write env files, plain-text report. */
function headlessConfigure(root: string, opts: CliOptions): WizardAnswers {
  const answers = loadAnswersFile(opts.answersPath as string)
  if (opts.target !== undefined) answers.target = opts.target
  const problems = validateAnswers(answers)
  if (problems.length > 0) {
    throw new WizardError(`answers are incomplete:\n  - ${problems.join('\n  - ')}`)
  }
  const target = answers.target ?? 'dev'
  const { secrets, preserved } = secretsForWrite(root, target, { rotate: opts.rotateSecrets })
  const paths = writeConfiguredTarget(root, answers, secrets, opts.force)
  printOk(`Wrote ${describeWritten(paths)} (mode 0600)`)
  reportPreservedSecrets(preserved)
  const report = lintTarget(root, target)
  printCheckRows(report.rows)
  return answers
}

async function interactiveConfigure(
  root: string,
  opts: CliOptions,
  target: ConfigTarget,
): Promise<WizardAnswers> {
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

  // Choices first: nothing is installed or collected until the shape is known.
  const choices = await askChoices({
    prefill: opts.prefill,
    target,
    accountIdDefault: accountIdDefault ?? undefined,
  })
  choices.target = target

  const choiceProblems = validateChoices(choices satisfies ChoiceShape)
  if (choiceProblems.length > 0) {
    throw new WizardError(`these choices cannot work together:\n  - ${choiceProblems.join('\n  - ')}`)
  }

  // Requirements phase: what the choices imply, what is here, what we may install.
  const preflight = await runPreflight({
    root,
    shape: choices,
    mode: 'develop',
    reportOnly: false,
  })
  if (preflight.blockers.length > 0) {
    throw new WizardError(
      `this machine is missing something the chosen setup needs:\n  - ` +
        preflight.blockers.map((status) => status.requirement.label).join('\n  - ') +
        '\nInstall them (commands are printed above), then re-run.',
    )
  }

  const answers = await askCredentials(choices, {
    ...(accountIdDefault !== null ? { accountIdDefault } : {}),
  })
  const credentialProblems = validateCredentials(answers)
  if (credentialProblems.length > 0) {
    throw new WizardError(
      `answers are incomplete:\n  - ${credentialProblems.join('\n  - ')}`,
    )
  }

  note(summaryText(answers), 'Your choices')
  const warnings = warningsFor(answers)
  if (warnings.length > 0) logWarn(warnings.join('\n'))

  const primary = primaryConfigPath(root, target)
  const exists = existsSync(primary) ||
    (target === 'dev' && existsSync(deliveryVarsPath(root)))
  const message = exists
    ? `Overwrite ${primary} with these settings? (keys the wizard does not manage, and existing secrets, are preserved)`
    : `Write the configuration for the ${target} target?`
  const confirmed = await askConfirm(message, true)
  if (!confirmed) {
    announceCancel()
    process.exit(0)
  }

  const { secrets, preserved } = secretsForWrite(root, target, { rotate: opts.rotateSecrets })
  const paths = writeConfiguredTarget(root, answers, secrets, true)
  logSuccess(`Wrote ${describeWritten(paths)} (mode 0600, secrets never logged)`)
  reportPreservedSecrets(preserved)
  return answers
}

type ExistingAction = 'verify' | 'reconfigure' | 'deploy' | 'next' | 'exit'

/**
 * What to do when the target's configuration already exists.
 *
 * Re-running the wizard used to be a hard error ("already exists — re-run with
 * --force"), which turned the second run — the normal way to deploy, verify or
 * tweak — into a failure. This is the same menu shape the create-* CLIs ship.
 */
async function askExistingAction(root: string, target: ConfigTarget): Promise<ExistingAction> {
  const report = lintTarget(root, target)
  note(
    report.rows.map(formatCheckRow).join('\n'),
    report.failed
      ? `Existing ${target} configuration (incomplete)`
      : `Existing ${target} configuration`,
  )

  return askSelect<ExistingAction>(
    `The ${target} configuration already exists — what now?`,
    [
      {
        value: 'verify',
        label: 'Verify it',
        hint: 're-check every key without printing secrets',
      },
      {
        value: 'reconfigure',
        label: 'Reconfigure',
        hint: 're-run the wizard; secrets and unmanaged keys are preserved',
      },
      {
        value: 'deploy',
        label: 'Provision & deploy',
        hint: 'Cloudflare + Modal, using this configuration',
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

/**
 * Which target a run owns.
 *
 * Ordered by how explicit the caller was: the flag, then the answers file, then
 * what is on disk. Two configurations on disk is normal (develop here, deploy
 * there), so in that case we ask rather than guess — and in a headless run we
 * refuse, because guessing would write the wrong file.
 */
async function resolveTarget(root: string, opts: CliOptions, interactive: boolean): Promise<ConfigTarget> {
  if (opts.target !== undefined) return opts.target

  const onDisk = existingTargets(root)
  if (onDisk.length === 1) return onDisk[0]
  if (onDisk.length === 0) return 'dev'

  if (!interactive) {
    throw new WizardError(
      `both configurations exist (${onDisk.join(' and ')}) — say which one this run owns:\n` +
        '  ./scripts/bootstrap.sh --target dev      # server/.dev.vars + delivery/.dev.vars\n' +
        '  ./scripts/bootstrap.sh --target deploy   # root .env (Docker Compose)',
    )
  }
  note(
    'Both configurations exist. They are different installations, and each run\n' +
      'touches exactly one of them — the other is left untouched.',
    'Which configuration?',
  )
  return askSelect<ConfigTarget>(
    'Which configuration does this run own?',
    [
      {
        value: 'dev',
        label: 'dev — server/.dev.vars + delivery/.dev.vars',
        hint: 'running the API here, or deploying it as a Cloudflare Worker',
      },
      {
        value: 'deploy',
        label: 'deploy — the root .env',
        hint: 'the Docker Compose stack on a server',
      },
    ],
    'dev',
  )
}

/**
 * Run the deploy phase and report what actually happened.
 *
 * One rule: a requested deployment that did not finish exits nonzero. "Some of
 * it worked" printed in a friendly tone is how a half-deployed installation
 * gets mistaken for a finished one.
 */
async function deployAndReport(root: string, answers: WizardAnswers): Promise<void> {
  // Report what this deployment needs before starting it: a missing Docker or
  // Python is far cheaper to hear about now than three steps in.
  const preflight = await runPreflight({
    root,
    shape: systemShapeFromAnswers(answers),
    mode: 'deploy',
    reportOnly: true,
  })
  if (preflight.blockers.length > 0) {
    throw new WizardError(
      'the deploy phase cannot run yet — missing:\n  - ' +
        preflight.blockers.map((status) => status.requirement.label).join('\n  - '),
    )
  }

  logStep('Provision & deploy phase')
  const report = await runDeployPhase(root, answers)
  note(deployReportLines(report).join('\n'), 'Deploy report')
  if (report.complete) {
    logSuccess(deploySummaryLine(report))
    return
  }
  logWarn(deploySummaryLine(report))
  process.exitCode = 1
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

  const interactive = isTty()

  if (opts.checkEnabled) {
    const target = await resolveTarget(root, opts, false)
    const ok = await runCheck(root, target, opts.checkUrl)
    if (!ok) process.exitCode = 1
    return
  }

  if (opts.doctor) {
    const onDisk = existingTargets(root)
    const target = opts.target ?? (onDisk.length === 1 ? onDisk[0] : undefined)
    const env = target === undefined ? undefined : readTargetConfig(root, target)
    if (target !== undefined && env !== undefined) {
      printOk(`Configuration: ${target} (${primaryConfigPath(root, target)})`)
      const report = await runPreflight({
        root,
        shape: systemShapeFromAnswers(deriveAnswersFromConfig(target, env)),
        mode: 'develop',
        reportOnly: true,
      })
      // Readiness check: a required requirement that is missing is a failure,
      // everything else is a report. --doctor must not change the machine, but
      // it does have an opinion about whether this one is ready.
      if (report.blockers.length > 0) {
        logWarn(
          `not ready — missing: ${report.blockers.map((status) => status.requirement.label).join(', ')}`,
        )
        process.exitCode = 1
      }
    } else {
      printOk(
        onDisk.length === 0
          ? 'Configuration: none yet — provider requirements are not selected'
          : `Configuration: both dev and deploy exist — pass --target to check one (${onDisk.join(', ')})`,
      )
      const report = await runPreflight({ root, mode: 'develop', reportOnly: true })
      if (report.detection.family === 'unknown') {
        logWarn('could not detect the OS family — install anything missing by hand')
      }
    }
    return
  }

  if (!interactive) {
    if (opts.answersPath === undefined) {
      // No terminal: pick the target if there is only one, then report. An
      // existing configuration means "nothing to do", not "failure".
      const onDisk = existingTargets(root)
      if (onDisk.length === 1 && !opts.force) {
        const target = opts.target ?? onDisk[0]
        const report = lintTarget(root, target)
        printCheckRows(report.rows)
        const kinds = report.failed ? missingLinkKinds(report.rows) : []
        if (kinds.length > 0) note(linksNote(kinds), 'Where to get what is missing')
        printOk(
          `${primaryConfigPath(root, target)} already exists — nothing changed. ` +
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

  const target = await resolveTarget(root, opts, true)
  const primary = primaryConfigPath(root, target)
  const envExists =
    existsSync(primary) || (target === 'dev' && existsSync(deliveryVarsPath(root)))

  let answers: WizardAnswers
  let deployNow = opts.deploy
  if (!envExists || opts.force) {
    answers = await interactiveConfigure(root, opts, target)
  } else if (opts.deploy) {
    // Explicit flag: deploy with what is already configured, no menu.
    const env = readTargetConfig(root, target)
    if (!env) throw new WizardError(`${primary} is missing — configure first`)
    answers = deriveAnswersFromConfig(target, env)
    logWarn(`Using the existing ${primary} — pass --force to regenerate it first`)
  } else {
    // A second run is a normal thing to do, not an error: show what is already
    // configured and let the user pick what they came for.
    const action = await askExistingAction(root, target)

    if (action === 'exit') {
      outro('Nothing changed')
      return
    }
    if (action === 'reconfigure') {
      answers = await interactiveConfigure(root, opts, target)
    } else {
      const env = readTargetConfig(root, target)
      if (!env) throw new WizardError(`${primary} is missing — configure first`)
      answers = deriveAnswersFromConfig(target, env)
      if (action === 'deploy') {
        logWarn(`Using the existing ${primary} — pass --force to regenerate it first`)
        deployNow = true
      } else {
        // 'verify' and 'next' are read-only: report, then print next steps.
        if (action === 'verify') await runCheck(root, target, undefined)
        note(nextStepsText(answers), 'Next steps')
        outro('Done')
        return
      }
    }
  }

  if (deployNow) {
    await deployAndReport(root, answers)
  } else if (!envExists || opts.force) {
    note(linksNote(['modal']), 'Transcoding runs on Modal')
    const choice = await askSelect<'later' | 'deploy'>(
      'Provision and deploy to Cloudflare + Modal now?',
      [
        {
          value: 'later',
          label: 'Not now — finish the local environment (recommended first run)',
          hint: `re-run anytime with: ./scripts/bootstrap.sh --deploy${targetFlag(target)}`,
        },
        {
          value: 'deploy',
          label: 'Yes — Cloudflare login, R2 buckets, Modal pipeline, worker deploys',
          hint: 'longer; needs a Cloudflare account (and Modal when the provider is Modal)',
        },
      ],
      'later',
    )
    if (choice === 'deploy') {
      await deployAndReport(root, answers)
    }
  }

  const report = lintTarget(root, target)
  note(report.rows.map(formatCheckRow).join('\n'), 'Environment check')
  if (report.failed) {
    logWarn('Some keys are still missing — see rows above, or re-run the wizard')
    const kinds = missingLinkKinds(report.rows)
    if (kinds.length > 0) note(linksNote(kinds), 'Where to get what is missing')
  } else {
    logSuccess('Environment looks configured')
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
