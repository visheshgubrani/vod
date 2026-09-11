/**
 * Modal operations: CLI install (existing binary → uv tool → pipx → a
 * private venv, which sidesteps PEP 668 "externally-managed" pip errors),
 * auth preflight, secrets, and `modal deploy main.py`.
 *
 * python3 is only required when no Modal CLI exists yet; the wizard explains
 * exactly what to install when even the venv route fails.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WizardError } from './errors'
import { isModalCliAuthed, parseModalImageId, parseModalProfileName, parseModalSecretNames, parseModalUrl } from './parsers'
import { findOnPath, runCapture, runInherit } from './runners'
import { logInfo, logStep, logWarn, withSpinner } from './ui'

/** Repo-relative dir of the Modal pipeline (a python dir, not a pnpm pkg). */
const TRANSCODING = 'transcoding'

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

async function listModalSecretNames(bin: string): Promise<string[]> {
  const json = await runCapture([bin, 'secret', 'list', '--json'], { timeoutMs: 60_000 })
  if (json.code === 0) return parseModalSecretNames(json.stdout + json.stderr)
  const table = await runCapture([bin, 'secret', 'list'], { timeoutMs: 60_000 })
  return parseModalSecretNames(table.stdout + table.stderr)
}

function secretCreateArgs(
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

/** Create a Modal secret unless it already exists. Pass force to overwrite. */
export async function putModalSecret(
  bin: string,
  name: string,
  values: Record<string, string>,
  options: { force?: boolean } = {},
): Promise<void> {
  const force = options.force === true
  if (!force) {
    const existing = await listModalSecretNames(bin)
    if (existing.includes(name)) {
      logInfo(`Modal secret ${name} already exists — leaving in place`)
      return
    }
  }
  await withSpinner(
    `Creating Modal secret ${name}…`,
    async () => {
      const result = await runCapture([bin, ...secretCreateArgs(name, values, force)], {
        timeoutMs: 120_000,
      })
      if (result.code !== 0) {
        throw new WizardError(
          `modal secret create "${name}" failed: ${result.stderr.trim()}\n` +
            `Re-run with: modal secret create ${name} KEY=value …`,
        )
      }
    },
    `Modal secret ${name} ready`,
  )
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

/** Modal r2-creds payload shared by the API and the Modal GPU function. */
export function r2CredsValues(opts: {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  transcodedBucket: string
  rawBucket: string
  ingestSecret: string
  callbackHosts: string
}): Record<string, string> {
  return {
    R2_ACCOUNT_ID: opts.accountId,
    R2_ACCESS_KEY_ID: opts.accessKeyId,
    R2_SECRET_ACCESS_KEY: opts.secretAccessKey,
    R2_BUCKET_NAME: opts.transcodedBucket,
    TRANSCODE_INGEST_SECRET: opts.ingestSecret,
    ALLOWED_SOURCE_BUCKETS: opts.rawBucket,
    ALLOWED_CALLBACK_HOSTS: opts.callbackHosts,
  }
}
