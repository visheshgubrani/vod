/**
 * Agent credentials.
 *
 * Two secrets with very different lifetimes, and conflating them is the classic
 * mistake here:
 *
 * - A **pairing code** travels through a human channel (the dashboard displays
 *   it, the owner pastes it into the agent). It is short, single-use, and expires
 *   in minutes. It exists only to bootstrap.
 * - An **agent token** is a machine credential. It is long, never displayed
 *   again, stored only as a SHA-256 digest, and revoked rather than edited.
 *
 * Scope is the other half of the design. An agent token is bound to exactly one
 * organization and one agent row, and it can only:
 *
 *   - poll for its own control requests and jobs,
 *   - claim work belonging to its organization,
 *   - report progress on attempts it owns,
 *   - request transfers for paths inside an attempt prefix it owns.
 *
 * It explicitly cannot mint playback tokens, administer users, or read another
 * tenant's data. That is enforced by *never* handing an agent token to
 * `requireApiKey` or `requireAuth` — the agent routes carry their own middleware
 * — rather than by listing forbidden actions, which is a list that goes stale.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from './database'
import { transcoderAgent, transcoderPairing } from '../db/schema'

export const AGENT_TOKEN_PREFIX = 'agt_'
export const PAIRING_CODE_PREFIX = 'pair_'

/** Agent tokens are long-lived by design: an agent is unattended hardware. */
export const PAIRING_CODE_TTL_MS = 15 * 60_000

export function hashAgentSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch —
 * and a throw in an auth path is a different bug than a `false`.
 */
export function secretsMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Base32-ish alphabet without look-alike characters.
 *
 * A pairing code gets read aloud and retyped. `0/O` and `1/I/l` turn a
 * five-second task into a support ticket, so they are not in the alphabet.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function generatePairingCode(): string {
  const bytes = randomBytes(10)
  let code = ''
  for (let i = 0; i < 10; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  // Grouped for transcription: XXXX-XXXX-XX
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`
}

export function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, '')
}

export function generateAgentToken(agentId: string): string {
  return `${AGENT_TOKEN_PREFIX}${agentId}_${randomBytes(24).toString('base64url')}`
}

export function newAgentId(): string {
  return `agt_${randomBytes(9).toString('hex')}`
}

export function newPairingId(): string {
  return `pair_${randomBytes(9).toString('hex')}`
}

export function last4(value: string): string {
  return value.slice(-4)
}

/**
 * Extract a presented agent token from an Authorization header.
 *
 * Accepts `Bearer <token>` and a bare `x-agent-token`, because agents are often
 * configured through an environment variable where the `Bearer ` prefix is easy
 * to lose and produces a confusing 401.
 */
export function readPresentedToken(headers: Headers): string | null {
  const auth = headers.get('authorization') || ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    const value = auth.slice(7).trim()
    if (value) return value
  }
  const header = (headers.get('x-agent-token') || '').trim()
  return header || null
}

export type AuthenticatedAgent = {
  id: string
  organizationId: string
  name: string
  enabled: boolean
  capacityJobs: number
  capacityRenditions: number
  hostname: string | null
  agentVersion: string | null
}

/**
 * Resolve an agent token to its row.
 *
 * Returns `null` for unknown, revoked and disabled agents alike — the caller
 * must not be able to distinguish "revoked" from "never existed", because that
 * distinction tells an attacker whether a guessed token was once valid.
 */
export async function authenticateAgentToken(
  token: string | null,
): Promise<AuthenticatedAgent | null> {
  if (!token || !token.startsWith(AGENT_TOKEN_PREFIX)) return null

  const tokenHash = hashAgentSecret(token)
  const rows = await db
    .select({
      id: transcoderAgent.id,
      organizationId: transcoderAgent.organizationId,
      name: transcoderAgent.name,
      enabled: transcoderAgent.enabled,
      capacityJobs: transcoderAgent.capacityJobs,
      capacityRenditions: transcoderAgent.capacityRenditions,
      hostname: transcoderAgent.hostname,
      agentVersion: transcoderAgent.agentVersion,
      tokenHash: transcoderAgent.tokenHash,
      revokedAt: transcoderAgent.revokedAt,
    })
    .from(transcoderAgent)
    .where(and(eq(transcoderAgent.tokenHash, tokenHash), isNull(transcoderAgent.revokedAt)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  // Belt and braces: the WHERE clause already matched the digest, but comparing
  // again in constant time keeps the property true if the query ever changes.
  if (!secretsMatch(row.tokenHash, tokenHash)) return null

  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    enabled: row.enabled,
    capacityJobs: row.capacityJobs,
    capacityRenditions: row.capacityRenditions,
    hostname: row.hostname,
    agentVersion: row.agentVersion,
  }
}

export type PairingRedemption = {
  organizationId: string
  suggestedName: string | null
  pairingId: string
}

/**
 * Consume a pairing code, returning the organization it authorizes.
 *
 * The consume is a single conditional UPDATE so two agents racing on one code
 * cannot both win: the loser sees zero rows and is told the code is invalid,
 * which is also what an expired code produces.
 */
export async function redeemPairingCode(code: string): Promise<PairingRedemption | null> {
  const normalized = normalizePairingCode(code)
  if (!normalized) return null

  const codeHash = hashAgentSecret(normalized)
  const rows = await db
    .select({
      id: transcoderPairing.id,
      organizationId: transcoderPairing.organizationId,
      suggestedName: transcoderPairing.suggestedName,
      codeHash: transcoderPairing.codeHash,
      consumedAt: transcoderPairing.consumedAt,
      expiresAt: transcoderPairing.expiresAt,
    })
    .from(transcoderPairing)
    .where(eq(transcoderPairing.codeHash, codeHash))
    .limit(1)

  const candidate = rows[0]
  if (!candidate) return null
  if (!secretsMatch(candidate.codeHash, codeHash)) return null
  if (candidate.consumedAt) return null
  if (candidate.expiresAt.getTime() <= Date.now()) return null

  const consumed = await db
    .update(transcoderPairing)
    .set({ consumedAt: new Date() })
    .where(and(eq(transcoderPairing.id, candidate.id), isNull(transcoderPairing.consumedAt)))
    .returning({ id: transcoderPairing.id })

  if (consumed.length === 0) return null

  return {
    organizationId: candidate.organizationId,
    suggestedName: candidate.suggestedName,
    pairingId: candidate.id,
  }
}
