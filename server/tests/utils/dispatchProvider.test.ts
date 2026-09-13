import { describe, expect, it } from 'vitest'
import { resolveProvider, selfHostedSubmissionAllowed } from '../../src/utils/dispatchProvider'
import { loadProviderSettings } from '../../src/lib/config'

/**
 * Provider resolution for a completed upload.
 *
 * The properties pinned here are the ones a wrong implementation silently
 * breaks: an existing installation must keep going to Modal, and a caller that
 * asked for something the server cannot do must be told rather than quietly
 * given a different engine.
 */
describe('resolveProvider', () => {
  it('defaults to modal when nothing is configured or requested', () => {
    expect(resolveProvider(undefined, {} as never)).toEqual({ ok: true, provider: 'modal' })
    expect(resolveProvider(null, {} as never)).toEqual({ ok: true, provider: 'modal' })
    expect(resolveProvider('', {} as never)).toEqual({ ok: true, provider: 'modal' })
  })

  it('uses the installation default when the request is silent', () => {
    const env = { TRANSCODE_PROVIDER: 'self-hosted' } as never
    expect(resolveProvider(undefined, env)).toEqual({ ok: true, provider: 'self-hosted' })
  })

  it('lets a request override the installation default', () => {
    const env = { TRANSCODE_PROVIDER: 'self-hosted' } as never
    expect(resolveProvider('modal', env)).toEqual({ ok: true, provider: 'modal' })

    const modalEnv = { TRANSCODE_PROVIDER: 'modal' } as never
    expect(resolveProvider('self-hosted', modalEnv)).toEqual({
      ok: true,
      provider: 'self-hosted',
    })
  })

  it('normalizes case and the local alias', () => {
    expect(resolveProvider('SELF-HOSTED', {} as never)).toEqual({
      ok: true,
      provider: 'self-hosted',
    })
    expect(resolveProvider(' local ', {} as never)).toEqual({ ok: true, provider: 'self-hosted' })
  })

  it('refuses an unknown provider instead of silently substituting one', () => {
    const result = resolveProvider('lambda', {} as never)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('modal')
  })
})

describe('selfHostedSubmissionAllowed', () => {
  it('always allows a Modal job', () => {
    expect(selfHostedSubmissionAllowed('modal', {} as never)).toBe(true)
  })

  it('allows self-hosted work when the provider is the default', () => {
    expect(
      selfHostedSubmissionAllowed('self-hosted', { TRANSCODE_PROVIDER: 'self-hosted' } as never),
    ).toBe(true)
  })

  it('refuses new self-hosted submissions once the rollback switch is set', () => {
    // `SELF_HOSTED_ENABLED=false` stops new work and cancels nothing: accepted
    // jobs drain, and local files are never moved to Modal automatically.
    expect(
      selfHostedSubmissionAllowed('self-hosted', {
        TRANSCODE_PROVIDER: 'self-hosted',
        SELF_HOSTED_ENABLED: 'false',
      } as never),
    ).toBe(false)
  })

  it('refuses self-hosted work when the installation defaults to modal', () => {
    // The provider is opt-in: an installation that never set it must not start
    // routing uploads to machines that may not exist.
    expect(selfHostedSubmissionAllowed('self-hosted', {} as never)).toBe(false)
  })

  it('agrees with the config module rather than re-deriving the rule', () => {
    const env = { TRANSCODE_PROVIDER: 'self-hosted' } as never
    expect(loadProviderSettings(env as never).selfHostedEnabled).toBe(
      selfHostedSubmissionAllowed('self-hosted', env),
    )
  })
})

describe('the rollback switch is enforced, not merely reported', () => {
  it('is the reason every provider-aware dispatch consults', async () => {
    // `dispatchWithProvider` must refuse rather than fall back to Modal: an owner
    // who turned local encoding off did not ask for their files to be uploaded
    // to someone else's cloud.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/utils/dispatchProvider.ts', import.meta.url), 'utf8'),
    )
    expect(source).toContain("reason: 'provider-disabled'")
    expect(source).toMatch(/if \(!selfHostedSubmissionAllowed\(provider, input\.env\)\)/)
  })

  it('maps to a retryable HTTP status so a client backs off rather than gives up', async () => {
    const { dispatchFailureStatus } = await import('../../src/utils/dispatchTranscode')
    expect(dispatchFailureStatus('provider-disabled')).toBe(503)
  })
})
