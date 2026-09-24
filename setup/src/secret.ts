/**
 * Secret generation — replaces `openssl rand` from the old bash installer
 * with node:crypto so the wizard has no openssl dependency.
 */

import { randomBytes } from 'node:crypto'
import type { SecretSet } from './types.ts'

/** 64 hex chars (32 bytes) — comfortably above the 32-char minimums. */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export function newSecretSet(): SecretSet {
  return {
    betterAuthSecret: randomHex(),
    jwtSecret: randomHex(),
    internalSweepSecret: randomHex(),
    transcodeIngestSecret: randomHex(),
    localTranscoderSecret: randomHex(),
    analyticsIngestSecret: randomHex(),
    postgresPassword: randomHex(24),
  }
}

/** Env key ↔ SecretSet field, so re-reading a file cannot miss one. */
const SECRET_ENV_KEYS: ReadonlyArray<readonly [keyof SecretSet, string]> = [
  ['betterAuthSecret', 'BETTER_AUTH_SECRET'],
  ['jwtSecret', 'JWT_SECRET'],
  ['internalSweepSecret', 'INTERNAL_SWEEP_SECRET'],
  ['transcodeIngestSecret', 'TRANSCODE_INGEST_SECRET'],
  ['localTranscoderSecret', 'LOCAL_TRANSCODER_SECRET'],
  ['analyticsIngestSecret', 'ANALYTICS_INGEST_SECRET'],
  ['postgresPassword', 'POSTGRES_PASSWORD'],
]

/**
 * The secrets to write, preferring whatever the target file already holds.
 *
 * Regenerating on every run is what made reconfiguring dangerous: a fresh
 * `JWT_SECRET` invalidates every playback token and silently diverges from the
 * secret already uploaded to the delivery worker, and a new
 * `POSTGRES_PASSWORD` locks the operator out of a database volume that still
 * has the old one. Values are reused unless the file does not have them, or the
 * caller explicitly rotates.
 */
export function secretSetFor(
  existing: Record<string, string> | undefined,
  options: { rotate?: boolean } = {},
): SecretSet {
  const generated = newSecretSet()
  if (options.rotate === true || existing === undefined) return generated

  const result = { ...generated }
  for (const [field, key] of SECRET_ENV_KEYS) {
    const value = (existing[key] ?? '').trim()
    if (value !== '') result[field] = value
  }
  return result
}

/** Which secrets were carried over rather than generated (for the report). */
export function preservedSecretKeys(
  existing: Record<string, string> | undefined,
  options: { rotate?: boolean } = {},
): string[] {
  if (options.rotate === true || existing === undefined) return []
  return SECRET_ENV_KEYS.filter(([, key]) => (existing[key] ?? '').trim() !== '').map(([, key]) => key)
}
