/**
 * Filesystem helpers for the .dev.vars pair. All writes are mode 0600 and
 * never print values. Regeneration (--force) preserves keys the wizard does
 * not own (OAuth clients, sweeper tuning, …); deploy-phase upserts edit the
 * file in place without touching anything else.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EnvFileExistsError, parseEntriesAsMap, renderEnvFile, upsertEnvText } from './envfile'
import { deliveryKeySet, serverKeySet, type EntryList } from './mapping'
import { WizardError } from './errors'

export function serverVarsPath(root: string): string {
  return join(root, 'server', '.dev.vars')
}

export function deliveryVarsPath(root: string): string {
  return join(root, 'delivery', '.dev.vars')
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // fsync-level hardening is best-effort on exotic filesystems
  }
}

/**
 * Write both env files. Throws EnvFileExistsError when a target exists and
 * force is false; with force, unknown pre-existing keys are preserved.
 */
export function writeEnvPair(
  root: string,
  serverEntries: EntryList,
  deliveryEntries: EntryList,
  force: boolean,
): void {
  const targets: Array<[string, EntryList, ReadonlySet<string>]> = [
    [serverVarsPath(root), serverEntries, serverKeySet()],
    [deliveryVarsPath(root), deliveryEntries, deliveryKeySet()],
  ]
  for (const [path] of targets) {
    if (existsSync(path) && !force) throw new EnvFileExistsError(path)
  }
  for (const [path, entries, keySet] of targets) {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    writePrivate(path, renderEnvFile(entries, existing, keySet))
  }
}

/** In-place upsert into an existing server/.dev.vars (post-deploy URLs…). */
export function upsertServerEnv(root: string, updates: EntryList): void {
  const path = serverVarsPath(root)
  if (!existsSync(path)) {
    throw new WizardError(
      `${path} is missing — run the wizard configure step first (./scripts/bootstrap.sh)`,
    )
  }
  writePrivate(path, upsertEnvText(readFileSync(path, 'utf8'), updates))
}

export function readServerEnv(root: string): Record<string, string> | undefined {
  const path = serverVarsPath(root)
  return existsSync(path) ? parseEntriesAsMap(readFileSync(path, 'utf8')) : undefined
}

export function readDeliveryEnv(root: string): Record<string, string> | undefined {
  const path = deliveryVarsPath(root)
  return existsSync(path) ? parseEntriesAsMap(readFileSync(path, 'utf8')) : undefined
}
