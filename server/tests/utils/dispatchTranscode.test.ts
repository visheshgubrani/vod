import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTranscodeJob,
  dispatchFailureStatus,
  DEFAULT_TRANSCODE_LEASE_MS,
} from '../../src/utils/dispatchTranscode'
import { DispatchError, isUncertainDispatch } from '../../src/utils/queue'
import type { AtomicExecutor } from '../../src/lib/atomicWrite'

/**
 * Orchestration of claim -> dispatch -> failure handling.
 *
 * The claim's *semantics* (CAS, leases, caps) are proven against real Postgres
 * in `tests/lib/transcodeClaim.test.ts`. What is checked here is the caller
 * contract around it, which is where the duplicate-GPU bug lived:
 *
 *   - dispatch is never reached when the claim was lost
 *   - a failed dispatch is recorded as `failed` rather than left in `processing`
 *   - an uncertain retry reuses the original attempt id instead of minting one
 *
 * The executor is faked deliberately: these are control-flow assertions, not
 * concurrency assertions.
 */

const VIDEO_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Render a drizzle SQL statement's literal text, for routing the fake.
 *
 * Drizzle interleaves `StringChunk`s (whose `value` is an array of SQL text)
 * with bound params (boxed primitives). `String(chunk)` on a StringChunk yields
 * "[object Object]", so the text has to be read out of `value` — otherwise
 * every statement looks identical and the fake misroutes them.
 */
function sqlText(statement: unknown): string {
  const chunks = (statement as { queryChunks?: unknown[] })?.queryChunks ?? []
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown })?.value
      if (Array.isArray(value)) return value.join('')
      return String(chunk)
    })
    .join('')
}

/**
 * Executor that answers whichever statement the claim issues.
 *
 * A capped claim runs `[lock organization, claim]` in one transaction, so the
 * fake routes on the statement text rather than on call order — otherwise an
 * uncapped claim (which takes no lock) would consume the lock's slot and every
 * assertion would silently shift by one.
 *
 * The fake exposes `transaction` because the capped path requires it.
 */
function fakeExecutor(claimRows: unknown[], diagnosticRows: unknown[] = []): AtomicExecutor {
  let claimServed = false
  let diagnosticServed = false

  const execute = vi.fn(async (statement: unknown) => {
    const text = sqlText(statement)
    if (text.includes('FOR UPDATE')) return [{ id: 'org-locked' }]
    if (!claimServed) {
      claimServed = true
      return claimRows
    }
    if (!diagnosticServed) {
      diagnosticServed = true
      return diagnosticRows
    }
    return []
  })

  return {
    execute,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
  } as unknown as AtomicExecutor
}

const ORG = 'org-dispatch'
const RAW_KEY = 'orgs/org-dispatch/raw/video.mp4'

function baseOptions(executor: AtomicExecutor) {
  return {
    videoId: VIDEO_ID,
    rawKey: RAW_KEY,
    organizationId: ORG,
    executor,
    mintAttemptId: () => 'att-minted',
    markVideoFailed: vi.fn(async () => undefined),
  }
}

describe('dispatchTranscodeJob', () => {
  it('dispatches with the attempt id the claim returned', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-won', job_attempts: 1 },
    ])
    const dispatch = vi.fn(async () => undefined)

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      dispatch,
    })

    expect(result).toEqual({
      dispatched: true,
      attemptId: 'att-won',
      jobAttempts: 1,
    })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: VIDEO_ID,
        key: RAW_KEY,
        organizationId: ORG,
        attemptId: 'att-won',
      }),
    )
  })

  it('never dispatches when the claim was lost', async () => {
    // Claim misses; the diagnostic read explains why.
    const executor = fakeExecutor(
      [],
      [
        {
          status: 'processing',
          deletedAt: null,
          actualAttemptId: 'att-other',
          organizationInFlight: 0,
        },
      ],
    )
    const dispatch = vi.fn(async () => undefined)

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      dispatch,
    })

    expect(result).toEqual({ dispatched: false, reason: 'already-claimed' })
    // This assertion is the whole point: no claim, no GPU run.
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports at-capacity without dispatching', async () => {
    const executor = fakeExecutor(
      [],
      [
        {
          status: 'uploading',
          deletedAt: null,
          actualAttemptId: null,
          organizationInFlight: 2,
        },
      ],
    )
    const dispatch = vi.fn(async () => undefined)

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      dispatch,
      organizationCap: 2,
    })

    expect(result).toEqual({ dispatched: false, reason: 'at-capacity' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not fail the row when a 5xx leaves the outcome ambiguous', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-won', job_attempts: 1 },
    ])
    const markVideoFailed = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => {
      throw new DispatchError('HTTP_STATUS', 'Transcoder responded with HTTP 500', 500)
    })

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      markVideoFailed,
      dispatch,
    })

    expect(result.dispatched).toBe(false)
    expect(result.dispatched === false && result.reason).toBe('dispatch-uncertain')
    expect(result.dispatched === false && result.error?.code).toBe('HTTP_STATUS')
    // A 5xx may mean the job started; the lease, not a failure write, resolves it.
    expect(markVideoFailed).not.toHaveBeenCalled()
  })

  it('wraps a non-DispatchError throw and treats it as ambiguous', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-won', job_attempts: 1 },
    ])
    const markVideoFailed = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => {
      throw new Error('socket hang up')
    })

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      markVideoFailed,
      dispatch,
    })

    expect(result.dispatched === false && result.error?.code).toBe('NETWORK')
    expect(result.dispatched === false && result.reason).toBe('dispatch-uncertain')
    expect(markVideoFailed).not.toHaveBeenCalled()
  })

  it('reuses a supplied attempt id so an uncertain retry cannot duplicate work', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-original', job_attempts: 1 },
    ])
    const dispatch = vi.fn(async () => undefined)

    await dispatchTranscodeJob({
      ...baseOptions(executor),
      attemptId: 'att-original',
      dispatch,
    })

    // The id the caller supplied — not the one mintAttemptId would produce —
    // must be the id bound into the claim, otherwise a retry after a lost
    // response would claim under a *new* identity and Modal would run twice.
    //
    // Drizzle's `queryChunks` interleaves literal SQL text (StringChunk) with
    // bound parameters, which arrive as boxed primitives. So: drop the text
    // chunks, stringify the rest.
    const claimStatement = (executor.execute as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { queryChunks: unknown[] }
    const boundValues = claimStatement.queryChunks
      .filter(
        (chunk) =>
          (chunk as { constructor?: { name?: string } })?.constructor?.name !==
          'StringChunk',
      )
      .map((chunk) => String(chunk))

    expect(boundValues).toContain('att-original')
    expect(boundValues).not.toContain('att-minted')
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'att-original' }),
    )
  })

  it('mints an attempt id when the caller does not supply one', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-minted', job_attempts: 1 },
    ])
    const dispatch = vi.fn(async () => undefined)

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      dispatch,
    })

    expect(result.dispatched === true && result.attemptId).toBe('att-minted')
  })

  it('defaults the lease to the documented ownership window', () => {
    // A literal, so a change to the constant is a deliberate decision.
    expect(DEFAULT_TRANSCODE_LEASE_MS).toBe(20 * 60_000)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Dispatch failure classification and the guarded failure write.
//
// The distinction that matters: the transcoder endpoint *starts work* when it
// accepts a request, so an ambiguous failure must not mark a possibly-running
// job as failed.
// ────────────────────────────────────────────────────────────────────────────
describe('isUncertainDispatch', () => {
  it('treats a network failure as ambiguous', () => {
    expect(isUncertainDispatch(new DispatchError('NETWORK', 'socket hang up'))).toBe(true)
  })

  it('treats a queue error as ambiguous', () => {
    expect(isUncertainDispatch(new DispatchError('QUEUE_ERROR', 'publish failed'))).toBe(true)
  })

  it('treats a 5xx as ambiguous — the request may have been accepted', () => {
    expect(
      isUncertainDispatch(new DispatchError('HTTP_STATUS', 'HTTP 500', 500)),
    ).toBe(true)
    expect(
      isUncertainDispatch(new DispatchError('HTTP_STATUS', 'HTTP 503', 503)),
    ).toBe(true)
  })

  it('treats a 4xx as definitive — it arrived and was refused', () => {
    expect(
      isUncertainDispatch(new DispatchError('HTTP_STATUS', 'HTTP 400', 400)),
    ).toBe(false)
    expect(
      isUncertainDispatch(new DispatchError('HTTP_STATUS', 'HTTP 401', 401)),
    ).toBe(false)
  })

  it('treats a missing configuration as definitive', () => {
    expect(isUncertainDispatch(new DispatchError('CONFIG_MISSING', 'no url'))).toBe(false)
  })

  it('treats a malformed envelope as definitive', () => {
    expect(isUncertainDispatch(new DispatchError('ENVELOPE_ERROR', 'bad body'))).toBe(false)
  })

  it('treats an HTTP_STATUS with no recorded status as ambiguous', () => {
    // Safer default: without a status we cannot claim it was refused.
    expect(isUncertainDispatch(new DispatchError('HTTP_STATUS', 'HTTP ?'))).toBe(true)
  })
})

describe('dispatchFailureStatus', () => {
  it('maps each reason to the status a route should return', () => {
    expect(dispatchFailureStatus('at-capacity')).toBe(429)
    expect(dispatchFailureStatus('dispatch-uncertain')).toBe(503)
    expect(dispatchFailureStatus('dispatch-failed')).toBe(502)
    expect(dispatchFailureStatus('already-claimed')).toBe(409)
    expect(dispatchFailureStatus('deleted')).toBe(404)
    expect(dispatchFailureStatus('not-found')).toBe(404)
  })
})

describe('dispatchTranscodeJob failure ownership', () => {
  it('leaves the claim in place when the outcome is uncertain', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-won', job_attempts: 1 },
    ])
    const markVideoFailed = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => {
      throw new DispatchError('NETWORK', 'socket hang up')
    })

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      markVideoFailed,
      dispatch,
    })

    expect(result.dispatched === false && result.reason).toBe('dispatch-uncertain')
    // The job may be running; failing it would both lie and hide it from the
    // sweeper, which reconciles via the lease instead.
    expect(markVideoFailed).not.toHaveBeenCalled()
  })

  it('fails the row only when the dispatch was definitively refused', async () => {
    const executor = fakeExecutor([
      { transcode_attempt_id: 'att-won', job_attempts: 1 },
    ])
    const markVideoFailed = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => {
      throw new DispatchError('HTTP_STATUS', 'HTTP 400', 400)
    })

    const result = await dispatchTranscodeJob({
      ...baseOptions(executor),
      markVideoFailed,
      dispatch,
    })

    expect(result.dispatched === false && result.reason).toBe('dispatch-failed')
    // Guarded by the attempt that actually failed, so a delayed failure cannot
    // clobber a row that has since completed or been superseded.
    expect(markVideoFailed).toHaveBeenCalledWith(VIDEO_ID, 'HTTP_STATUS', 'att-won')
  })
})
