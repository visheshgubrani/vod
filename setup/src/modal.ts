/**
 * Modal operations: CLI install (existing binary → uv tool → pipx → a
 * private venv, which sidesteps PEP 668 "externally-managed" pip errors),
 * auth preflight, secrets, and `modal deploy main.py`.
 *
 * python3 is only required when no Modal CLI exists yet; the wizard explains
 * exactly what to install when even the venv route fails.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WizardError } from './errors'
import { isModalCliAuthed, parseModalImageId, parseModalProfileName, parseModalSecretNames, parseModalUrl } from './parsers'
import { findOnPath, runCapture, runInherit } from './runners'
import { logInfo, logStep, logWarn, withSpinner } from './ui'

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

/** `modal` inside transcoding/.venv — used for deploy so main.py can import boto3. */
export function transcodingVenvModalBin(root: string): string {
  return join(root, TRANSCODING, '.venv', 'bin', 'modal')
}

/** Local hydrate deps for `modal deploy` / importing main.py (not GPU extras). */
export function transcodingDeployRequirements(root: string): string {
  return join(root, TRANSCODING, 'requirements-deploy.txt')
}

/** Absolute path to a usable `modal` binary, or null. */
export async function findModalBin(): Promise<string | null> {
  const onPath = findOnPath('modal')
  if (onPath) return onPath
  for (const candidate of [
    join(homedir(), '.local', 'bin', 'modal'),
    join(homedir(), '.local', 'share', 'openvod', 'modal-venv', 'bin', 'modal'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function modalVersionOk(bin: string): Promise<boolean> {
  const result = await runCapture([bin, '--version'], { timeoutMs: 30_000 })
  return result.code === 0
}

/**
 * Ensure transcoding/.venv has the local hydrate deps (boto3, fastapi, modal).
 * `uv tool` / pipx Modal is isolated and cannot import main.py otherwise.
 */
export async function ensureTranscodingDeployEnv(root: string): Promise<string> {
  const venvDir = join(root, TRANSCODING, '.venv')
  const venvPython = join(venvDir, 'bin', 'python')
  const modalBin = transcodingVenvModalBin(root)
  const requirements = transcodingDeployRequirements(root)

  const python = findOnPath('python3')
  if (!python) {
    throw new WizardError(
      'python3 is missing — needed to create transcoding/.venv for modal deploy.\n' +
        'Install python3, then re-run, or: cd transcoding && python3 -m venv .venv && .venv/bin/pip install -r requirements-deploy.txt',
    )
  }

  if (!existsSync(venvPython)) {
    const venvOk = await runCapture([python, '-m', 'venv', venvDir], { timeoutMs: 120_000 })
    if (venvOk.code !== 0) {
      throw new WizardError(
        `could not create transcoding/.venv: ${venvOk.stderr.trim()}\n` +
          'Create it yourself: cd transcoding && python3 -m venv .venv',
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

  if (!(await modalVersionOk(modalBin))) {
    throw new WizardError(
      `modal binary at ${modalBin} does not run — install Modal into transcoding/.venv and re-run`,
    )
  }
  return modalBin
}

/**
 * Install the Modal CLI when missing, trying uv tool → pipx → private venv.
 * Returns the bin path. Throws WizardError with manual instructions when
 * nothing works or python3 is unavailable.
 */
export async function installModalCli(): Promise<string> {
  // 1. uv (fast, isolated)
  if (findOnPath('uv')) {
    const result = await runCapture(['uv', 'tool', 'install', 'modal'], { timeoutMs: 600_000 })
    if (result.code === 0) {
      const bin = await findModalBin()
      if (bin) return bin
    }
  }
  // 2. pipx
  if (findOnPath('pipx')) {
    const result = await runCapture(['pipx', 'install', 'modal'], { timeoutMs: 600_000 })
    if (result.code === 0) {
      const bin = await findModalBin()
      if (bin) return bin
    }
  }
  // 3. private venv (works on externally-managed distros)
  const python = findOnPath('python3')
  if (!python) {
    throw new WizardError(
      'Modal CLI is not installed and python3 is missing.\n' +
        'Install it any way you like, e.g. brew install python, then re-run;\n' +
        'or run yourself: pipx install modal  (or: pip install modal && modal setup)',
    )
  }
  const venvDir = join(homedir(), '.local', 'share', 'openvod', 'modal-venv')
  const venvOk = await runCapture([python, '-m', 'venv', venvDir], { timeoutMs: 120_000 })
  if (venvOk.code !== 0) {
    throw new WizardError(
      `could not create a python venv at ${venvDir}: ${venvOk.stderr.trim()}\n` +
        'Install the Modal CLI yourself (pipx install modal) and re-run.',
    )
  }
  const pip = join(venvDir, 'bin', 'pip')
  const pipResult = await runCapture([pip, 'install', '-q', 'modal'], { timeoutMs: 600_000 })
  if (pipResult.code !== 0) {
    throw new WizardError(
      `pip install modal failed: ${pipResult.stderr.trim()}\n` +
        'Install the Modal CLI yourself (pipx install modal) and re-run.',
    )
  }
  const bin = join(venvDir, 'bin', 'modal')
  if (!(await modalVersionOk(bin))) {
    throw new WizardError(`modal binary at ${bin} does not run — install Modal CLI and re-run`)
  }
  return bin
}

export interface ModalAuthStatus {
  authed: boolean
  profile: string | null
}

/** Auth check: current CLI `token info`; older CLIs fall back to `profile current`. */
export async function modalAuthed(bin: string): Promise<ModalAuthStatus> {
  const tokenInfo = await runCapture([bin, 'token', 'info'], { timeoutMs: 60_000 })
  const profile = await runCapture([bin, 'profile', 'current'], { timeoutMs: 60_000 })
  return {
    authed: isModalCliAuthed({
      tokenInfo: { code: tokenInfo.code },
      profileCurrent: { code: profile.code, stdout: profile.stdout },
    }),
    profile: parseModalProfileName(profile.stdout),
  }
}

/** Run the interactive `modal setup` flow (prints its own sign-in URL). */
export async function runModalSetup(bin: string): Promise<boolean> {
  logStep('Running modal setup — approve it in your browser when it opens')
  const code = await runInherit([bin, 'setup'])
  if (code !== 0) {
    logWarn(`modal setup did not complete (exit ${String(code)}) — run it yourself: modal setup`)
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

/** Inline `NAME KEY=value …` form, for Modal CLIs without `--from-json`. */
export function secretCreateValueArgs(
  name: string,
  values: Record<string, string>,
  force: boolean,
): string[] {
  const args = ['secret', 'create']
  if (force) args.push('--force')
  args.push(name)
  for (const [key, value] of Object.entries(values)) args.push(`${key}=${value}`)
  return args
}

/** True when a Modal CLI failure looks like "this version has no --from-json". */
export function modalRejectsFromJson(output: string): boolean {
  const text = (output ?? '').toLowerCase()
  return (
    text.includes('--from-json') ||
    text.includes('no such option') ||
    text.includes('unrecognized option') ||
    text.includes('unexpected extra argument')
  )
}

export interface PutModalSecretOptions {
  force?: boolean
  /** Private temp dir for the 0600 JSON payload. */
  tempDir: string
}

/** Create a Modal secret unless it already exists. Pass force to overwrite. */
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
        let result = await runCapture([bin, ...secretCreateJsonArgs(name, jsonPath, overwrite)], {
          timeoutMs: 120_000,
        })
        if (result.code !== 0 && modalRejectsFromJson(result.stderr + result.stdout)) {
          logInfo(`this Modal CLI does not accept --from-json — retrying with inline values`)
          result = await runCapture([bin, ...secretCreateValueArgs(name, values, overwrite)], {
            timeoutMs: 120_000,
          })
        }
        if (result.code !== 0) {
          throw new WizardError(
            `modal secret create "${name}" failed: ${result.stderr.trim()}\n` +
              `Re-run with: modal secret create ${name} KEY=value …`,
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
 * Uses transcoding/.venv so local imports (boto3, fastapi) resolve; a global
 * uv/pipx `modal` cannot see those packages.
 * Streams Modal output live (a spinner would hide image-build logs).
 * Returns the parsed modal.run URL (null when unparseable).
 */
export async function deployModalPipeline(root: string): Promise<string | null> {
  const bin = await withSpinner(
    'Preparing transcoding/.venv (boto3, fastapi, modal)…',
    () => ensureTranscodingDeployEnv(root),
    'transcoding/.venv ready for modal deploy',
  )
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
