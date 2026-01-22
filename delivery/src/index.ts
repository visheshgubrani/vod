/**
 * ClipMux Delivery Worker
 *
 * SECURITY MODEL FOR SIGNED VIDEOS:
 * ─────────────────────────────────
 * Token is required for: .m3u8 (playlists) and .key (encryption keys)
 * Token is NOT required for: .ts (segments) - they're AES-128 encrypted anyway
 *
 * Flow:
 * 1. Client requests playlist.m3u8?token=xxx
 * 2. Worker verifies token, rewrites playlist to include token in:
 *    - Variant playlist URLs (stream_0.m3u8?token=xxx)
 *    - Key URIs (#EXT-X-KEY:...URI="...?token=xxx")
 * 3. Player fetches variant playlist with token (verified again)
 * 4. Player fetches enc.key with token (verified again)
 * 5. Player fetches .ts segments (no token needed - encrypted content)
 *
 * This is the same model used by Mux and other B2B video platforms.
 */

import * as jose from 'jose';

interface Env {
	TRANSCODED_BUCKET: R2Bucket;
	JWT_SECRET: string;
}

const MIME_TYPES: Record<string, string> = {
	'.m3u8': 'application/vnd.apple.mpegurl',
	'.mpd': 'application/dash+xml',
	'.ts': 'video/mp2t',
	'.mp4': 'video/mp4',
	'.m4s': 'video/iso.segment',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.key': 'application/octet-stream',
};

const CACHE_CONTROL = {
	playlist: 'public, max-age=5',
	segment: 'public, max-age=31536000, immutable',
	thumbnail: 'public, max-age=86400',
	key: 'private, no-store, max-age=0',
	default: 'public, max-age=3600',
};

function getMimeType(path: string): string {
	const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
	return MIME_TYPES[ext] || 'application/octet-stream';
}

function getCacheControl(path: string): string {
	if (path.endsWith('.m3u8') || path.endsWith('.mpd')) return CACHE_CONTROL.playlist;
	if (path.endsWith('.ts') || path.endsWith('.m4s') || path.endsWith('.mp4')) return CACHE_CONTROL.segment;
	if (path.endsWith('.key')) return CACHE_CONTROL.key;
	if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return CACHE_CONTROL.thumbnail;
	return CACHE_CONTROL.default;
}

function extractVideoId(path: string): string | null {
	const match = path.match(/^videos\/([^\/]+)\//);
	return match ? match[1] : null;
}

type NormalizedRange = {
	start: number;
	end: number;
	length: number;
};

function parseRangeHeader(rangeHeader: string): R2Range | null {
	if (!rangeHeader.startsWith('bytes=')) return null;
	const rangeSpec = rangeHeader.slice('bytes='.length).trim();
	if (!rangeSpec || rangeSpec.includes(',')) return null;

	if (rangeSpec.startsWith('-')) {
		const suffix = Number.parseInt(rangeSpec.slice(1), 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		return { suffix };
	}

	const [startStr, endStr] = rangeSpec.split('-', 2);
	const start = Number.parseInt(startStr, 10);
	if (!Number.isFinite(start) || start < 0) return null;

	if (endStr && endStr.length > 0) {
		const end = Number.parseInt(endStr, 10);
		if (!Number.isFinite(end) || end < start) return null;
		return { offset: start, length: end - start + 1 };
	}

	return { offset: start };
}

function resolveRange(range: R2Range, totalSize: number): NormalizedRange | null {
	if (totalSize <= 0) return null;

	if ('suffix' in range) {
		const suffix = range.suffix;
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		const length = Math.min(suffix, totalSize);
		const start = totalSize - length;
		return { start, end: totalSize - 1, length };
	}

	if ('offset' in range && range.offset !== undefined) {
		const start = range.offset;
		if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null;
		if ('length' in range && range.length !== undefined) {
			const length = Math.min(range.length, totalSize - start);
			if (length <= 0) return null;
			return { start, end: start + length - 1, length };
		}
		const length = totalSize - start;
		return { start, end: totalSize - 1, length };
	}

	if ('length' in range && range.length !== undefined) {
		const length = Math.min(range.length, totalSize);
		if (length <= 0) return null;
		return { start: 0, end: length - 1, length };
	}

	return null;
}

async function verifyToken(token: string, secret: string, videoId: string): Promise<boolean> {
	try {
		const secretKey = new TextEncoder().encode(secret);
		const { payload } = await jose.jwtVerify(token, secretKey);
		return payload.video_id === videoId || payload.sub === videoId;
	} catch {
		return false;
	}
}

/**
 * Rewrite HLS playlist to include token in:
 * 1. #EXT-X-KEY URIs (for encryption key access)
 * 2. #EXT-X-MEDIA URIs (for audio/subtitle tracks)
 * 3. Variant playlist URIs (.m3u8 references in master playlist)
 */
function rewritePlaylist(content: string, token: string): string {
	let result = content;

	// Debug: log original content (full content for debugging)
	console.log('=== PLAYLIST REWRITE DEBUG ===');
	console.log('Original content lines:', content.split('\n').length);
	console.log('FULL PLAYLIST CONTENT:');
	console.log(content);
	console.log('--- END CONTENT ---');

	// 1. Rewrite #EXT-X-KEY URIs (uses .*? to skip past any quoted attributes before URI)
	// IMPORTANT: Skip data URIs - they contain the key inline, not as a URL to fetch
	result = result.replace(/(#EXT-X-KEY:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		// Skip data URIs - they contain inline base64 key, don't append token
		if (uri.startsWith('data:')) {
			console.log(`Skipping data URI for KEY (inline key)`);
			return match;
		}
		const separator = uri.includes('?') ? '&' : '?';
		console.log(`Rewriting KEY URI: ${uri}`);
		return `${prefix}${uri}${separator}token=${token}${suffix}`;
	});

	// 2. Rewrite #EXT-X-MEDIA URIs (audio/subtitle tracks - uses .*? for same reason)
	result = result.replace(/(#EXT-X-MEDIA:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		// Skip data URIs
		if (uri.startsWith('data:')) {
			console.log(`Skipping data URI for MEDIA`);
			return match;
		}
		const separator = uri.includes('?') ? '&' : '?';
		console.log(`Rewriting MEDIA URI: ${uri}`);
		return `${prefix}${uri}${separator}token=${token}${suffix}`;
	});

	// 3. Rewrite variant playlist references (.m3u8 files as standalone lines)
	const m3u8Regex = /^([^#\s].*\.m3u8)$/gm;
	const matches = content.match(m3u8Regex);
	console.log('Found .m3u8 references:', matches);

	result = result.replace(m3u8Regex, (uri) => {
		const separator = uri.includes('?') ? '&' : '?';
		console.log(`Rewriting m3u8 ref: ${uri} -> ${uri}${separator}token=...`);
		return `${uri}${separator}token=${token}`;
	});

	console.log('=== END PLAYLIST REWRITE ===');
	return result;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Range',
			'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405, headers: corsHeaders });
		}

		const url = new URL(request.url);
		const key = url.pathname.slice(1);
		const token = url.searchParams.get('token');

		if (!key) return new Response('Not found', { status: 404, headers: corsHeaders });

		try {
			// 1. SETUP RANGE REQUEST (Standard)
			const rangeHeader = request.headers.get('Range');
			const options: R2GetOptions = {};
			const parsedRange = rangeHeader ? parseRangeHeader(rangeHeader) : null;

			if (parsedRange) {
				options.range = parsedRange;
			}

			// 2. FETCH OBJECT (Optimized: Get metadata AND handle in one shot)
			const object = await env.TRANSCODED_BUCKET.get(key, options);

			if (!object) {
				return new Response('Not found', { status: 404, headers: corsHeaders });
			}

			// --- DEBUG LOG START ---
			console.log(`[DELIVERY] Request for: ${key}`);
			console.log(`[DELIVERY] Metadata:`, JSON.stringify(object.customMetadata));
			// --- DEBUG LOG END ---

			// 3. CHECK AUTH (Using the metadata we just fetched!)
			const playbackPolicy = object.customMetadata?.['playback-policy'] || object.customMetadata?.playback_policy || 'public';
			const isSigned = playbackPolicy === 'signed';

			// Determine if we need to enforce security
			// Only playlists (.m3u8) and encryption keys (.key) require tokens
			// Media segments (.mp4, .m4s, .ts) are AES-128 encrypted and don't need token auth
			const isProtectedResource = key.endsWith('.m3u8') || key.endsWith('.key');

			console.log(`[DELIVERY] Policy: ${playbackPolicy}, isSigned: ${isSigned}, isProtected: ${isProtectedResource}`);

			if (isSigned && isProtectedResource) {
				if (!token) {
					console.log(`[DELIVERY] BLOCKED: No token for protected resource`);
					return new Response('Unauthorized: Token required', { status: 401, headers: corsHeaders });
				}

				const videoId = extractVideoId(key);
				if (!videoId) {
					console.log(`[DELIVERY] BLOCKED: Could not extract videoId from path`);
					return new Response('Invalid Path', { status: 400, headers: corsHeaders });
				}

				const isValid = await verifyToken(token, env.JWT_SECRET, videoId);
				if (!isValid) {
					console.log(`[DELIVERY] BLOCKED: Invalid token for video ${videoId}`);
					return new Response('Unauthorized: Invalid token', { status: 401, headers: corsHeaders });
				}
				console.log(`[DELIVERY] Token verified for video ${videoId}`);
			}

			// 4. PREPARE HEADERS
			const headers = new Headers({
				'Content-Type': getMimeType(key),
				'Cache-Control': getCacheControl(key),
				ETag: object.httpEtag,
				'Accept-Ranges': 'bytes',
				...corsHeaders,
			});

			// 5. MANIFEST REWRITING
			if (isSigned && key.endsWith('.m3u8') && token) {
				const content = await object.text();
				const rewritten = rewritePlaylist(content, token);

				// Ensure signed manifests are NEVER cached by the browser/CDN
				headers.set('Cache-Control', 'private, no-cache, no-store, max-age=0');
				headers.set('Content-Length', new TextEncoder().encode(rewritten).length.toString());

				return new Response(rewritten, { status: 200, headers });
			}

			// 6. SERVE BODY (Range or Full)
			const totalSize = object.size;
			const range = object.range ?? parsedRange;
			const resolvedRange = range ? resolveRange(range, totalSize) : null;

			if (rangeHeader && range && !resolvedRange) {
				headers.set('Content-Range', `bytes */${totalSize}`);
				headers.set('Content-Length', '0');
				return new Response(null, { status: 416, headers });
			}

			if (resolvedRange && 'body' in object) {
				headers.set('Content-Range', `bytes ${resolvedRange.start}-${resolvedRange.end}/${totalSize}`);
				headers.set('Content-Length', resolvedRange.length.toString());
				return new Response(object.body, { status: 206, headers });
			}

			headers.set('Content-Length', totalSize.toString());
			return new Response(object.body, { status: 200, headers });
		} catch (error) {
			console.error('Error serving content:', error);
			return new Response('Internal server error', { status: 500, headers: corsHeaders });
		}
	},
} satisfies ExportedHandler<Env>;
