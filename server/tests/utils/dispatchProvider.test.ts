import { describe, expect, it } from 'vitest'
import { localSubmissionAllowed, resolveProvider } from '../../src/utils/dispatchProvider'
import { loadProviderSettings } from '../../src/lib/config'

describe('deployment provider selection', () => {
  it('defaults the server to Modal when the provider is omitted', () => {
    expect(resolveProvider({})).toEqual({ ok: true, provider: 'modal' })
  })

  it('uses the one provider selected for the deployment', () => {
    expect(resolveProvider({ TRANSCODE_PROVIDER: 'local' })).toEqual({ ok: true, provider: 'local' })
    expect(resolveProvider({ TRANSCODE_PROVIDER: 'modal' })).toEqual({ ok: true, provider: 'modal' })
  })

  it('does not accept the removed provider alias', () => {
    expect(loadProviderSettings({ TRANSCODE_PROVIDER: 'self-hosted' }).problems[0]).toContain('TRANSCODE_PROVIDER')
  })

  it('stops new local work only when the deployment flag is disabled', () => {
    expect(localSubmissionAllowed('local', { TRANSCODE_PROVIDER: 'local' })).toBe(true)
    expect(localSubmissionAllowed('local', { TRANSCODE_PROVIDER: 'local', LOCAL_TRANSCODE_ENABLED: 'false' })).toBe(false)
    expect(localSubmissionAllowed('modal', {})).toBe(true)
  })
})
