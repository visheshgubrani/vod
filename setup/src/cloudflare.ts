/**
 * Cloudflare operations (wrangler, project-pinned local devDependency).
 * Every step is idempotent: preflight before acting, tolerate "already
 * exists", and throw WizardError with an actionable message otherwise.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WizardError } from './errors'
import { parseAccountId, parseWorkersUrl } from './parsers'
import { patchBucketName } from './cfgpatch'
import { pkgCapture, pkgInherit, runCapture } from './runners'
import { logStep, logWarn } from './ui'

const SERVER = 'server'
const DELIVERY = 'delivery'

export interface TempDir {
  path: string
  cleanup: () => void
}

/** Create a private temp dir for secret bulk JSON / CORS files. */
export function makeTempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), 'openvod-setup-'))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

function trimTail(text: string | undefined, max = 600): string {
  const value = (text ?? '').trim()
  return value.length > max ? `${value.slice(-max)}…` : value
}

/** Parse the account id from `wrangler whoami`, or null when not logged in. */
export async function cfAccountId(root: string): Promise<string | null> {
  const result = await pkgCapture(root, SERVER, 'wrangler', ['whoami'], { timeoutMs: 90_000 })
  if (result.code !== 0) return null
  const accountId = parseAccountId(result.stdout + result.stderr)
  return accountId
}

/**
 * Ensure a wrangler login. Prints wrangler's own URL (stdio inherited — the
 * user approves in the browser; Ctrl+C cancels cleanly and the whole wizard
 * is resumable). Returns the account id when authenticated afterwards.
 */
export async function ensureCfLogin(root: string): Promise<string | null> {
  const known = await cfAccountId(root)
  if (known) return known

  logStep('Opening wrangler login — approve it in your browser when it opens')
  const code = await pkgInherit(root, SERVER, 'wrangler', ['login'])
  if (code !== 0) {
    logWarn('wrangler login did not complete (exit ' + String(code) + ')')
    return null
  }
  return cfAccountId(root)
}

async function bucketExistsMessage(output: string): Promise<boolean> {
  const text = (output ?? '').toLowerCase()
  return text.includes('already exists') || text.includes('duplicate') || text.includes('409')
}

export async function ensureBucket(root: string, name: string): Promise<void> {
  const result = await pkgCapture(root, SERVER, 'wrangler', ['r2', 'bucket', 'create', name], {
    timeoutMs: 120_000,
  })
  if (result.code === 0) return
  if (await bucketExistsMessage(result.stdout + result.stderr)) return
  throw new WizardError(
    `failed to create R2 bucket "${name}": ${trimTail(result.stderr || result.stdout)}`,
  )
}

/** Apply the S3 CORS policy the raw bucket needs for browser uploads. */
export async function applyBucketCors(
  root: string,
  bucket: string,
  origins: string[],
  temp: TempDir,
): Promise<void> {
  const corsPath = join(temp.path, 'cors.json')
  const rule = {
    rules: [
      {
        allowed: {
          origins: origins.length > 0 ? origins : ['http://localhost:3000'],
          methods: ['GET', 'PUT', 'HEAD'],
          headers: ['*'],
        },
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 3600,
      },
    ],
  }
  writeFileSync(corsPath, JSON.stringify(rule, null, 2), { encoding: 'utf8', mode: 0o600 })

  const args = ['r2', 'bucket', 'cors', 'set', bucket, '--file', corsPath]
  let result = await pkgCapture(root, SERVER, 'wrangler', [...args, '--force'], {
    timeoutMs: 120_000,
  })
  if (result.code !== 0) {
    result = await pkgCapture(root, SERVER, 'wrangler', args, { timeoutMs: 120_000 })
  }
  if (result.code !== 0) {
    throw new WizardError(
      `could not apply CORS to "${bucket}" — add the policy manually (docs/deploy.md): ${trimTail(
        result.stderr || result.stdout,
      )}`,
    )
  }
}

/** Point delivery/wrangler.jsonc at the user's transcoded bucket. */
export function patchDeliveryBucket(root: string, bucket: string): boolean {
  const path = join(root, DELIVERY, 'wrangler.jsonc')
  const text = readFileSync(path, 'utf8')
  const updated = patchBucketName(text, bucket)
  if (updated === null) {
    throw new WizardError(`could not find "bucket_name" to patch in ${path}`)
  }
  if (updated === text) return false
  writeFileSync(path, updated, { encoding: 'utf8' })
  return true
}

/**
 * Deploy a worker package, streaming output live. Returns the parsed
 * workers.dev URL (null when none was printed — custom domains print none).
 */
export async function deployWorker(
  root: string,
  pkg: 'server' | 'delivery',
): Promise<string | null> {
  logStep(`Deploying ${pkg} worker (pnpm exec wrangler deploy)…`)
  const result = await pkgCapture(root, pkg, 'wrangler', ['deploy'], { timeoutMs: 0 })
  if (result.code !== 0) {
    throw new WizardError(
      `wrangler deploy (${pkg}) failed — re-run with: cd ${pkg} && pnpm exec wrangler deploy\n${trimTail(
        result.stderr || result.stdout,
      )}`,
    )
  }
  return parseWorkersUrl(result.stdout + result.stderr)
}

/**
 * Upload secrets with `wrangler secret bulk`. Empty values are skipped
 * (config treats them as unset). The JSON file lives in the private temp dir
 * and is removed when the run finishes.
 */
export async function putWorkerSecrets(
  root: string,
  pkg: 'server' | 'delivery',
  entries: readonly (readonly [string, string])[],
  temp: TempDir,
): Promise<void> {
  const wanted = Object.fromEntries(entries.filter(([, value]) => value.trim() !== ''))
  if (Object.keys(wanted).length === 0) return
  const file = join(temp.path, `${pkg}-secrets.json`)
  writeFileSync(file, JSON.stringify(wanted), { encoding: 'utf8', mode: 0o600 })
  try {
    const result = await pkgCapture(root, pkg, 'wrangler', ['secret', 'bulk', file], {
      timeoutMs: 180_000,
    })
    if (result.code !== 0) {
      throw new WizardError(
        `could not upload secrets to the ${pkg} worker — re-run with: cd ${pkg} && pnpm exec wrangler secret bulk …\n${trimTail(
          result.stderr || result.stdout,
        )}`,
      )
    }
  } finally {
    try {
      unlinkSync(file)
    } catch {
      // temp dir cleanup covers it
    }
  }
}

/** Push the drizzle schema against DATABASE_URL (never printed). */
export async function dbPush(root: string, databaseUrl: string): Promise<void> {
  logStep('Pushing the database schema (pnpm db:push)…')
  const result = await runCapture(['pnpm', 'db:push'], {
    cwd: root,
    env: { DATABASE_URL: databaseUrl },
    timeoutMs: 0,
    onStderr: (chunk) => process.stderr.write(chunk),
    onStdout: (chunk) => process.stdout.write(chunk),
  })
  if (result.code !== 0) {
    throw new WizardError(
      'db:push failed — once DATABASE_URL is reachable, re-run: pnpm db:push',
    )
  }
}
