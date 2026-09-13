import { describe, expect, it } from 'vitest'
import {
  canTransition,
  decideCallbackTransition,
  type VideoStatus,
} from '../../src/lib/videoState'

describe('canTransition', () => {
  it('follows the ingest pipeline uploading -> processing -> ready', () => {
    expect(canTransition('uploading', 'processing')).toBe(true)
    expect(canTransition('processing', 'ready')).toBe(true)
  })

  it('allows failure exits from in-flight states', () => {
    expect(canTransition('uploading', 'failed')).toBe(true)
    expect(canTransition('processing', 'failed')).toBe(true)
    expect(canTransition('pending', 'failed')).toBe(true)
  })

  it('forbids illegal transitions', () => {
    expect(canTransition('ready', 'processing')).toBe(false)
    expect(canTransition('ready', 'uploading')).toBe(false)
    expect(canTransition('failed', 'ready')).toBe(false) // retry must go via explicit endpoint
    expect(canTransition('processing', 'uploading')).toBe(false)
    expect(canTransition('uploading', 'ready')).toBe(false) // transcode not yet run
  })

  it('rejects unknown statuses', () => {
    expect(canTransition('bogus' as VideoStatus, 'ready')).toBe(false)
    expect(canTransition('uploading', 'bogus' as VideoStatus)).toBe(false)
  })
})

describe('decideCallbackTransition', () => {
  it('applies success only from processing (or late-uploading) states', () => {
    expect(decideCallbackTransition('processing', 'success').apply).toBe(true)
    expect(decideCallbackTransition('uploading', 'success').apply).toBe(true)
  })

  it('ignores late success callbacks after ready', () => {
    const decision = decideCallbackTransition('ready', 'success')
    expect(decision.apply).toBe(false)
    expect(decision.reason).toMatch(/late/i)
  })

  it('never resurrects a failed video with a late success callback', () => {
    const decision = decideCallbackTransition('failed', 'success')
    expect(decision.apply).toBe(false)
    expect(decision.reason).toMatch(/retry/i)
  })

  it('applies error callbacks from processing/uploading and ignores repeats on failed', () => {
    expect(decideCallbackTransition('processing', 'error').apply).toBe(true)
    expect(decideCallbackTransition('uploading', 'error').apply).toBe(true)
    const repeated = decideCallbackTransition('failed', 'error')
    expect(repeated.apply).toBe(false)
    expect(repeated.reason).toMatch(/already failed/i)
  })

  it('never downgrades a ready video with a stale error callback', () => {
    expect(decideCallbackTransition('ready', 'error').apply).toBe(false)
  })
})
