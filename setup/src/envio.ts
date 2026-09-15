/**
 * Filesystem helpers for the two configuration targets. All writes are mode
 * 0600 and never print values. Regeneration preserves keys the wizard does not
 * own (OAuth clients, sweeper tuning, …) and, for secrets, values that are
 * already there — see `secretSetFor`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EnvFileExistsError, parseEntriesAsMap, renderEnvFile, upsertEnvText } from './envfile'
import { deployKeySet, deliveryKeySet, serverKeySet, type EntryList } from './mapping'
import type { ConfigTarget } from './types'
import { WizardError } from './errors'

export function serverVarsPath(root: string): string {
  return join(root, 'server', '.dev.vars')
}

export function deliveryVarsPath(root: string): string {
  return join(root, 'delivery', '.dev.vars')
}

/**
 * The deployment config for docker-compose.yml.
 *
 * Not a `.dev.vars`: Compose only interpolates `${...}` from the shell
 * environment and the `.env` file next to the compose file, so the deployment
 * stack has to read this one. `server/.dev.vars` stays development-only.
 */
export function deployEnvPath(root: string): string {
  return join(root, '.env')
}

/**
 * The one file a run owns, and the delivery mirror when the target has one.
 *
 * `deploy` has no delivery mirror: a Compose deployment reads its JWT secret
 * from `.env`, and `delivery/.dev.vars` is only used by `wrangler dev`.
 */
export function primaryConfigPath(root: string, target: ConfigTarget): string {
  return target === 'deploy' ? deployEnvPath(root) : serverVarsPath(root)
}

/** Keys whose values the wizard may rewrite in the primary file. */
function primaryKeySet(target: ConfigTarget): ReadonlySet<string> {
  return target === 'deploy' ? deployKeySet() : serverKeySet()
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

export interface TargetWrites {
  /** server/.dev.vars (dev) or the root .env (deploy). */
  primary: EntryList
  /** delivery/.dev.vars — dev target only. */
  delivery?: EntryList
}

/**
 * Write the target's configuration. Throws EnvFileExistsError when a target
 * file exists and force is false; with force, pre-existing keys the wizard does
 * not own are preserved verbatim.
 */
export function writeTargetConfig(
  root: string,
  target: ConfigTarget,
  writes: TargetWrites,
  force: boolean,
): string[] {
  const targets: Array<[string, EntryList, ReadonlySet<string>]> = [
    [primaryConfigPath(root, target), writes.primary, primaryKeySet(target)],
  ]
  if (target === 'dev' && writes.delivery !== undefined) {
    targets.push([deliveryVarsPath(root), writes.delivery, deliveryKeySet()])
  }

  for (const [path] of targets) {
    if (existsSync(path) && !force) throw new EnvFileExistsError(path)
  }
  for (const [path, entries, keySet] of targets) {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    writePrivate(path, renderEnvFile(entries, existing, keySet))
  }
  return targets.map(([path]) => path)
}

/** In-place upsert into the target's primary file (post-deploy URLs…). */
export function upsertTargetConfig(
  root: string,
  target: ConfigTarget,
  updates: EntryList,
): void {
  const path = primaryConfigPath(root, target)
  if (!existsSync(path)) {
    throw new WizardError(
      `${path} is missing — run the wizard configure step first (./scripts/bootstrap.sh --target ${target})`,
    )
  }
  writePrivate(path, upsertEnvText(readFileSync(path, 'utf8'), updates))
}

/** Parsed primary config for the target, or undefined when it is absent. */
export function readTargetConfig(
  root: string,
  target: ConfigTarget,
): Record<string, string> | undefined {
  const path = primaryConfigPath(root, target)
  return existsSync(path) ? parseEntriesAsMap(readFileSync(path, 'utf8')) : undefined
}

/**
 * Which targets exist on disk.
 *
 * Both at once is the normal state for a machine that develops *and* deploys:
 * the wizard then has to ask which one a run owns instead of guessing.
 */
export function existingTargets(root: string): ConfigTarget[] {
  const found: ConfigTarget[] = []
  if (existsSync(serverVarsPath(root)) || existsSync(deliveryVarsPath(root))) found.push('dev')
  if (existsSync(deployEnvPath(root))) found.push('deploy')
  return found
}

export function readDeployEnv(root: string): Record<string, string> | undefined {
  const path = deployEnvPath(root)
  return existsSync(path) ? parseEntriesAsMap(readFileSync(path, 'utf8')) : undefined
}

export function readServerEnv(root: string): Record<string, string> | undefined {
  const path = serverVarsPath(root)
  return existsSync(path) ? parseEntriesAsMap(readFileSync(path, 'utf8')) : undefined
}

export function readDeliveryEnv(root: string): Record<string, string> | undefined {
  const path = deliveryVarsPath(root)
  return existsSync(path) ? parseEntriesAsMap(readFileSync(path, 'utf8')) : undefined
}
