import { describe, expect, it } from 'vitest'
import * as jose from 'jose'
import { generatePlaybackToken } from '../../src/routes/video'
import { requirePlaybackJwtSecret, type ClipMuxConfig } from '../../src/lib/config'

/**
 * Why this suite exists.
 *
 * `GET /api/video/:id` — the route the dashboard's player actually calls to get
 * a signed playback URL — minted its token with an *empty* signing key. Its
 * helper declared `jwtSecret: string = ''` and the call site omitted the
 * argument, so nothing failed loudly: the token was well-formed, carried every
 * binding claim, and the delivery worker rejected it with a 401 for every
 * signed video, for every tenant.
 *
 * It survived because the failure is invisible on the minting side. The only
 * assertion that catches it is the one that matters operationally: the token
 * this route hands out must verify under the key the delivery worker holds.
 */

// A literal, 32+ characters, obviously fake. Not a credential.
const TEST_SECRET = 'test-playback-signing-secret-0123456789'

const VIDEO_ID = '995d687a-0435-4225-939e-2260f792474c'
const ORG_ID = 'G1ct9tuZwIx7uXTGmGkYjVfyGYiuIqZu'
// sha256('firefox') — the worked example from the reported 401.
const UA_HASH = '16e5f60f207a1a0073451c35a9d315d17fdc17d7fab66449b00cdfaadc8b249e'

const BINDING = { ua_hash: UA_HASH }
const RESTRICTIONS = { allowed_domains: ['*'], allow_no_referrer: true }

async function verifyWith(token: string, secret: string): Promise<boolean> {
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: 'clipmux',
      audience: 'playback',
      algorithms: ['HS256'],
      requiredClaims: ['exp'],
    })
    return true
  } catch {
    return false
  }
}

describe('generatePlaybackToken', () => {
  it('mints a token the delivery worker can verify, with the documented claims', async () => {
    const token = await generatePlaybackToken(
      VIDEO_ID,
      ORG_ID,
      '4h',
      BINDING,
      RESTRICTIONS,
      TEST_SECRET,
    )

    expect(await verifyWith(token, TEST_SECRET)).toBe(true)

    const payload = jose.decodeJwt(token)
    expect(payload.video_id).toBe(VIDEO_ID)
    expect(payload.sub).toBe(VIDEO_ID)
    expect(payload.org_id).toBe(ORG_ID)
    expect(payload.ua_hash).toBe(UA_HASH)
    expect(payload.iss).toBe('clipmux')
    expect(payload.aud).toBe('playback')
    expect(typeof payload.exp).toBe('number')
  })

  it('is not verifiable by a delivery worker holding any key but the signing one', async () => {
    const token = await generatePlaybackToken(
      VIDEO_ID,
      ORG_ID,
      '4h',
      BINDING,
      RESTRICTIONS,
      TEST_SECRET,
    )

    expect(await verifyWith(token, '')).toBe(false)
    expect(await verifyWith(token, 'a-different-32-character-secret-value')).toBe(false)
  })

  it('cannot produce a token that a correctly-keyed worker rejects', async () => {
    const token = await generatePlaybackToken(
      VIDEO_ID,
      ORG_ID,
      '4h',
      BINDING,
      RESTRICTIONS,
      requirePlaybackJwtSecret({ jwtSecret: TEST_SECRET } as ClipMuxConfig),
    )

    // The shape of the original defect: a token that was well-formed, correctly
    // bound, unexpired — and rejected by the delivery worker anyway.
    expect(await verifyWith(token, TEST_SECRET)).toBe(true)
  })
})

describe('requirePlaybackJwtSecret', () => {
  function configWith(jwtSecret: string | null): ClipMuxConfig {
    return { jwtSecret } as ClipMuxConfig
  }

  it('returns the configured secret unchanged', () => {
    expect(requirePlaybackJwtSecret(configWith(TEST_SECRET))).toBe(TEST_SECRET)
  })

  it('throws rather than signing with an empty key', () => {
    expect(() => requirePlaybackJwtSecret(configWith(null))).toThrow(
      'JWT_SECRET is not configured (must be at least 32 characters)',
    )
  })

  it('throws for a whitespace-only secret', () => {
    expect(() => requirePlaybackJwtSecret(configWith('   '))).toThrow(
      'JWT_SECRET is not configured (must be at least 32 characters)',
    )
  })
})
