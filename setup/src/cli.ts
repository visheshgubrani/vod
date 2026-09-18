#!/usr/bin/env tsx
/**
 * ClipMux bootstrap wizard entrypoint (run by scripts/bootstrap.sh after the
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
import {
  DEV_PG_PORT,
  devInfraChoice,
  inspectDevInfra,
  migrateDevDb,
  quickFixFor,
  remediationFor,
  startDevInfra,
  type DevDbVerdict,
} from './devInfra'
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
  logError,
  logInfo,
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
        usageError(
          `--runtime is no longer used. ClipMux v1 always runs the API on Node. ` +
            `Remove --runtime ${value} from the command.`,
        )
        break
      }
      case '--db': {
        const value = next(i, arg)
        if (value === 'neon') {
          usageError(
            '--db neon is no longer a wizard choice. Use --db existing and pass a ' +
              'postgresql:// URL (a Neon connection string is a regular Postgres URL).',
          )
        }
        if (value !== 'local' && value !== 'existing') {
          usageError(`--db must be local|existing, got ${value}`)
        }
        options.prefill.dbKind = value as DbKind
        i += 1
        break
      }
      case '--analytics': {
        const value = next(i, arg)
        if (value !== 'on' && value !== 'off') {
          usageError(`--analytics must be on|off, got ${value}`)
        }
        options.prefill.analyticsEnabled = value === 'on'
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
        'could not find pnpm-workspace.yaml — run the wizard from inside the ClipMux repo clone',
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
  const rawObj = raw as Record<string, unknown>
  if (rawObj.runtime === 'workers') {
    throw new WizardError(
      'runtime "workers" is no longer supported. ClipMux v1 runs the API on Node. ' +
        'Remove "runtime" from the answers file.',
    )
  }
  const rawDb = (rawObj.db ?? null) as { kind?: unknown } | null
  const dbKind = typeof rawDb?.kind === 'string' ? rawDb.kind : undefined
  const answers = raw as Partial<WizardAnswers>
  const queueKind = answers.queue?.kind
  const rateKind = answers.rateLimit?.kind
  const target = answers.target
  if (target !== undefined && target !== 'dev' && target !== 'deploy') {
    throw new WizardError('answers target must be "dev" or "deploy"')
  }
  if (dbKind === 'neon') {
    throw new WizardError(
      'db.kind "neon" is no longer a wizard choice. Use db.kind "existing" with your ' +
        'Postgres URL — a Neon connection string is a regular postgresql:// URL.',
    )
  }
  if (dbKind !== 'local' && dbKind !== 'existing') {
    throw new WizardError('answers db.kind must be "local" or "existing"')
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
    ...(answers.analyticsEnabled !== undefined
      ? { analyticsEnabled: answers.analyticsEnabled !== false }
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

/** One plain-text line describing a dev-database verdict, for a log or a row. */
export function describeDevDb(verdict: DevDbVerdict): string {
  switch (verdict.kind) {
    case 'reachable':
      return `dev Postgres is reachable on localhost:${DEV_PG_PORT}`
    case 'not-running':
      return `dev Postgres is not running (localhost:${DEV_PG_PORT})`
    case 'unreachable':
      return `dev Postgres is running but localhost:${DEV_PG_PORT} does not answer`
    case 'container-not-attached':
      return verdict.owner === null
        ? 'dev Postgres is running but Docker never attached it to a network'
        : `dev Postgres is running but Docker never attached it — port ${DEV_PG_PORT} is held by ${verdict.owner.name}`
    case 'port-held-elsewhere':
      return verdict.owner === null
        ? `another server answers localhost:${DEV_PG_PORT}`
        : `port ${DEV_PG_PORT} is held by ${verdict.owner.name}${verdict.owner.project === null ? '' : ` (project "${verdict.owner.project}")`}`
  }
}

/**
 * Start the local infrastructure and migrate, when the user says yes.
 *
 * The wizard used to end at "next steps: run these two commands", which is how a
 * dev target ended up configured against a Postgres that was never startable
 * (another project holding port 5433) and a schema that was never created. The
 * order is the point: identify a blocker *before* starting, because
 * `docker compose up --wait` reports success for a container it could not attach
 * to the network, and verify *after* starting rather than trusting the exit code.
 */
async function maybeStartDevInfra(root: string, answers: WizardAnswers): Promise<void> {
  if (!devInfraChoice(answers)) return

  const label = 'Start the dev Postgres + Redis now and apply migrations?'
  if (!(await askConfirm(label, true))) {
    logInfo(
      'start it yourself, then migrate:  pnpm dev:infra && pnpm db:migrate\n' +
        'the wizard re-checks this on the next run',
    )
    return
  }

  const before = await inspectDevInfra(root)
  if (before.verdict.kind === 'container-not-attached' || before.verdict.kind === 'port-held-elsewhere') {
    logWarn(describeDevDb(before.verdict))
    note(remediationFor(before.verdict).join('\n'), `Port ${DEV_PG_PORT} is not available`)
    return
  }

  logStep('Starting the dev containers (docker compose -f docker-compose.dev.yml up -d --wait)')
  const started = await startDevInfra(root)
  if (!started.ok) {
    if (started.portAllocated) {
      const owners = (await inspectDevInfra(root)).owners
      const who = owners.length > 0 ? ` by ${owners.map((o) => o.name).join(', ')}` : ''
      logWarn(`port ${DEV_PG_PORT} is already allocated${who}`)
    } else {
      logWarn(`docker compose up failed — ${started.output.split(/\r?\n/).slice(-3).join(' ')}`)
    }
    logInfo(`check it yourself with:  docker compose -f docker-compose.dev.yml up -d`)
  }

  // Always re-read the machine after starting: "it exited zero" and "the host can
  // reach the database" are different claims, and only the second one matters.
  const status = await inspectDevInfra(root)
  if (status.verdict.kind !== 'reachable') {
    logWarn(describeDevDb(status.verdict))
    note(remediationFor(status.verdict).join('\n'), 'The dev Postgres is not usable yet')
    logInfo('the configuration was still written — fix the database, then:  pnpm db:migrate')
    return
  }

  logSuccess('dev Postgres + Redis are up')
  logStep('Applying migrations (pnpm db:migrate)')
  if (await migrateDevDb(root)) {
    logSuccess('migrations applied')
  } else {
    logError('migrations failed — run `pnpm db:migrate` once the database is reachable')
  }
}

/**
 * The dev database as a verification row.
 *
 * `lintServerEnv` can only see that DATABASE_URL *looks* like a Postgres URL, so
 * a machine where port 5433 belongs to another project's server passed every
 * check and failed at the first query. This is the missing question. Returns
 * null when the chosen database is not this workspace's local container.
 */
async function localDatabaseRow(
  root: string,
  target: ConfigTarget,
): Promise<{ row: CheckRow; verdict: DevDbVerdict } | null> {
  if (target !== 'dev') return null
  const env = readTargetConfig(root, 'dev')
  if (!env || deriveAnswersFromConfig('dev', env).db.kind !== 'local') return null
  const status = await inspectDevInfra(root)
  const verdict = status.verdict
  return {
    row: {
      ok: verdict.kind === 'reachable',
      text: describeDevDb(verdict),
      // The generic "missing or placeholder" suffix is wrong for a database that
      // is configured and still unreachable, so this row carries its own.
      ...(verdict.kind === 'reachable' ? {} : { hint: quickFixFor(verdict) }),
    },
    verdict,
  }
}

async function runCheck(
  root: string,
  target: ConfigTarget,
  checkUrl: string | undefined,
): Promise<boolean> {
  const { rows, failed } = lintTarget(root, target)
  const db = await localDatabaseRow(root, target)
  if (db !== null) rows.push(db.row)
  if (db !== null && !db.row.ok) {
    // Before the rows, so the one failure the env rows cannot see gets the
    // explanation and the fix rather than a bare ✗ at the bottom of a list.
    logWarn(describeDevDb(db.verdict))
    note(remediationFor(db.verdict).join('\n'), 'The dev Postgres is not usable')
  }
  const dbFailed = db !== null && !db.row.ok
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
      return Boolean(body.ready) && !dbFailed
    } catch {
      // eslint-disable-next-line no-console
      console.log(color.fail(`✗ could not reach ${base}/health/config`))
      return false
    }
  }
  return !failed && !dbFailed
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
          delivery: buildDeliveryEntries(secrets, answers),
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
        if (action === 'next' && target === 'dev') await runCheck(root, target, undefined)
        note(nextStepsText(answers), 'Next steps')
        outro('Done')
        return
      }
    }
  }

  if (target === 'dev' && !deployNow) {
    // The dev target is the one that needs containers on this machine, and the
    // one whose setup used to end in two commands the user had to remember.
    // Before the deploy question, not after: the local environment is what
    // `pnpm dev` needs, and it is the option the wizard recommends first.
    await maybeStartDevInfra(root, answers)
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
