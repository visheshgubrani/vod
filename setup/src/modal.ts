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
import { parseModalUrl } from './parsers'
import { findOnPath, runCapture, runInherit } from './runners'
import { logStep, logWarn } from './ui'

/** Repo-relative dir of the Modal pipeline (a python dir, not a pnpm pkg). */
const TRANSCODING = 'transcoding'

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

/** Heuristic auth check: profile + token list both answer positively. */
export async function modalAuthed(bin: string): Promise<boolean> {
  const profile = await runCapture([bin, 'profile', 'current'], { timeoutMs: 60_000 })
  if (profile.code !== 0) return false
  const tokens = await runCapture([bin, 'token', 'list'], { timeoutMs: 60_000 })
  return tokens.code === 0 && tokens.stdout.trim() !== ''
}

/** Run the interactive `modal setup` flow (prints its own sign-in URL). */
export async function runModalSetup(bin: string): Promise<void> {
  logStep('Running modal setup — approve it in your browser when it opens')
  const code = await runInherit([bin, 'setup'])
  if (code !== 0) {
    logWarn(`modal setup did not complete (exit ${String(code)}) — run it yourself: modal setup`)
  }
}

/** Create (or replace) a Modal secret from a plain key/value object. */
export async function putModalSecret(
  bin: string,
  name: string,
  values: Record<string, string>,
): Promise<void> {
  await runCapture([bin, 'secret', 'delete', name, '-y'], { timeoutMs: 60_000 })
  const args = ['secret', 'create', name]
  for (const [key, value] of Object.entries(values)) args.push(`${key}=${value}`)
  const result = await runCapture([bin, ...args], { timeoutMs: 120_000 })
  if (result.code !== 0) {
    throw new WizardError(
      `modal secret create "${name}" failed: ${result.stderr.trim()}\n` +
        `Re-run with: modal secret create ${name} KEY=value …`,
    )
  }
}

/**
 * Deploy the GPU pipeline. Long (first image build takes minutes), so output
 * streams live. Returns the parsed modal.run URL (null when unparseable).
 */
export async function deployModalPipeline(
  root: string,
  bin: string,
): Promise<string | null> {
  logStep('Deploying the Modal pipeline (first image build can take several minutes)…')
  const result = await runCapture([bin, 'deploy', 'main.py'], {
    cwd: join(root, TRANSCODING),
    timeoutMs: 0,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  })
  if (result.code !== 0) {
    throw new WizardError(
      `modal deploy failed — re-run with: cd transcoding && ${bin} deploy main.py\n${result.stderr.trim()}`,
    )
  }
  return parseModalUrl(result.stdout + result.stderr)
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
