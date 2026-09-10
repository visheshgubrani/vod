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
  }
}
