import { describe, expect, it } from 'vitest'
import { sqlText } from '../helpers/sql'
import {
  attemptPrefix,
  completionSideEvents,
  inventoryVerifiedPredicate,
  joinUrl,
  legacyPrefix,
  ownershipPredicate,
  parseCompletionPayload,
  safeJsonParse,
} from '../../src/lib/lifecycleFinalize'

const DELIVERY = 'https://delivery.example.com'

function payload(overrides: Record<string, unknown> = {}) {
  return {
    status: 'success',
    video_id: 'vid-1',
    metadata: {
      width: 1920,
      height: 1080,
      duration: 61.4,
      fps: 30,
      has_audio: true,
      is_hdr: false,
      is_vertical: false,
      aspect_ratio: '1.78:1',
    },
    outputs: {
      renditions: ['1080p', '720p'],
      hls_playlist: 'playlist.m3u8',
      dash_manifest: 'manifest.mpd',
      poster: 'poster.jpg',
      subtitles: null,
    },
    processing: {
      total_time: 120,
      transcode_time: 90,
      processing_speed: 0.68,
      transcoded_size: 12345678,
    },
    subtitle: { requested: false, generated: false, status: null },
    chapters: { requested: false, generated: false, status: null },
    playback_policy: 'public',
    ...overrides,
  } as Record<string, unknown>
}

describe('prefixes', () => {
  it('scopes a self-hosted attempt to its own directory', () => {
    expect(attemptPrefix('vid-1', 'att-9')).toBe('videos/vid-1/attempts/att-9')
  })

  it('keeps the legacy Modal layout unchanged', () => {
    expect(legacyPrefix('vid-1')).toBe('videos/vid-1')
  })

  it('trims a custom prefix rather than doubling slashes', () => {
    expect(attemptPrefix('v', 'a', '/custom/')).toBe('custom/v/attempts/a')
  })
})

describe('joinUrl', () => {
  it('joins without doubling slashes', () => {
    expect(joinUrl('https://d.example.com/', '/videos/a/playlist.m3u8')).toBe(
      'https://d.example.com/videos/a/playlist.m3u8',
    )
  })

  it('returns a relative path when there is no base', () => {
    expect(joinUrl('', 'videos/a/playlist.m3u8')).toBe('videos/a/playlist.m3u8')
  })
})

describe('safeJsonParse', () => {
  it('parses JSON strings', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 })
  })

  it('falls back for null and malformed input instead of throwing', () => {
    expect(safeJsonParse(null, { fallback: true })).toEqual({ fallback: true })
    expect(safeJsonParse('{not json', { fallback: true })).toEqual({ fallback: true })
  })
})

describe('parseCompletionPayload', () => {
  it('re-bases relative artifact paths onto the attempt prefix', () => {
    const parsed = parseCompletionPayload(payload(), {
      outputPrefix: 'videos/vid-1/attempts/att-9',
      deliveryBaseUrl: DELIVERY,
    })
    expect(parsed.hlsUrl).toBe(
      'https://delivery.example.com/videos/vid-1/attempts/att-9/playlist.m3u8',
    )
    expect(parsed.thumbnailUrl).toBe(
      'https://delivery.example.com/videos/vid-1/attempts/att-9/poster.jpg',
    )
  })

  it('passes an already-complete key through on the legacy path', () => {
    const parsed = parseCompletionPayload(
      payload({ outputs: { ...payload().outputs, hls_playlist: 'videos/vid-1/playlist.m3u8' } }),
      { outputPrefix: null, deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.hlsUrl).toBe('https://delivery.example.com/videos/vid-1/playlist.m3u8')
  })

  it('never lets an agent assert a foreign playback host', () => {
    // A compromised agent must not be able to point a viewer at another origin:
    // the scheme and host are dropped, and only the pathname survives.
    const parsed = parseCompletionPayload(
      payload({ outputs: { hls_playlist: 'https://evil.example.com/playlist.m3u8' } }),
      { outputPrefix: 'videos/vid-1/attempts/att-9', deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.hlsUrl).toBe(
      'https://delivery.example.com/videos/vid-1/attempts/att-9/playlist.m3u8',
    )
  })

  it('cannot climb out of its attempt prefix with parent segments', () => {
    const parsed = parseCompletionPayload(
      payload({ outputs: { hls_playlist: '../../other-video/playlist.m3u8' } }),
      { outputPrefix: 'videos/vid-1/attempts/att-9', deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.hlsUrl).toBe(
      'https://delivery.example.com/videos/vid-1/attempts/att-9/other-video/playlist.m3u8',
    )
  })

  it('floors the duration for the integer seconds column', () => {
    const parsed = parseCompletionPayload(payload(), {
      outputPrefix: null,
      deliveryBaseUrl: DELIVERY,
    })
    expect(parsed.duration).toBe(61.4)
    expect(Math.floor(parsed.duration as number)).toBe(61)
  })

  it('treats a missing duration as null rather than zero', () => {
    const parsed = parseCompletionPayload(payload({ metadata: { width: 1, height: 1 } }), {
      outputPrefix: null,
      deliveryBaseUrl: DELIVERY,
    })
    expect(parsed.duration).toBeNull()
  })

  it('derives subtitle status from the requested/generated pair', () => {
    const parsed = parseCompletionPayload(
      payload({ subtitle: { requested: true, generated: true, url: 'subtitles.vtt' } }),
      { outputPrefix: 'videos/v/a', deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.subtitleStatus).toBe('completed')
    expect(parsed.subtitleUrl).toBe('https://delivery.example.com/videos/v/a/subtitles.vtt')
  })

  it('marks a requested but missing subtitle as failed', () => {
    const parsed = parseCompletionPayload(
      payload({ subtitle: { requested: true, generated: false } }),
      { outputPrefix: null, deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.subtitleStatus).toBe('failed')
    expect(parsed.subtitleUrl).toBeNull()
  })

  it('keeps chapters only when they were actually generated', () => {
    const parsed = parseCompletionPayload(
      payload({
        chapters: {
          requested: true,
          generated: true,
          status: 'completed',
          data: [{ startTime: 0, endTime: 5, title: 'Intro' }],
        },
      }),
      { outputPrefix: null, deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.chaptersStatus).toBe('completed')
    expect(parsed.chapters).toEqual([{ startTime: 0, endTime: 5, title: 'Intro' }])
  })

  it('merges into previous metadata instead of replacing it', () => {
    const parsed = parseCompletionPayload(payload(), {
      outputPrefix: null,
      deliveryBaseUrl: DELIVERY,
      prevMetadata: { uploader: 'dana', custom: 7 },
    })
    const meta = JSON.parse(parsed.metadataJson)
    expect(meta.uploader).toBe('dana')
    expect(meta.custom).toBe(7)
    expect(meta.width).toBe(1920)
    expect(meta.backend).toBeUndefined()
  })

  it('records the engine diagnostics when the agent reports them', () => {
    const parsed = parseCompletionPayload(
      payload({
        processing: {
          backend: 'vaapi',
          fallbacks: ['nvenc -> cpu: ENCODER_FAILED'],
          plan_fingerprint: 'abc123',
        },
      }),
      { outputPrefix: null, deliveryBaseUrl: DELIVERY },
    )
    const meta = JSON.parse(parsed.metadataJson)
    expect(meta.backend).toBe('vaapi')
    expect(meta.fallbacks).toEqual(['nvenc -> cpu: ENCODER_FAILED'])
    expect(meta.plan_fingerprint).toBe('abc123')
  })

  it('reports the resolutions the agent actually encoded', () => {
    const parsed = parseCompletionPayload(payload(), {
      outputPrefix: null,
      deliveryBaseUrl: DELIVERY,
    })
    expect(parsed.resolutions).toEqual(['1080p', '720p'])
  })

  it('ignores a non-array renditions field', () => {
    const parsed = parseCompletionPayload(
      payload({ outputs: { renditions: 'nope' } }),
      { outputPrefix: null, deliveryBaseUrl: DELIVERY },
    )
    expect(parsed.resolutions).toBeNull()
  })
})

describe('ownership and inventory guards', () => {
  it('guards on the attempt id when the row has one', () => {
    const text = sqlText(ownershipPredicate('att-1'))
    expect(text).toContain('transcode_attempt_id =')
    // The id must be a bound parameter, never interpolated into the text.
    expect(text).not.toContain('att-1')
  })

  it('guards on NULL for a legacy row with no attempt id', () => {
    // This is what lets in-flight Modal callbacks survive a rolling upgrade.
    expect(sqlText(ownershipPredicate(null))).toContain('transcode_attempt_id IS NULL')
  })

  it('requires a fully verified inventory for a self-hosted attempt', () => {
    const text = sqlText(inventoryVerifiedPredicate('vid-1', 'att-1')!)
    expect(text).toContain("inv.status = 'verified'")
    expect(text).toContain('inv.verified_count = inv.item_count')
    expect(text).toContain('inv.attempt_id =')
  })

  it('imposes no inventory gate when there is no attempt (Modal path)', () => {
    expect(inventoryVerifiedPredicate('vid-1', null)).toBeNull()
  })
})

describe('completionSideEvents', () => {
  it('emits nothing when nothing optional was requested', () => {
    expect(
      completionSideEvents(
        { subtitleStatus: null, chaptersStatus: null },
        payload(),
      ),
    ).toEqual([])
  })

  it('emits generated and failed events for each enrichment', () => {
    const events = completionSideEvents(
      { subtitleStatus: 'completed', chaptersStatus: 'failed' },
      payload({
        subtitle: { requested: true },
        chapters: { requested: true },
      }),
    )
    expect(events.map((e) => e.event)).toEqual(['subtitle.generated', 'chapters.failed'])
  })

  it('does not emit a subtitle event when the video never asked for one', () => {
    const events = completionSideEvents(
      { subtitleStatus: 'completed', chaptersStatus: null },
      payload({ subtitle: { requested: false } }),
    )
    expect(events).toEqual([])
  })
})
