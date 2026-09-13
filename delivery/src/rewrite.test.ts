import { describe, expect, it } from 'vitest'
import { rewriteSignedManifest } from './index'

const TOKEN = 'abc123'

describe('rewriteSignedManifest (HLS)', () => {
  it('appends tokens to EXT-X-KEY / MAP / MEDIA URIs', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"',
      '#EXTINF:4.0,',
      'video_1080p_0.m4s',
    ].join('\n')

    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toContain('URI="key.bin?token=abc123"')
    expect(out).toContain('URI="init.mp4?token=abc123"')
    expect(out).toContain('URI="audio.m3u8?token=abc123"')
    expect(out).toContain('\nvideo_1080p_0.m4s?token=abc123')
  })

  it('rewrites I-FRAME-STREAM-INF, SESSION-KEY, IMAGE-STREAM-INF, PRELOAD-HINT and RENDITION-REPORT URIs', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframe.m3u8"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="session.key"',
      '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,URI="thumbs.vtt"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="video_1080p_1.m4s"',
      '#EXT-X-RENDITION-REPORT:URI="stream_720p.m3u8"',
    ].join('\n')

    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toContain('URI="iframe.m3u8?token=abc123"')
    expect(out).toContain('URI="session.key?token=abc123"')
    expect(out).toContain('URI="thumbs.vtt?token=abc123"')
    expect(out).toContain('URI="video_1080p_1.m4s?token=abc123"')
    expect(out).toContain('URI="stream_720p.m3u8?token=abc123"')
  })

  it('preserves CRLF line endings', () => {
    const input = '#EXTM3U\r\n#EXTINF:4.0,\r\nvideo_1080p_0.m4s\r\n'
    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toBe('#EXTM3U\r\n#EXTINF:4.0,\r\nvideo_1080p_0.m4s?token=abc123\r\n')
  })

  it('never rewrites data: URIs', () => {
    const input = '#EXT-X-KEY:METHOD=NONE,URI="data:text/plain;base64,AAAA"'
    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toBe(input)
  })

  it('never appends tokens to absolute (foreign-host) URLs', () => {
    const input = [
      '#EXTM3U',
      'https://evil.example.com/seg.m4s?t=1',
      'http://cdn.example.com/other.m3u8',
      'relative_1080p.m4s',
    ].join('\n')
    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toContain('https://evil.example.com/seg.m4s?t=1')
    expect(out).toContain('http://cdn.example.com/other.m3u8')
    expect(out).toContain('relative_1080p.m4s?token=abc123')
  })

  it('leaves URIs that already carry a token untouched', () => {
    const input = '#EXTINF:4.0,\nvideo_720p_2.m4s?token=existing'
    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toContain('video_720p_2.m4s?token=existing')
  })

  it('rewrites query-string segment URIs without double-&', () => {
    const input = '#EXTINF:4.0,\nvideo_1080p_0.m4s?r=1'
    const out = rewriteSignedManifest(input, TOKEN, 'hls')
    expect(out).toContain('video_1080p_0.m4s?r=1&token=abc123')
  })
})

describe('rewriteSignedManifest (DASH)', () => {
  const mpd = `<?xml version="1.0"?>
<MPD>
  <BaseURL>renditions/</BaseURL>
  <AdaptationSet>
    <Representation id="1080p">
      <SegmentTemplate media="video_1080p_$Number$.m4s" initialization="video_1080p_init.mp4"/>
    </Representation>
  </AdaptationSet>
</MPD>`

  it('rewrites media and initialization templates and relative BaseURL', () => {
    const out = rewriteSignedManifest(mpd, TOKEN, 'dash')
    expect(out).toContain('media="video_1080p_$Number$.m4s?token=abc123"')
    expect(out).toContain('initialization="video_1080p_init.mp4?token=abc123"')
    expect(out).toContain('<BaseURL>renditions/?token=abc123</BaseURL>')
  })

  it('leaves absolute BaseURLs alone', () => {
    const withAbs = mpd.replace('<BaseURL>renditions/</BaseURL>', '<BaseURL>https://cdn.example.com/x/</BaseURL>')
    const out = rewriteSignedManifest(withAbs, TOKEN, 'dash')
    expect(out).toContain('<BaseURL>https://cdn.example.com/x/</BaseURL>')
  })

  it('leaves templates that already carry tokens alone', () => {
    const out = rewriteSignedManifest(mpd.replace('$Number$.m4s"', '$Number$.m4s?token=keep"'), TOKEN, 'dash')
    expect(out).toContain('media="video_1080p_$Number$.m4s?token=keep"')
  })
})
