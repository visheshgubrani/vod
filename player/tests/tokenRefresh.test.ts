import { describe, expect, it } from 'vitest'
import {
    decodeJwtExp,
    planRefreshForToken,
    planTokenRefresh,
} from '../src/tokenRefresh'

// { "video_id": "v1", "exp": 1700000000 }
const TOKEN = `header.${btoa(JSON.stringify({ video_id: 'v1', exp: 1700000000 }))}.sig`
// same payload without exp
const NO_EXP = `header.${btoa(JSON.stringify({ video_id: 'v1' }))}.sig`

describe('decodeJwtExp', () => {
    it('decodes the exp claim from a JWT payload', () => {
        expect(decodeJwtExp(TOKEN)).toBe(1700000000)
    })

    it('returns null for malformed tokens or missing exp', () => {
        expect(decodeJwtExp('')).toBeNull()
        expect(decodeJwtExp('no-dots')).toBeNull()
        expect(decodeJwtExp(`a.${btoa('not json')}.c`)).toBeNull()
        expect(decodeJwtExp(NO_EXP)).toBeNull()
    })
})

describe('planTokenRefresh', () => {
    it('schedules refresh 60s before expiry by default', () => {
        // exp 1700000000 -> refresh at 1699999940
        const plan = planTokenRefresh(1700000000, 1699999000)
        expect(plan.delayMs).toBe((1700000000 - 1699999000) * 1000 - 60_000)
        expect(plan.due).toBe(false)
    })

    it('is due immediately inside the lead window', () => {
        expect(planTokenRefresh(1700000000, 1699999955).due).toBe(true)
        expect(planTokenRefresh(1700000000, 1699999955).delayMs).toBe(0)
    })

    it('is due immediately when already expired', () => {
        expect(planTokenRefresh(1700000000, 1700000100).due).toBe(true)
    })

    it('respects custom lead times', () => {
        const plan = planTokenRefresh(1700000000, 1699999000, 300_000)
        expect(plan.delayMs).toBe((1700000000 - 1699999000) * 1000 - 300_000)
    })

    it('never returns sub-second delays', () => {
        const plan = planTokenRefresh(1700000000, 1699999930) // 70s to expiry, lead 60s
        expect(plan.delayMs).toBeGreaterThanOrEqual(1_000)
    })
})

describe('planRefreshForToken', () => {
    it('returns null for tokens without an exp claim', () => {
        expect(planRefreshForToken(NO_EXP, 1699999000)).toBeNull()
        expect(planRefreshForToken('garbage', 1699999000)).toBeNull()
    })

    it('plans against the decoded expiry', () => {
        const plan = planRefreshForToken(TOKEN, 1699999000)
        expect(plan).not.toBeNull()
        expect(plan!.due).toBe(false)
        expect(planRefreshForToken(TOKEN, 1700000050)!.due).toBe(true)
    })
})
