/**
 * The request context Hono exposes as `c.executionCtx`.
 *
 * Hono's getter *throws* when `fetch` was called without a context — it does not
 * return undefined — and route call sites read it to dispatch tenant webhooks
 * and to schedule post-response work. Workers hand over a real
 * `ExecutionContext` per invocation; Node has none, so the handler factory the
 * Node entrypoint installs supplies the stand-in. Without it the first such
 * route on Node answers `500 Internal server error` and the webhook it was
 * about to dispatch is never even attempted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { resetInstalledDb } from '../../src/lib/database'
import { resetInstalledR2 } from '../../src/utils/R2'
import { nodeExecutionContext } from '../../src/runtime/background'
import { createNodeRequestHandler, createNodeRuntime } from '../../src/runtime/node'
import { fullyConfiguredEnv } from '../helpers/runtime'

afterEach(() => {
  resetInstalledDb()
  resetInstalledR2()
})

describe('Node request context', () => {
  it('is installed for every request, so a route can read c.executionCtx', async () => {
    const runtime = createNodeRuntime(fullyConfiguredEnv())
    const app = createApp(runtime)
    const scheduled: string[] = []

    // Stands in for the ~20 real call sites (webhook dispatch, api-key
    // `lastUsedAt`): reading `c.executionCtx` is the whole assertion.
    app.get('/probe', (c) => {
      c.executionCtx.waitUntil(Promise.resolve().then(() => void scheduled.push('ran')))
      return c.json({ ok: true })
    })

    const response = await createNodeRequestHandler(app, runtime)(
      new Request('http://localhost/probe'),
    )

    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(scheduled).toEqual(['ran']))
  })

  it('keeps a rejected background task out of the response path, and logs it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      nodeExecutionContext().waitUntil(Promise.reject(new Error('upload hook failed')))

      await vi.waitFor(() => expect(errors).toHaveBeenCalled())
      expect(String(errors.mock.calls[0]?.[0])).toContain('[background] waitUntil failed')
      expect(String(errors.mock.calls[0]?.[1])).toContain('upload hook failed')
    } finally {
      errors.mockRestore()
    }
  })
})
