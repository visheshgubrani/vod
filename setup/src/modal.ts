/**
 * Modal operations: preparing the deploy environment, auth preflight, secrets,
 * and `modal deploy main.py`.
 *
 * There is exactly ONE Modal CLI in this flow: `transcoding/.venv/bin/modal`,
 * prepared from `requirements-deploy.txt` (which pins `modal>=1.5.0`). Login,
 * secret writes and deploy all go through that same binary — a global uv/pipx
 * `modal` used for login and the venv's used for deploy were two environments
 * sharing one token file, so a profile, a `MODAL_CONFIG_PATH` or a version
 * difference between them surfaced as "authenticated a moment ago, cannot
 * authenticate now". uv is preferred for building it because uv can provision
 * its own interpreter, which makes the Modal path work with no system python3.
 *
 * Nothing here is fatal to a deployment on its own: the caller catches, records
 * the step as skipped, and carries on with the provider-independent steps.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WizardError } from './errors'
import {
  MODAL_MIN_VERSION,
  modalAuthState,
  parseModalClientVersion,
  parseModalImageId,
  parseModalSecretNames,
  parseModalUrl,
  parseModalWorkspace,
  versionAtLeast,
  type ModalAuthState,
} from './parsers'
import { providerLink } from './links'
import { findOnPath, runCapture, runInherit } from './runners'
import { askSelect, logInfo, logStep, logSuccess, logWarn, withSpinner } from './ui'

/** Repo-relative dir of the Modal pipeline (a python dir, not a pnpm pkg). */
const TRANSCODING = 'transcoding'

/**
 * The Modal secret the GPU pipeline reads its credentials from.
 *
 * Named after the product so it is obvious in a shared Modal workspace which
 * app owns it. `transcoding/main.py` references this exact string, and
 * `LEGACY_MODAL_SECRETS` is what the deploy phase offers to clean up.
 */
export const MODAL_CREDS_SECRET = 'openvod-creds'

/** The Groq key lives in its own secret: it is optional and must not be clobbered. */
export const MODAL_GROQ_SECRET = 'openvod-groq-creds'

/** Pre-rename secret names, offered for deletion so a workspace has one set. */
export const LEGACY_MODAL_SECRETS: readonly string[] = ['r2-creds', 'groq-creds']

/** `modal` inside transcoding/.venv — the only Modal CLI this wizard drives. */
export function transcodingVenvModalBin(root: string): string {
  return join(root, TRANSCODING, '.venv', 'bin', 'modal')
}

/** Local hydrate deps for `modal deploy` / importing main.py (not GPU extras). */
export function transcodingDeployRequirements(root: string): string {
  return join(root, TRANSCODING, 'requirements-deploy.txt')
}

/** `modal --version` inside the prepared venv, or null when it does not run. */
async function modalClientVersion(bin: string): Promise<string | null> {
  const result = await runCapture([bin, '--version'], { timeoutMs: 30_000 })
  if (result.code !== 0) return null
  return parseModalClientVersion(result.stdout + result.stderr)
}

/**
 * Ensure transcoding/.venv has the local hydrate deps (boto3, fastapi, modal)
 * and return the `modal` binary inside it.
 *
 * uv first (it can fetch its own Python), then a system `python3 -m venv`.
 * A venv that exists but does not carry a supported Modal CLI is an error the
 * caller reports with the one command that fixes it, not a silent fallback to
 * some other `modal` on PATH.
 */
export async function ensureTranscodingDeployEnv(root: string): Promise<string> {
  const venvDir = join(root, TRANSCODING, '.venv')
  const venvPython = join(venvDir, 'bin', 'python')
  const modalBin = transcodingVenvModalBin(root)
  const requirements = transcodingDeployRequirements(root)

  const uv = findOnPath('uv')
  if (uv !== null) {
    for (const args of [
      [uv, 'venv', '--allow-existing', venvDir],
      [uv, 'venv', venvDir],
    ]) {
      const created = await runCapture(args, { timeoutMs: 300_000 })
      if (created.code !== 0) continue
      const installed = await runCapture(
        [uv, 'pip', 'install', '--python', venvPython, '-q', '-r', requirements],
        { timeoutMs: 600_000 },
      )
      if (installed.code === 0) break
    }
  }

  if (!existsSync(venvPython)) {
    const python = findOnPath('python3')
    if (!python) {
      throw new WizardError(
        'neither uv nor python3 is available to build transcoding/.venv for modal deploy.\n' +
          'Install one of them and re-run, or deploy the pipeline yourself:\n' +
          '  cd transcoding && python3 -m venv .venv && .venv/bin/pip install -r requirements-deploy.txt',
      )
    }
    const venvOk = await runCapture([python, '-m', 'venv', venvDir], { timeoutMs: 120_000 })
    if (venvOk.code !== 0) {
      throw new WizardError(
        `could not create transcoding/.venv: ${venvOk.stderr.trim()}\n` +
          'Create it yourself: cd transcoding && python3 -m venv .venv\n' +
          '(on Debian/Ubuntu the python3-venv package provides this)',
      )
    }
  }

  const pip = join(venvDir, 'bin', 'pip')
  const pipResult = await runCapture([pip, 'install', '-q', '-r', requirements], {
    timeoutMs: 600_000,
  })
  if (pipResult.code !== 0) {
    throw new WizardError(
      `pip install -r transcoding/requirements-deploy.txt failed: ${pipResult.stderr.trim()}\n` +
        `Re-run with: ${venvPython} -m pip install -r ${requirements}`,
    )
  }

  const version = await modalClientVersion(modalBin)
  if (version === null) {
    throw new WizardError(
      `the modal binary at ${modalBin} does not run — reset the environment and re-run:\n` +
        `  rm -rf transcoding/.venv && cd transcoding && python3 -m venv .venv && .venv/bin/pip install -r requirements-deploy.txt`,
    )
  }
  if (!versionAtLeast(version, MODAL_MIN_VERSION)) {
    throw new WizardError(
      `the Modal CLI in transcoding/.venv is ${version}, but this wizard needs >= ${MODAL_MIN_VERSION} ` +
        '(it drives `modal token info`, which older CLIs do not have).\n' +
        `Reset it: rm -rf transcoding/.venv && cd transcoding && python3 -m venv .venv && .venv/bin/pip install -r requirements-deploy.txt`,
    )
  }
  return modalBin
}

/**
 * One line describing a probe outcome, without ever echoing the token.
 *
 * `unverified` is deliberately not phrased as a failure: a timed-out probe is a
 * question, not an answer, and the caller asks the user rather than assuming.
 */
export function describeModalAuth(status: ModalAuthStatus): string {
  const where = status.workspace ? ` (workspace ${status.workspace})` : ''
  switch (status.state) {
    case 'authenticated':
      return `Modal CLI authenticated${where}`
    case 'unauthenticated':
      return 'Modal CLI is not authenticated (no token, or the token was rejected)'
    case 'unverified':
      return 'could not verify the Modal CLI login (the probe timed out or returned something unexpected)'
  }
}

export interface ModalAuthStatus {
  state: ModalAuthState
  /** Workspace the token belongs to, when the CLI reports one. Never the token. */
  workspace: string | null
}

/**
 * Auth preflight, as three distinguishable outcomes.
 *
 * `unverified` is the one that matters: a timed-out or crashed probe used to be
 * indistinguishable from a successful login, which is how a deploy walked into
 * `modal secret create` with no credentials at all.
 */
export async function modalAuthStatusFor(bin: string): Promise<ModalAuthStatus> {
  const result = await runCapture([bin, 'token', 'info'], { timeoutMs: 60_000 })
  const output = result.stdout + result.stderr
  return {
    state: modalAuthState({
      code: result.code,
      output,
      timedOut: result.timedOut,
    }),
    workspace: parseModalWorkspace(result.stdout),
  }
}

/**
 * Browser login: `modal setup` prints its own sign-in URL (and works over SSH
 * by asking you to open the URL yourself).
 */
export async function runModalSetup(bin: string): Promise<boolean> {
  logStep('Running modal setup — approve it in your browser when it opens')
  const code = await runInherit([bin, 'setup'])
  if (code !== 0) {
    logWarn(`modal setup did not complete (exit ${String(code)})`)
    return false
  }
  return true
}

/**
 * Headless login: paste a token id + secret from modal.com/settings/tokens.
 *
 * Deliberately argument-free — `modal token set` prompts for both values, so
 * they never appear in this process's argv (and therefore never in `ps`).
 */
export async function runModalTokenSet(bin: string): Promise<boolean> {
  logStep('Running modal token set — paste the token id and secret when prompted')
  const code = await runInherit([bin, 'token', 'set'])
  if (code !== 0) {
    logWarn(`modal token set did not complete (exit ${String(code)})`)
    return false
  }
  return true
}

export async function listModalSecretNames(bin: string): Promise<string[]> {
  const json = await runCapture([bin, 'secret', 'list', '--json'], { timeoutMs: 60_000 })
  if (json.code === 0) return parseModalSecretNames(json.stdout + json.stderr)
  const table = await runCapture([bin, 'secret', 'list'], { timeoutMs: 60_000 })
  return parseModalSecretNames(table.stdout + table.stderr)
}

/** Which of the pre-rename secret names still exist in this workspace. */
export function legacySecretsPresent(
  existingNames: readonly string[],
  legacy: readonly string[] = LEGACY_MODAL_SECRETS,
): string[] {
  return legacy.filter((name) => existingNames.includes(name))
}

/** Delete a Modal secret by name. */
export async function deleteModalSecret(bin: string, name: string): Promise<boolean> {
  const result = await runCapture(
    [bin, 'secret', 'delete', '--yes', '--allow-missing', name],
    { timeoutMs: 60_000 },
  )
  if (result.code === 0) return true
  // Older CLIs have neither flag; without --yes it still asks, so the plain
  // form is a last resort that may legitimately fail.
  const retry = await runCapture([bin, 'secret', 'delete', name], { timeoutMs: 60_000 })
  return retry.code === 0
}

export type ModalSecretWritePlan = 'create' | 'skip' | 'overwrite'

/**
 * `openvod-creds` is always rewritten from server/.dev.vars: the ingest secret
 * and the bucket/host allowlists cannot be allowed to drift from the API's own
 * environment. `openvod-groq-creds` stays skip-if-exists so a re-run with an
 * empty Groq key cannot overwrite a real key with "unused".
 */
export function forceOverwriteModalSecret(name: string): boolean {
  return name === MODAL_CREDS_SECRET
}

/** Decide create / skip / overwrite from the current secret list and force flag. */
export function modalSecretWritePlan(
  existingNames: readonly string[],
  name: string,
  force: boolean,
): ModalSecretWritePlan {
  if (existingNames.includes(name)) return force ? 'overwrite' : 'skip'
  return 'create'
}

/**
 * `modal secret create --from-json <file>`.
 *
 * Values go through a 0600 file rather than argv so they never appear in the
 * process table (`ps`) — the same reason `wrangler secret bulk` takes a file.
 */
export function secretCreateJsonArgs(
  name: string,
  jsonPath: string,
  force: boolean,
): string[] {
  const args = ['secret', 'create']
  if (force) args.push('--force')
  args.push('--from-json', jsonPath, name)
  return args
}

export interface PutModalSecretOptions {
  force?: boolean
  /** Private temp dir for the 0600 JSON payload. */
  tempDir: string
}

/**
 * Create a Modal secret unless it already exists. Pass force to overwrite.
 *
 * Values go through a 0600 file (`--from-json`) and never through argv: the
 * inline `NAME KEY=value` form would put R2 keys and the ingest secret in the
 * process table, and the venv pins `modal>=1.5.0`, so the flag always exists.
 */
export async function putModalSecret(
  bin: string,
  name: string,
  values: Record<string, string>,
  options: PutModalSecretOptions,
): Promise<void> {
  const force = options.force === true
  const existing = force ? [] : await listModalSecretNames(bin)
  const plan = modalSecretWritePlan(existing, name, force)
  if (plan === 'skip') {
    logInfo(`Modal secret ${name} already exists — leaving in place`)
    return
  }
  const overwrite = plan === 'overwrite' || force
  const jsonPath = join(options.tempDir, `${name}.json`)
  writeFileSync(jsonPath, JSON.stringify(values, null, 2), { encoding: 'utf8', mode: 0o600 })

  try {
    await withSpinner(
      `Creating Modal secret ${name}…`,
      async () => {
        const result = await runCapture([bin, ...secretCreateJsonArgs(name, jsonPath, overwrite)], {
          timeoutMs: 120_000,
        })
        if (result.code !== 0) {
          throw new WizardError(
            `modal secret create "${name}" failed: ${result.stderr.trim()}\n` +
              `Re-run with: ${bin} secret create --from-json <file> ${name}`,
          )
        }
      },
      `Modal secret ${name} ready`,
    )
  } finally {
    try {
      unlinkSync(jsonPath)
    } catch {
      // the temp dir cleanup covers it
    }
  }
}

/**
 * Deploy the GPU pipeline. First image build can take several minutes.
 *
 * `bin` is the already-prepared `transcoding/.venv/bin/modal` — the same binary
 * that authenticated, so the deploy cannot run against a different token file
 * or CLI version than the login did. Streams Modal output live (a spinner would
 * hide image-build logs). Returns the parsed modal.run URL (null when unparseable).
 */
export async function deployModalPipeline(root: string, bin: string): Promise<string | null> {
  logStep('Deploying the Modal pipeline (first image build can take several minutes)…')
  const result = await runCapture([bin, 'deploy', 'main.py'], {
    cwd: join(root, TRANSCODING),
    timeoutMs: 0,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  })
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0) {
    const imageId = parseModalImageId(combined)
    const hint = imageId
      ? `\nSee full logs: ${bin} image logs ${imageId} --all`
      : ''
    throw new WizardError(
      `modal deploy failed — re-run with: cd transcoding && ${bin} deploy main.py${hint}\n${combined.trim().slice(-2000)}`,
    )
  }
  return parseModalUrl(combined)
}

/**
 * `bareHost` below replaced the old `hostOf`/`rawBucketFromServerEnv` pair, and
 * `openvodCredsFromEnv` replaced `r2CredsValues` + `requireTranscodeIngestSecret`:
 * one function now reads every credential value from server/.dev.vars, so there
 * is exactly one place where the Modal secret can be built.
 */

/**
 * The host part of a URL, lowercased and without scheme/port/path.
 *
 * `utils/network.py` compares `urlparse(url).hostname.lower()` against the
 * allowlist, so anything with a port or a scheme in it would never match.
 * Accepts a bare `host.example` too: a tunnel URL pasted without `https://`
 * is a common typo that should still produce a usable allowlist entry.
 */
export function bareHost(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim()
  if (raw === '') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const host = new URL(raw).hostname.toLowerCase()
      if (host !== '') return host
    } catch {
      // fall through to the permissive parse
    }
  }
  const match = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?(?:[/?#]|$)/i.exec(
    raw,
  )
  return match ? match[1].toLowerCase() : null
}

/** Hosts a Modal container can never call back into. */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host)
  )
}

/**
 * `ALLOWED_CALLBACK_HOSTS` for the Modal secret.
 *
 * The API builds callbacks from `BACKEND_URL` (server/src/utils/queue.ts), so
 * that — not BETTER_AUTH_URL — is the host that has to be allowlisted. Loopback
 * is always present: `config.allowed_callback_hosts` treats a missing allowlist
 * as "localhost only", and local development needs it.
 */
export function callbackHostsFromEnv(env: Record<string, string | undefined>): string[] {
  const hosts: string[] = []
  const seen = new Set<string>()
  const push = (host: string | null): void => {
    if (host === null) return
    const key = host.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    hosts.push(key)
  }
  push('localhost')
  push('127.0.0.1')
  push(bareHost(env['BACKEND_URL']))
  return hosts
}

export interface ModalCredsPayload {
  /** Exactly what goes into the `openvod-creds` secret. */
  values: Record<string, string>
  /** Missing required keys — the caller must refuse to upload. */
  problems: string[]
  /** Usable-but-degraded configuration worth saying out loud. */
  advisories: string[]
}

/**
 * Build the `openvod-creds` payload from server/.dev.vars.
 *
 * Reading the env file — rather than the wizard's in-memory answers — is the
 * point: a bucket name or callback host edited by hand must reach Modal, or the
 * transcoder reads from one bucket and writes to another (or silently refuses
 * every callback).
 */
export function openvodCredsFromEnv(
  env: Record<string, string | undefined>,
): ModalCredsPayload {
  const read = (key: string): string => (env[key] ?? '').trim()
  const problems: string[] = []
  const advisories: string[] = []

  for (const [key, label] of [
    ['ACCOUNT_ID', 'Cloudflare account id'],
    ['R2_ACCESS_KEY_ID', 'R2 access key id'],
    ['R2_SECRET_ACCESS_KEY', 'R2 secret access key'],
    ['TRANSCODED_BUCKET_NAME', 'transcoded bucket'],
    ['TRANSCODE_INGEST_SECRET', 'transcode ingest secret'],
  ] as const) {
    if (read(key) === '') problems.push(`${label} (${key}) is missing from server/.dev.vars`)
  }

  const rawBucket = read('RAW_BUCKET_NAME')
  if (rawBucket === '') {
    advisories.push(
      'RAW_BUCKET_NAME is empty — ALLOWED_SOURCE_BUCKETS stays unset, so ingest ' +
        'payloads may reference any bucket under the R2 credentials',
    )
  }

  const backendUrl = read('BACKEND_URL')
  if (backendUrl === '') {
    advisories.push(
      'BACKEND_URL is not set — only localhost callbacks will be allowed, so a ' +
        'Modal worker can never report a finished job back to this API',
    )
  } else if (isLoopbackHost(bareHost(backendUrl))) {
    advisories.push(
      `BACKEND_URL is ${backendUrl} (loopback) — a Modal worker cannot reach it; ` +
        'set it to a tunnel/public URL, or finished jobs will never update their video',
    )
  }

  const values: Record<string, string> = {
    R2_ACCOUNT_ID: read('ACCOUNT_ID'),
    R2_ACCESS_KEY_ID: read('R2_ACCESS_KEY_ID'),
    R2_SECRET_ACCESS_KEY: read('R2_SECRET_ACCESS_KEY'),
    // Outputs: what the worker writes HLS/DASH into.
    R2_BUCKET_NAME: read('TRANSCODED_BUCKET_NAME'),
    TRANSCODE_INGEST_SECRET: read('TRANSCODE_INGEST_SECRET'),
    ALLOWED_CALLBACK_HOSTS: callbackHostsFromEnv(env).join(','),
  }
  // Inputs: which buckets an ingest payload may name. Omitted rather than
  // written empty — an empty secret value is indistinguishable from a missing
  // one at runtime, and the transcoder treats "unset" as "any bucket".
  if (rawBucket !== '') values.ALLOWED_SOURCE_BUCKETS = rawBucket

  return { values, problems, advisories }
}

type ModalLoginChoice = 'browser' | 'tokens' | 'skip'

/**
 * Log in, or decide not to.
 *
 * Both login paths are interactive and run with inherited stdio: `modal setup`
 * prints its own sign-in URL, `modal token set` prompts for the id and secret
 * (argument-free on purpose — a token passed in argv is visible in `ps`).
 * Whatever happens, the probe is repeated afterwards; the result is the only
 * thing that counts as success.
 */
export async function modalLogin(bin: string): Promise<ModalAuthStatus> {
  const link = providerLink('modalTokens')
  const choice = await askSelect<ModalLoginChoice>(
    'How would you like to log in to Modal?',
    [
      {
        value: 'browser',
        label: 'Open the browser — modal setup',
        hint: 'creates or selects a token for this machine',
      },
      {
        value: 'tokens',
        label: 'Paste a token id + secret — modal token set',
        hint: `${link.label} — ${link.url}`,
      },
      {
        value: 'skip',
        label: 'Skip Modal — finish the deployment later',
        hint: 'nothing is uploaded',
      },
    ],
    'browser',
  )

  if (choice === 'browser') await runModalSetup(bin)
  else if (choice === 'tokens') await runModalTokenSet(bin)
  else return { state: 'unauthenticated', workspace: null }

  return modalAuthStatusFor(bin)
}

/**
 * Prepare the Modal environment and get an authenticated CLI, or explain why
 * the Modal steps are being skipped.
 *
 * Returns null when Modal cannot be used — never throws, because a Modal
 * problem must not stop the delivery worker, the API or the migrations.
 */
export async function prepareModalEnvironment(root: string): Promise<string | null> {
  let bin: string
  try {
    bin = await withSpinner(
      'Preparing transcoding/.venv (boto3, fastapi, modal)…',
      () => ensureTranscodingDeployEnv(root),
      'transcoding/.venv ready for modal deploy',
    )
  } catch (error) {
    logWarn(
      `could not prepare the Modal environment: ${error instanceof Error ? error.message : String(error)}`,
    )
    logInfo('Skipping Modal — deploy the pipeline yourself: see docs/deploy.md')
    return null
  }

  const status = await modalAuthStatusFor(bin)
  if (status.state === 'authenticated') {
    logSuccess(describeModalAuth(status))
    return bin
  }

  logWarn(describeModalAuth(status))
  const retried = await modalLogin(bin)
  if (retried.state === 'authenticated') {
    logSuccess(describeModalAuth(retried))
    return bin
  }

  logWarn(`${describeModalAuth(retried)} — skipping the Modal steps`)
  logInfo(`Finish later with: ./scripts/bootstrap.sh --deploy  (or: ${bin} setup)`)
  return null
}
