/**
 * Playback token refresh helpers (pure — no React dependency).
 *
 * Signed playback tokens carry an `exp` claim. Long-form content outlives
 * short tokens, so players should swap in a fresh token shortly before
 * expiry. The delivery worker verifies tokens per request, so swapping the
 * token on the playback URL mid-stream is seamless.
 */

/** Decode the `exp` (epoch seconds) claim of a HS* JWT payload. */
export function decodeJwtExp(token: string): number | null {
    if (!token || typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length < 2) return null
    try {
        const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const padded = payloadB64.padEnd(Math.ceil(payloadB64.length / 4) * 4, '=')
        const raw = globalThis.atob(padded)
        const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
        const json = new TextDecoder().decode(bytes)
        const payload = JSON.parse(json) as { exp?: unknown }
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
        return payload.exp
    } catch {
        return null
    }
}

export interface TokenRefreshPlan {
    /** Delay in ms until the refresh should fire (>= 0). */
    delayMs: number
    /** True when the token is already past/at its refresh point. */
    due: boolean
}

const MIN_REFRESH_LEAD_MS = 60_000 // refresh at least 60s before exp
const MIN_DELAY_MS = 1_000 // never busy-loop on clock skew

/**
 * When should the player ask for a refreshed token?
 *
 * @param expEpochSec  token `exp` (seconds since epoch)
 * @param nowEpochSec  current time (seconds since epoch)
 * @param minLeadMs    refresh lead time before expiry
 */
export function planTokenRefresh(
    expEpochSec: number,
    nowEpochSec: number,
    minLeadMs: number = MIN_REFRESH_LEAD_MS,
): TokenRefreshPlan {
    const expMs = expEpochSec * 1000
    const nowMs = nowEpochSec * 1000
    const untilExpiryMs = expMs - nowMs
    const delayMs = untilExpiryMs - minLeadMs
    if (delayMs <= 0) {
        // Already within the lead window (or expired) — refresh now.
        return { delayMs: 0, due: true }
    }
    return { delayMs: Math.max(MIN_DELAY_MS, delayMs), due: false }
}

/** Convenience: full decode + plan in one call. */
export function planRefreshForToken(
    token: string,
    nowEpochSec: number,
    minLeadMs?: number,
): TokenRefreshPlan | null {
    const exp = decodeJwtExp(token)
    if (exp === null) return null
    return planTokenRefresh(exp, nowEpochSec, minLeadMs)
}
