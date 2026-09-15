import { describe, expect, it } from 'vitest'
import { buildRawObjectKey } from '../../src/lib/rawObjectKey'

describe('buildRawObjectKey', () => {
  it('keeps an already-safe filename in the org/raw/fileId layout', () => {
    const { fileId, key } = buildRawObjectKey('org-upload-url', 'clip.webm')
    expect(key).toBe(`org-upload-url/raw/${fileId}/clip.webm`)
  })

  it('strips SigV4-unsafe characters from a YouTube-style title', () => {
    const filename =
      "Peyush Bansal's Lenskart's Journey - Shark Tank India ｜ #Lenskart [LrA4UwYTJt8].webm"
    const { fileId, key } = buildRawObjectKey(
      'G1ct9tuZwIx7uXTGmGkYjVfyGYiuIqZu',
      filename,
    )
    expect(key).toBe(
      `G1ct9tuZwIx7uXTGmGkYjVfyGYiuIqZu/raw/${fileId}/Peyush_Bansal_s_Lenskart_s_Journey_-_Shark_Tank_India_Lenskart_LrA4UwYTJt8.webm`,
    )
  })

  it('uses only the basename so path segments cannot escape the prefix', () => {
    const { fileId, key } = buildRawObjectKey('org-1', 'foo/bar.mp4')
    expect(key).toBe(`org-1/raw/${fileId}/bar.mp4`)

    const escaped = buildRawObjectKey('org-1', '..\\..\\etc\\passwd.mov')
    expect(escaped.key).toBe(`org-1/raw/${escaped.fileId}/passwd.mov`)
  })

  it('falls back to fileId.bin when nothing safe remains', () => {
    const { fileId, key } = buildRawObjectKey('org-1', '!!!')
    expect(key).toBe(`org-1/raw/${fileId}/${fileId}.bin`)
  })

  it('keeps a safe extension when the stem sanitizes to nothing', () => {
    const { fileId, key } = buildRawObjectKey('org-1', '###.mp4')
    expect(key).toBe(`org-1/raw/${fileId}/${fileId}.mp4`)
  })

  it('uses org_default when the organization id is missing', () => {
    const { fileId, key } = buildRawObjectKey(null, 'clip.webm')
    expect(key).toBe(`org_default/raw/${fileId}/clip.webm`)
  })
})
