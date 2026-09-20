import { describe, expect, it } from 'vitest'
import { waitForOriginReady, OriginReadyError, requiredHealthChecks } from '../src/readiness'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('requiredHealthChecks', () => {
  it('never requires analytics, AI, delivery or rawUploads', () => {
    expect(requiredHealthChecks({ transcodeProvider: 'modal', uploadsEnabled: true })).toEqual([
      'database',
      'auth',
      'storage',
      'transcoder',
    ])
    expect(
      requiredHealthChecks({ transcodeProvider: 'self-hosted', uploadsEnabled: false }),
    ).toEqual(['database', 'auth'])
    expect(
      requiredHealthChecks({ transcodeProvider: 'self-hosted', uploadsEnabled: true }),
    ).toEqual(['database', 'auth', 'storage'])
  })
})

describe('waitForOriginReady', () => {
  it('succeeds when the dashboard and a ready /health/config answer', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://vod.example.com/') return new Response('ok', { status: 200 })
      if (url.endsWith('/health/config')) {
        return jsonResponse(200, { ready: true, checks: { database: true } })
      }
      throw new Error(`unexpected ${url}`)
    }

    await waitForOriginReady({
      origin: 'https://vod.example.com',
      fetchImpl,
      attempts: 1,
      sleep: async () => {},
    })
    expect(calls).toEqual([
      'https://vod.example.com/',
      'https://vod.example.com/health/config',
    ])
  })

  it('fails on HTTP errors, invalid JSON, ready:false and failed checks', async () => {
    const cases: Array<{ fetchImpl: typeof fetch; match: RegExp }> = [
      {
        fetchImpl: async () => new Response('nope', { status: 502 }),
        match: /HTTP 502/,
      },
      {
        fetchImpl: async (input) => {
          const url = String(input)
          if (url.endsWith('/')) return new Response('ok', { status: 200 })
          return new Response('not json', { status: 200 })
        },
        match: /not JSON/,
      },
      {
        fetchImpl: async (input) => {
          const url = String(input)
          if (url.endsWith('/')) return new Response('ok', { status: 200 })
          return jsonResponse(200, { ready: false, problems: ['DATABASE_URL is missing'] })
        },
        match: /ready: false/,
      },
      {
        fetchImpl: async (input) => {
          const url = String(input)
          if (url.endsWith('/')) return new Response('ok', { status: 200 })
          return jsonResponse(200, { ready: true, checks: { database: false, r2: true } })
        },
        match: /database/,
      },
    ]

    for (const testCase of cases) {
      await expect(
        waitForOriginReady({
          origin: 'http://localhost',
          fetchImpl: testCase.fetchImpl,
          attempts: 1,
          sleep: async () => {},
        }),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof OriginReadyError && testCase.match.test(error.message),
      )
    }
  })

  it('retries a transient failure then succeeds', async () => {
    let healthCalls = 0
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/')) return new Response('ok', { status: 200 })
      healthCalls += 1
      if (healthCalls < 3) return new Response('starting', { status: 502 })
      return jsonResponse(200, { ready: true, checks: {} })
    }
    const sleeps: number[] = []

    await waitForOriginReady({
      origin: 'http://localhost',
      fetchImpl,
      attempts: 5,
      delayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(healthCalls).toBe(3)
    expect(sleeps).toEqual([10, 10])
  })

  it('accepts ready: true when optional capability flags are false', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/')) return new Response('ok', { status: 200 })
      return jsonResponse(200, {
        ready: true,
        checks: {
          database: true,
          auth: true,
          analytics: false,
          ai: false,
          delivery: false,
          rawUploads: false,
        },
      })
    }

    await waitForOriginReady({
      origin: 'http://localhost',
      fetchImpl,
      attempts: 1,
      sleep: async () => {},
      requiredChecks: ['database', 'auth'],
    })
  })

  it('fails only required checks for the selected configuration', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/')) return new Response('ok', { status: 200 })
      return jsonResponse(200, {
        ready: true,
        checks: { database: true, auth: true, storage: false, analytics: false },
      })
    }

    await expect(
      waitForOriginReady({
        origin: 'http://localhost',
        fetchImpl,
        attempts: 1,
        sleep: async () => {},
        requiredChecks: ['database', 'auth', 'storage'],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof OriginReadyError && /storage/.test(error.message),
    )
  })
})
