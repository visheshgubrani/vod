import { describe, expect, it } from 'vitest'
import {
	cacheControlFor,
	domainMatchesPattern,
	extractVideoId,
	getCacheControl,
	getMimeType,
	isDomainAllowed,
	isNoCacheResource,
	normalizePlaybackUserAgent,
	resolvePlaybackPolicy,
	resolveRange,
	withTokenQuery,
} from './index'

describe('normalizePlaybackUserAgent', () => {
	it('collapses whitespace and lowercases', () => {
		expect(normalizePlaybackUserAgent('  Chrome/  120.0  ')).toBe('chrome')
	})

	it('maps browsers to engine families', () => {
		expect(normalizePlaybackUserAgent('Mozilla/5.0 Chrome/120.0 Safari/537.36')).toBe('chrome')
		expect(normalizePlaybackUserAgent('Mozilla/5.0 Firefox/121.0')).toBe('firefox')
		expect(normalizePlaybackUserAgent('Mozilla/5.0 Safari/605.1.15')).toBe('safari')
		expect(normalizePlaybackUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0')).toBe('edge')
		expect(normalizePlaybackUserAgent('Opera/9.80 (X11; Linux x86_64)')).toBe('opera')
		expect(normalizePlaybackUserAgent('Mozilla/5.0 Gecko/20100101')).toBe('gecko')
	})

	it('handles iOS and mobile variants', () => {
		expect(normalizePlaybackUserAgent('Mozilla/5.0 Crios/120.0 Mobile')).toBe('chrome')
		expect(normalizePlaybackUserAgent('Mozilla/5.0 FxiOS/121.0 Mobile')).toBe('firefox')
		expect(normalizePlaybackUserAgent('Mozilla/5.0 EdgiOS/120.0')).toBe('edge')
		expect(normalizePlaybackUserAgent('AppleCoreMedia/1.0.0.18J310')).toBe('applecoremedia')
	})

	it('falls back to unknown for empty or unrecognized agents', () => {
		expect(normalizePlaybackUserAgent(null)).toBe('unknown')
		expect(normalizePlaybackUserAgent(undefined)).toBe('unknown')
		expect(normalizePlaybackUserAgent('')).toBe('unknown')
		expect(normalizePlaybackUserAgent('   ')).toBe('unknown')
		expect(normalizePlaybackUserAgent('ExoPlayer/2.19.1')).toBe('unknown')
	})
})

describe('domainMatchesPattern', () => {
	it('treats "*" as allow-all', () => {
		expect(domainMatchesPattern('anything.example.org', '*')).toBe(true)
	})

	it('matches exact hosts', () => {
		expect(domainMatchesPattern('app.example.com', 'app.example.com')).toBe(true)
		expect(domainMatchesPattern('other.example.com', 'app.example.com')).toBe(false)
	})

	it('matches wildcard subdomains but never the apex or lookalikes', () => {
		expect(domainMatchesPattern('foo.vercel.app', '*.vercel.app')).toBe(true)
		expect(domainMatchesPattern('a.b.vercel.app', '*.vercel.app')).toBe(true)
		expect(domainMatchesPattern('vercel.app', '*.vercel.app')).toBe(false)
		expect(domainMatchesPattern('evilvercel.app', '*.vercel.app')).toBe(false)
		expect(domainMatchesPattern('vercel.app.evil.com', '*.vercel.app')).toBe(false)
	})
})

describe('isDomainAllowed', () => {
	it('rejects missing referer when no-referrer is not allowed', () => {
		expect(isDomainAllowed(null, ['app.example.com'], false)).toBe(false)
		expect(isDomainAllowed(null, ['app.example.com'], true)).toBe(true)
	})

	it('honors the allowlist and wildcard entries', () => {
		expect(isDomainAllowed('sub.vercel.app', ['*.vercel.app'], false)).toBe(true)
		expect(isDomainAllowed('app.example.com', ['app.example.com'], false)).toBe(true)
		expect(isDomainAllowed('evil.example.com', ['app.example.com'], false)).toBe(false)
		expect(isDomainAllowed('whatever.io', ['*'], false)).toBe(true)
	})
})

describe('resolvePlaybackPolicy', () => {
	it('metadata wins when present', () => {
		expect(resolvePlaybackPolicy('signed', 'public')).toBe('signed')
		expect(resolvePlaybackPolicy('public', 'signed')).toBe('public')
	})

	it('falls back to DEFAULT_POLICY when metadata is missing', () => {
		expect(resolvePlaybackPolicy(undefined, 'signed')).toBe('signed')
		expect(resolvePlaybackPolicy(undefined, undefined)).toBe('public')
		expect(resolvePlaybackPolicy('', 'signed')).toBe('signed')
	})

	it('rejects unknown metadata values via the default', () => {
		expect(resolvePlaybackPolicy('banana', undefined)).toBe('public')
		expect(resolvePlaybackPolicy('banana', 'signed')).toBe('signed')
	})
})

describe('cache-control matrix', () => {
	const pub = false
	const sig = true

	it('public playlists are fresh; signed playlists are no-store via override', () => {
		expect(getCacheControl('playlist.m3u8')).toBe('public, max-age=5')
		expect(cacheControlFor('playlist.m3u8', pub)).toBe('public, max-age=5')
		expect(cacheControlFor('manifest.mpd', pub)).toBe('public, max-age=5')
		// initial value for signed is still replaced by the no-store override
		expect(cacheControlFor('playlist.m3u8', sig)).toBe('public, max-age=5')
	})

	it('signed segments are capped at one day instead of immutable', () => {
		expect(cacheControlFor('video_1080p_0.m4s', pub)).toBe('public, max-age=31536000, immutable')
		expect(cacheControlFor('seg.ts', pub)).toBe('public, max-age=31536000, immutable')
		expect(cacheControlFor('clip.mp4', pub)).toBe('public, max-age=31536000, immutable')
		expect(cacheControlFor('video_1080p_0.m4s', sig)).toBe('public, max-age=86400')
		expect(cacheControlFor('seg.ts', sig)).toBe('public, max-age=86400')
		expect(cacheControlFor('clip.mp4', sig)).toBe('public, max-age=86400')
	})

	it('keys are never cached; thumbnails and vtt follow their rules', () => {
		expect(cacheControlFor('enc.key', pub)).toBe('private, no-store, max-age=0')
		expect(cacheControlFor('enc.key', sig)).toBe('private, no-store, max-age=0')
		expect(cacheControlFor('poster.jpg', pub)).toBe('public, max-age=86400')
		expect(cacheControlFor('poster.png', pub)).toBe('public, max-age=3600') // default: png not special-cased
		expect(cacheControlFor('subs.vtt', sig)).toBe('public, max-age=3600')
	})
})

describe('mime types and cache resources', () => {
	it('maps known extensions and falls back to octet-stream', () => {
		expect(getMimeType('x.m3u8')).toBe('application/vnd.apple.mpegurl')
		expect(getMimeType('x.mpd')).toBe('application/dash+xml')
		expect(getMimeType('x.m4s')).toBe('video/iso.segment')
		expect(getMimeType('x.vtt')).toBe('text/vtt')
		expect(getMimeType('x.unknown')).toBe('application/octet-stream')
	})

	it('marks playlists and keys as no-cache resources', () => {
		expect(isNoCacheResource('a.m3u8')).toBe(true)
		expect(isNoCacheResource('a.mpd')).toBe(true)
		expect(isNoCacheResource('a.key')).toBe(true)
		expect(isNoCacheResource('a.m4s')).toBe(false)
		expect(isNoCacheResource('a.ts')).toBe(false)
		expect(isNoCacheResource('a.vtt')).toBe(false)
		expect(isNoCacheResource('a.mp4')).toBe(false)
	})
})

describe('extractVideoId', () => {
	it('extracts ids from the videos/<id>/ layout only', () => {
		expect(extractVideoId('videos/abc-123/playlist.m3u8')).toBe('abc-123')
		expect(extractVideoId('videos/abc-123/stream_720p.m3u8')).toBe('abc-123')
		expect(extractVideoId('other/abc-123/x.m4s')).toBeNull()
		expect(extractVideoId('videos/')).toBeNull()
	})
})

describe('withTokenQuery', () => {
	it('appends token with correct separator', () => {
		expect(withTokenQuery('seg.m4s', 't1')).toBe('seg.m4s?token=t1')
		expect(withTokenQuery('seg.m4s?r=1', 't1')).toBe('seg.m4s?r=1&token=t1')
	})

	it('skips data:, blob:, absolute URLs and existing tokens', () => {
		expect(withTokenQuery('data:text/plain;base64,AA==', 't1')).toBe('data:text/plain;base64,AA==')
		expect(withTokenQuery('blob:https://x/y', 't1')).toBe('blob:https://x/y')
		expect(withTokenQuery('https://cdn.example.com/a.m4s', 't1')).toBe('https://cdn.example.com/a.m4s')
		expect(withTokenQuery('seg.m4s?token=old', 't1')).toBe('seg.m4s?token=old')
		expect(withTokenQuery('', 't1')).toBe('')
	})
})

describe('resolveRange', () => {
	const TOTAL = 1000

	it('resolves suffix ranges', () => {
		expect(resolveRange({ suffix: 100 }, TOTAL)).toEqual({ start: 900, end: 999, length: 100 })
		expect(resolveRange({ suffix: 2000 }, TOTAL)).toEqual({ start: 0, end: 999, length: 1000 })
	})

	it('resolves offset/length and open-ended offset ranges', () => {
		expect(resolveRange({ offset: 200, length: 100 }, TOTAL)).toEqual({
			start: 200,
			end: 299,
			length: 100,
		})
		expect(resolveRange({ offset: 200 }, TOTAL)).toEqual({ start: 200, end: 999, length: 800 })
	})

	it('clamps length to the object size', () => {
		expect(resolveRange({ offset: 900, length: 500 }, TOTAL)).toEqual({
			start: 900,
			end: 999,
			length: 100,
		})
	})

	it('returns null for invalid or unsatisfiable ranges', () => {
		expect(resolveRange({ suffix: 0 }, TOTAL)).toBeNull()
		expect(resolveRange({ suffix: -5 }, TOTAL)).toBeNull()
		expect(resolveRange({ suffix: NaN }, TOTAL)).toBeNull()
		expect(resolveRange({ offset: 1000 }, TOTAL)).toBeNull()
		expect(resolveRange({ offset: -1 }, TOTAL)).toBeNull()
		expect(resolveRange({ offset: 0, length: 0 }, TOTAL)).toBeNull()
		expect(resolveRange({ length: -1 }, TOTAL)).toBeNull()
	})

	it('handles empty objects', () => {
		expect(resolveRange({ suffix: 10 }, 0)).toBeNull()
	})
})
