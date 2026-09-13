import { describe, expect, it } from 'vitest'
import * as jose from 'jose'
import { verifyToken } from './index'

/**
 * Playback token verification.
 *
 * These cases exist because the verifier previously specified only `issuer` and
 * `audience`. On jose@5.10.0 that accepts any HS* algorithm and accepts a token
 * that simply omits `exp` — so a correctly-signed but non-expiring token played
 * forever, and the docs claimed HS256 the whole time.
 *
 * The tokens here are genuinely signed with the shared secret, not forged. The
 * point is that a *valid* token of the wrong shape must still be refused.
 */

const SECRET = 'test-secret-at-least-32-characters-long'
const VIDEO_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = 'org-1'

function sign(
	claims: Record<string, unknown>,
	options: { alg?: string; secret?: string; noExp?: boolean } = {},
) {
	const key = new TextEncoder().encode(options.secret ?? SECRET)
	const jwt = new jose.SignJWT(claims)
		.setProtectedHeader({ alg: options.alg ?? 'HS256' })
		.setIssuer('openvod')
		.setAudience('playback')
	if (!options.noExp) {
		jwt.setExpirationTime('1h')
	}
	return jwt.sign(key)
}

/** `verifyToken` needs a Request only to read Referer/Origin. */
const request = () => new Request('https://media.example.com/videos/x/playlist.m3u8')

describe('verifyToken', () => {
	it('accepts an HS256 token with an expiry', async () => {
		const token = await sign({ sub: VIDEO_ID, org_id: ORG_ID })
		await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(true)
	})

	it('rejects a correctly-signed token that has no expiry', async () => {
		// The live gap: jose only validates `exp` when it is present, so without
		// `requiredClaims` this token is valid forever.
		const token = await sign({ sub: VIDEO_ID, org_id: ORG_ID }, { noExp: true })
		await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(false)
	})

	it('rejects a correctly-signed token using a non-HS256 algorithm', async () => {
		// Without an `algorithms` allowlist jose accepts any HS* variant.
		const token = await sign({ sub: VIDEO_ID, org_id: ORG_ID }, { alg: 'HS384' })
		await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(false)
	})

	it('rejects an expired token', async () => {
		const key = new TextEncoder().encode(SECRET)
		const token = await new jose.SignJWT({ sub: VIDEO_ID, org_id: ORG_ID })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer('openvod')
			.setAudience('playback')
			.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
			.sign(key)
		await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(false)
	})

	it('rejects a token signed with the wrong secret', async () => {
		const token = await sign(
			{ sub: VIDEO_ID, org_id: ORG_ID },
			{ secret: 'a-completely-different-secret-that-is-long-enough' },
		)
		await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(false)
	})

	it('rejects a token minted for a different video', async () => {
		const token = await sign({ sub: 'other-video', org_id: ORG_ID })
		await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(false)
	})

	it('rejects a token with the wrong issuer or audience', async () => {
		const key = new TextEncoder().encode(SECRET)
		for (const [iss, aud] of [
			['somebody-else', 'playback'],
			['openvod', 'not-playback'],
		]) {
			const token = await new jose.SignJWT({ sub: VIDEO_ID, org_id: ORG_ID })
				.setProtectedHeader({ alg: 'HS256' })
				.setIssuer(iss)
				.setAudience(aud)
				.setExpirationTime('1h')
				.sign(key)
			await expect(verifyToken(token, SECRET, VIDEO_ID, request(), undefined, ORG_ID)).resolves.toBe(false)
		}
	})
})
