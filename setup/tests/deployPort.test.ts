import { describe, expect, it } from 'vitest'
import { verifyDeliveryAnalytics } from '../src/deployPort'

const SECRET = 'a'.repeat(64)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('verifyDeliveryAnalytics', () => {
  it('rejects writer capabilities set to none even when ingestConfigured is true', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/health/config')) {
        return jsonResponse(200, {
          analyticsEnabled: true,
          ingestConfigured: true,
          playbackWrite: 'none',
          bandwidthWrite: 'none',
        })
      }
      throw new Error(`unexpected ${url}`)
    }

    await expect(
      verifyDeliveryAnalytics({
        baseUrl: 'https://media.example.com',
        ingestSecret: SECRET,
        fetchImpl,
      }),
    ).rejects.toThrow(/playbackWrite=none/)
  })

  it('requires both playback and bandwidth bindings, then an authenticated empty batch', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/health/config')) {
        return jsonResponse(200, {
          analyticsEnabled: true,
          ingestConfigured: true,
          playbackWrite: 'analytics-engine',
          bandwidthWrite: 'analytics-engine',
        })
      }
      if (url.endsWith('/internal/analytics/playback')) {
        const auth = new Headers(init?.headers).get('authorization')
        expect(auth).toBe(`Bearer ${SECRET}`)
        expect(JSON.parse(String(init?.body))).toEqual({ events: [] })
        return jsonResponse(200, { accepted: 0 })
      }
      throw new Error(`unexpected ${url}`)
    }

    await verifyDeliveryAnalytics({
      baseUrl: 'https://media.example.com',
      ingestSecret: SECRET,
      fetchImpl,
    })
    expect(calls).toEqual([
      'GET https://media.example.com/health/config',
      'POST https://media.example.com/internal/analytics/playback',
    ])
  })

  it('fails when the empty-batch request is unauthorized', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/health/config')) {
        return jsonResponse(200, {
          analyticsEnabled: true,
          ingestConfigured: true,
          playbackWrite: 'analytics-engine',
          bandwidthWrite: 'analytics-engine',
        })
      }
      return jsonResponse(401, { error: 'Unauthorized' })
    }

    await expect(
      verifyDeliveryAnalytics({
        baseUrl: 'https://media.example.com',
        ingestSecret: SECRET,
        fetchImpl,
      }),
    ).rejects.toThrow(/ingest secret/)
  })
})
