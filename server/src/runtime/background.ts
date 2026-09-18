/**
 * Background work that must outlive the response.
 *
 * Node has no `ctx.waitUntil`, so the promise is kept alive and its rejection
 * logged: dropping the rejection would make a failed webhook dispatch or cleanup
 * pass completely silent, which is the failure mode this seam exists to avoid.
 *
 * Both shapes Node needs are built on one tracker — the capability the app
 * schedules work through (`runtime.background`) and the request context Hono
 * exposes as `c.executionCtx` — so the two cannot drift into different failure
 * behaviour.
 */

import type { BackgroundRun, WaitUntilLike } from './types'

/** Keep a fire-and-forget promise alive; log, never throw, on rejection. */
function track(work: unknown, label: string): void {
  Promise.resolve(work).catch((error) => {
    console.error(`[background] ${label} failed:`, error)
  })
}

export function nodeBackground(): BackgroundRun {
  return (work, label) => track(work, label)
}

/**
 * Node's stand-in for the platform `ExecutionContext`.
 *
 * Hono takes the platform context as `fetch`'s third argument and exposes it as
 * `c.executionCtx`. Hono's getter *throws* rather than returning undefined, so
 * without this every route that dispatches a tenant webhook or schedules
 * post-response work fails with "This context has no ExecutionContext" — after
 * the row is written and the presigned URL generated. `createNodeRequestHandler`
 * installs it, so no route has to know how the process is hosted.
 */
export function nodeExecutionContext(): WaitUntilLike {
  return {
    waitUntil: (work) => track(work, 'waitUntil'),
  }
}
