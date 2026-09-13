import { describe, expect, it } from 'vitest'
import {
  AGENT_TOKEN_PREFIX,
  PAIRING_CODE_PREFIX,
  generateAgentToken,
  generatePairingCode,
  hashAgentSecret,
  last4,
  newAgentId,
  newPairingId,
  normalizePairingCode,
  readPresentedToken,
  secretsMatch,
} from '../../src/lib/agentToken'

describe('hashing', () => {
  it('is a stable SHA-256 hex digest', () => {
    const digest = hashAgentSecret('hello')
    expect(digest).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('never returns the input', () => {
    const secret = 'agt_supersecret'
    expect(hashAgentSecret(secret)).not.toContain('supersecret')
  })
})

describe('secretsMatch', () => {
  it('matches identical strings', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true)
  })

  it('rejects different strings of the same length', () => {
    expect(secretsMatch('abc', 'abd')).toBe(false)
  })

  it('rejects a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; a throw in an auth path is a
    // different bug than a false.
    expect(secretsMatch('abc', 'abcd')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(secretsMatch(undefined as unknown as string, 'abc')).toBe(false)
    expect(secretsMatch('abc', null as unknown as string)).toBe(false)
  })
})

describe('pairing codes', () => {
  it('uses an alphabet without look-alike characters', () => {
    // The code is read aloud and retyped; 0/O and 1/I/l turn that into a ticket.
    for (let i = 0; i < 50; i += 1) {
      const code = generatePairingCode()
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{2}$/)
    }
  })

  it('normalizes case, spaces and dashes for lookup', () => {
    expect(normalizePairingCode(' abcd-efgh-jk ')).toBe('ABCDEFGHJK')
    expect(normalizePairingCode('ABCD EFGH JK')).toBe('ABCDEFGHJK')
  })

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generatePairingCode()))
    expect(codes.size).toBe(200)
  })

  it('has the documented prefix on its identifiers', () => {
    expect(PAIRING_CODE_PREFIX).toBe('pair_')
    expect(newPairingId().startsWith(PAIRING_CODE_PREFIX)).toBe(true)
  })
})

describe('agent tokens', () => {
  it('carries its agent id so a leak is traceable', () => {
    const token = generateAgentToken('agt_abc')
    expect(token.startsWith(`${AGENT_TOKEN_PREFIX}agt_abc_`)).toBe(true)
  })

  it('is long and random', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateAgentToken('agt_x')))
    expect(tokens.size).toBe(200)
    for (const token of tokens) expect(token.length).toBeGreaterThan(40)
  })

  it('uses the documented id prefix', () => {
    expect(newAgentId().startsWith('agt_')).toBe(true)
  })

  it('reports the last four characters for a masked preview', () => {
    expect(last4('agt_x_abcdef')).toBe('cdef')
  })
})

describe('readPresentedToken', () => {
  it('reads a Bearer token', () => {
    const headers = new Headers({ authorization: 'Bearer agt_1_secret' })
    expect(readPresentedToken(headers)).toBe('agt_1_secret')
  })

  it('reads a bare x-agent-token header', () => {
    // Agents are frequently configured through an env var where the `Bearer `
    // prefix is easy to lose.
    const headers = new Headers({ 'x-agent-token': 'agt_1_secret' })
    expect(readPresentedToken(headers)).toBe('agt_1_secret')
  })

  it('prefers the Authorization header when both are present', () => {
    const headers = new Headers({
      authorization: 'Bearer from-auth',
      'x-agent-token': 'from-header',
    })
    expect(readPresentedToken(headers)).toBe('from-auth')
  })

  it('returns null when nothing was presented', () => {
    expect(readPresentedToken(new Headers())).toBeNull()
  })

  it('returns null for an empty Bearer value', () => {
    const headers = new Headers({ authorization: 'Bearer   ' })
    expect(readPresentedToken(headers)).toBeNull()
  })

  it('ignores a non-Bearer Authorization scheme', () => {
    const headers = new Headers({ authorization: 'Basic dXNlcjpwYXNz' })
    expect(readPresentedToken(headers)).toBeNull()
  })
})
