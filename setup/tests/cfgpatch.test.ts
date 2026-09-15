import { describe, expect, it } from 'vitest'
import { patchBucketName } from '../src/cfgpatch'

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
