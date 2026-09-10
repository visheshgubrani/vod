import { describe, expect, it, vi } from 'vitest'
import {
  planSweep,
  runSweep,
  type SweepableVideo,
  type SweepLimits,
} from '../../src/utils/jobSweeper'

const MIN = 60_000
const LIMITS: SweepLimits = {
  processingStaleMs: 45 * MIN,
  uploadingStaleMs: 24 * 60 * MIN,
  maxJobAttempts: 3,
}

function makeVideo(overrides: Partial<SweepableVideo>): SweepableVideo {
  const baseTime = new Date('2026-01-01T00:00:00Z')
  return {
    id: 'vid-1',
    status: 'processing',
    updatedAt: baseTime,
    processingStartedAt: baseTime,
    lastHeartbeatAt: null,
    jobAttempts: 1,
    rawKey: 'org/raw/vid-1/file.mp4',
    title: 'Test',
    organizationId: 'org-1',
    playbackPolicy: 'public',
    generateSubtitle: false,
    generateChapters: false,
    ...overrides,
  }
}

const NOW = new Date('2026-01-02T00:00:00Z') // 24h after baseTime

describe('planSweep', () => {
  it('retries stale processing jobs below the attempt cap', () => {
    const video = makeVideo({})
    const plan = planSweep(NOW, [video], LIMITS)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ action: 'retry', reason: expect.stringMatching(/stale/i) })
  })

  it('fails processing jobs past the attempt cap with a typed code', () => {
    const video = makeVideo({ jobAttempts: 3 })
    const plan = planSweep(NOW, [video], LIMITS)
    expect(plan[0]).toMatchObject({ action: 'fail', failureCode: 'JOB_TIMEOUT' })
  })

  it('ignores processing jobs with a recent heartbeat even when updatedAt is old', () => {
    const video = makeVideo({
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      processingStartedAt: new Date('2026-01-01T00:00:00Z'),
      lastHeartbeatAt: new Date('2026-01-01T23:55:00Z'), // 5 min ago
    })
    expect(planSweep(NOW, [video], LIMITS)).toEqual([])
  })

  it('treats last activity as the max of updated/heartbeat/started times', () => {
    // heartbeat 10 min ago but updatedAt 24h ago -> still fresh
    const video = makeVideo({
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      processingStartedAt: new Date('2026-01-01T00:00:00Z'),
      lastHeartbeatAt: new Date('2026-01-01T23:50:00Z'),
    })
    expect(planSweep(NOW, [video], LIMITS)).toEqual([])
  })

  it('fails stale processing jobs that have no rawKey instead of retrying them', () => {
    const video = makeVideo({ rawKey: null })
    const plan = planSweep(NOW, [video], LIMITS)
    expect(plan[0]).toMatchObject({ action: 'fail', failureCode: 'RAW_KEY_MISSING' })
  })

  it('aborts abandoned uploading rows after the upload window', () => {
    const video = makeVideo({ status: 'uploading', updatedAt: new Date('2026-01-01T00:00:00Z') })
    const plan = planSweep(NOW, [video], LIMITS)
    expect(plan[0]).toMatchObject({ action: 'abortUpload' })
  })

  it('leaves fresh uploading and recent processing rows alone', () => {
    const freshUpload = makeVideo({ status: 'uploading', updatedAt: NOW })
    const freshProcessing = makeVideo({ updatedAt: NOW, processingStartedAt: NOW })
    expect(planSweep(NOW, [freshUpload, freshProcessing], LIMITS)).toEqual([])
  })

  it('ignores ready/failed rows entirely', () => {
    const ready = makeVideo({ status: 'ready', updatedAt: new Date('2026-01-01T00:00:00Z') })
    const failed = makeVideo({ status: 'failed', updatedAt: new Date('2026-01-01T00:00:00Z') })
    expect(planSweep(NOW, [ready, failed], LIMITS)).toEqual([])
  })

  it('sorts retry candidates oldest-first for fairness', () => {
    const older = makeVideo({
      id: 'old',
      updatedAt: new Date('2025-12-01T00:00:00Z'),
      processingStartedAt: new Date('2025-12-01T00:00:00Z'),
    })
    const newer = makeVideo({
      id: 'new',
      updatedAt: new Date('2025-12-31T00:00:00Z'),
      processingStartedAt: new Date('2025-12-31T00:00:00Z'),
    })
    const plan = planSweep(NOW, [newer, older], LIMITS)
    expect(plan.map((p) => p.video.id)).toEqual(['old', 'new'])
  })
})

describe('runSweep', () => {
  const staleProcessing = makeVideo({
    id: 'retry-me',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  })
  const deadProcessing = makeVideo({
    id: 'dead',
    jobAttempts: 3,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  })
  const abandonedUpload = makeVideo({
    id: 'abandoned',
    status: 'uploading',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  })

  function makeAdapters() {
    return {
      fetchStaleProcessing: vi.fn(async () => [staleProcessing, deadProcessing]),
      fetchStaleUploading: vi.fn(async () => [abandonedUpload]),
      dispatchRetry: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      markAbandoned: vi.fn(async () => undefined),
    }
  }

  it('applies retry/fail/abort actions and reports stats', async () => {
    const adapters = makeAdapters()
    const stats = await runSweep(NOW, LIMITS, adapters)

    expect(adapters.dispatchRetry).toHaveBeenCalledWith(staleProcessing)
    expect(adapters.markFailed).toHaveBeenCalledWith(
      deadProcessing.id,
      'JOB_TIMEOUT',
      expect.any(String),
    )
    expect(adapters.markAbandoned).toHaveBeenCalledWith(abandonedUpload.id)
    expect(stats).toEqual({ retried: 1, failed: 1, aborted: 1 })
  })

  it('marks retries failed when dispatch throws instead of leaving them stuck', async () => {
    const adapters = makeAdapters()
    adapters.dispatchRetry.mockRejectedValue(new Error('transcoder down'))

    const stats = await runSweep(NOW, LIMITS, adapters)

    expect(adapters.markFailed).toHaveBeenCalledWith(
      staleProcessing.id,
      'DISPATCH_FAILED',
      expect.any(String),
    )
    expect(stats).toEqual({ retried: 0, failed: 2, aborted: 1 })
  })

  it('survives adapter failures for one row without losing the rest', async () => {
    const adapters = makeAdapters()
    adapters.markFailed.mockRejectedValueOnce(new Error('db hiccup'))

    const stats = await runSweep(NOW, LIMITS, adapters)

    expect(stats.failed).toBeGreaterThanOrEqual(1)
    // dead row failed via second call; abandoned upload still processed
    expect(adapters.markAbandoned).toHaveBeenCalled()
  })
})
