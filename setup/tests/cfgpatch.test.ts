import { describe, expect, it } from 'vitest'
import { patchAnalyticsEngineDatasets, patchBucketName } from '../src/cfgpatch'

const WRANGLER = `{
  "name": "delivery",
  "r2_buckets": [
    {
      "binding": "TRANSCODED_BUCKET",
      "bucket_name": "transcoded-bucket"
    }
  ]
}
`

describe('patchBucketName', () => {
  it('replaces the first bucket_name value', () => {
    const updated = patchBucketName(WRANGLER, 'clipmux-transcoded')
    expect(updated).toContain('"bucket_name": "clipmux-transcoded"')
    expect(updated).not.toContain('"bucket_name": "transcoded-bucket"')
    expect(updated).toContain('"binding": "TRANSCODED_BUCKET"')
  })

  it('returns the original text when the value is unchanged', () => {
    expect(patchBucketName(WRANGLER, 'transcoded-bucket')).toBe(WRANGLER)
  })

  it('returns null when no bucket_name exists', () => {
    expect(patchBucketName('{ "name": "x" }', 'anything')).toBeNull()
  })
})

describe('patchAnalyticsEngineDatasets', () => {
  const withDatasets = `{
  "name": "delivery",
  "r2_buckets": [{ "binding": "TRANSCODED_BUCKET", "bucket_name": "clipmux-transcoded" }],
  "analytics_engine_datasets": [
    { "binding": "USAGE_ANALYTICS", "dataset": "bandwidth_usage" },
    { "binding": "PLAYBACK_ANALYTICS", "dataset": "playback_events" }
  ]
}`

  it('removes both dataset bindings when analytics are off', () => {
    const updated = patchAnalyticsEngineDatasets(withDatasets, false)
    expect(updated).not.toContain('analytics_engine_datasets')
    expect(updated).not.toContain('USAGE_ANALYTICS')
    expect(updated).not.toContain('PLAYBACK_ANALYTICS')
    expect(updated).toContain('TRANSCODED_BUCKET')
  })

  it('restores both dataset bindings when analytics are on and they are missing', () => {
    const stripped = patchAnalyticsEngineDatasets(withDatasets, false)
    const restored = patchAnalyticsEngineDatasets(stripped, true)
    expect(restored).toContain('"binding": "USAGE_ANALYTICS"')
    expect(restored).toContain('"binding": "PLAYBACK_ANALYTICS"')
    expect(restored).toContain('"dataset": "bandwidth_usage"')
    expect(restored).toContain('"dataset": "playback_events"')
  })

  it('leaves an already-enabled file unchanged', () => {
    expect(patchAnalyticsEngineDatasets(withDatasets, true)).toBe(withDatasets)
  })

  it('adds the missing playback binding to a bandwidth-only configuration', () => {
    const bandwidthOnly = `{
  "name": "delivery",
  "r2_buckets": [{ "binding": "TRANSCODED_BUCKET", "bucket_name": "clipmux-transcoded" }],
  "analytics_engine_datasets": [
    { "binding": "USAGE_ANALYTICS", "dataset": "bandwidth_usage" }
  ]
}`
    const updated = patchAnalyticsEngineDatasets(bandwidthOnly, true)
    expect(updated).toContain('"binding": "USAGE_ANALYTICS"')
    expect(updated).toContain('"binding": "PLAYBACK_ANALYTICS"')
    expect(updated).toContain('"dataset": "playback_events"')
    expect(JSON.parse(updated).analytics_engine_datasets).toEqual([
      { binding: 'USAGE_ANALYTICS', dataset: 'bandwidth_usage' },
      { binding: 'PLAYBACK_ANALYTICS', dataset: 'playback_events' },
    ])
  })

  it('inserts both dataset bindings into a compact configuration without invalid JSON', () => {
    const compact =
      '{"name":"delivery","r2_buckets":[{"binding":"TRANSCODED_BUCKET","bucket_name":"x"}],"compatibility_date":"2025-09-27"}'
    const updated = patchAnalyticsEngineDatasets(compact, true)
    const parsed = JSON.parse(updated) as {
      r2_buckets: unknown
      analytics_engine_datasets: Array<{ binding: string; dataset: string }>
      compatibility_date: string
    }
    expect(parsed.compatibility_date).toBe('2025-09-27')
    expect(parsed.r2_buckets).toEqual([{ binding: 'TRANSCODED_BUCKET', bucket_name: 'x' }])
    expect(parsed.analytics_engine_datasets).toEqual([
      { binding: 'USAGE_ANALYTICS', dataset: 'bandwidth_usage' },
      { binding: 'PLAYBACK_ANALYTICS', dataset: 'playback_events' },
    ])
  })

  it('repairs a compact bandwidth-only array without breaking surrounding properties', () => {
    const compact =
      '{"name":"delivery","r2_buckets":[{"binding":"TRANSCODED_BUCKET","bucket_name":"x"}],"analytics_engine_datasets":[{"binding":"USAGE_ANALYTICS","dataset":"bandwidth_usage"}],"compatibility_date":"2025-09-27"}'
    const parsed = JSON.parse(patchAnalyticsEngineDatasets(compact, true)) as {
      analytics_engine_datasets: Array<{ binding: string; dataset: string }>
      compatibility_date: string
    }
    expect(parsed.compatibility_date).toBe('2025-09-27')
    expect(parsed.analytics_engine_datasets).toEqual([
      { binding: 'USAGE_ANALYTICS', dataset: 'bandwidth_usage' },
      { binding: 'PLAYBACK_ANALYTICS', dataset: 'playback_events' },
    ])
  })

  it('leaves tab-indented bindings unchanged when both datasets already exist', () => {
    const tabbed = `{
	"r2_buckets": [
		{
			"binding": "TRANSCODED_BUCKET",
			"bucket_name": "clipmux-transcoded"
		}
	],
	"analytics_engine_datasets": [
		{ "binding": "USAGE_ANALYTICS", "dataset": "bandwidth_usage" },
		{ "binding": "PLAYBACK_ANALYTICS", "dataset": "playback_events" }
	]
}
`
    expect(patchAnalyticsEngineDatasets(tabbed, true)).toBe(tabbed)
  })
})
