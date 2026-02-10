/**
 * ClipMux Delivery Worker
 *
 * SECURITY MODEL FOR SIGNED VIDEOS:
 * ─────────────────────────────────
 * Token is required for ALL resources under a signed video:
 * playlists (.m3u8), segments (.mp4, .m4s, .ts), and keys (.key).
 *
 * Flow:
 * 1. Client requests playlist.m3u8?token=xxx
 * 2. Worker verifies token, rewrites playlist to include token in:
 *    - Variant playlist URLs (stream_0.m3u8?token=xxx)
 *    - Key URIs (#EXT-X-KEY:...URI="...?token=xxx")
 *    - Segment URIs (video_1080p.mp4?token=xxx)
 * 3. Player fetches all sub-resources with token (verified each time)
 *
 * This is the same model used by Mux, Cloudflare Stream, and api.video.
 */

import * as jose from 'jose';

interface Env {
	TRANSCODED_BUCKET: R2Bucket;
	JWT_SECRET: string;
	USAGE_ANALYTICS?: AnalyticsEngineDataset;  // For bandwidth tracking
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
 * 4. Segment URIs (.mp4, .m4s, .ts media segments)
 */
function rewritePlaylist(content: string, token: string): string {
	let result = content;

	// 1. Rewrite #EXT-X-KEY URIs (uses .*? to skip past any quoted attributes before URI)
	// IMPORTANT: Skip data URIs - they contain the key inline, not as a URL to fetch
	result = result.replace(/(#EXT-X-KEY:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		if (uri.startsWith('data:')) return match;
		const separator = uri.includes('?') ? '&' : '?';
		return `${prefix}${uri}${separator}token=${token}${suffix}`;
	});

	// 2. Rewrite #EXT-X-MEDIA URIs (audio/subtitle tracks - uses .*? for same reason)
	result = result.replace(/(#EXT-X-MEDIA:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		if (uri.startsWith('data:')) return match;
		const separator = uri.includes('?') ? '&' : '?';
		return `${prefix}${uri}${separator}token=${token}${suffix}`;
	});

	// 3. Rewrite variant playlist references (.m3u8 files as standalone lines)
	result = result.replace(/^[^#\s].*\.m3u8$/gm, (uri) => {
		const separator = uri.includes('?') ? '&' : '?';
		return `${uri}${separator}token=${token}`;
	});

	// 4. Rewrite #EXT-X-MAP URIs (fMP4 init segments)
	result = result.replace(/(#EXT-X-MAP:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		const separator = uri.includes('?') ? '&' : '?';
		return `${prefix}${uri}${separator}token=${token}${suffix}`;
	});

	// 5. Rewrite segment references (.mp4, .m4s, .ts media files as standalone lines)
	// NOTE: Must use non-capturing groups (?:...) — capturing groups break the replace callback
	result = result.replace(/^[^#\s].*\.(?:mp4|m4s|ts)$/gm, (uri) => {
		const separator = uri.includes('?') ? '&' : '?';
		return `${uri}${separator}token=${token}`;
	});

	return result;
}

/**
 * Log bandwidth usage to Analytics Engine for billing/analytics.
 * Non-blocking - uses waitUntil to prevent impacting response latency.
 */
function logBandwidth(
	ctx: ExecutionContext,
	env: Env,
	organizationId: string | undefined,
	videoId: string | null,
	bytesServed: number,
	fileType: string
) {
	if (!env.USAGE_ANALYTICS || !organizationId) return;

	ctx.waitUntil(
		(async () => {
			try {
				env.USAGE_ANALYTICS!.writeDataPoint({
					blobs: [
						organizationId,           // blob1: org for grouping
						videoId || 'unknown',     // blob2: video id
						fileType,                 // blob3: segment/playlist/thumbnail/key
					],
					doubles: [bytesServed],       // double1: bytes served
					indexes: [organizationId],    // index1: for fast org queries
				});
			} catch (e) {
				console.error('Failed to log bandwidth:', e);
			}
		})()
	);
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

			// All resources under a signed video require a valid token:
			// playlists (.m3u8), segments (.mp4, .m4s, .ts), keys (.key), etc.
			if (isSigned) {
				if (!token) {
					return new Response('Unauthorized: Token required', { status: 401, headers: corsHeaders });
				}

				const videoId = extractVideoId(key);
				if (!videoId) {
					return new Response('Invalid Path', { status: 400, headers: corsHeaders });
				}

				const isValid = await verifyToken(token, env.JWT_SECRET, videoId);
				if (!isValid) {
					return new Response('Unauthorized: Invalid token', { status: 401, headers: corsHeaders });
				}
			}

			// 4. PREPARE HEADERS
			const headers = new Headers({
				'Content-Type': getMimeType(key),
				'Cache-Control': getCacheControl(key),
				ETag: object.httpEtag,
				'Accept-Ranges': 'bytes',
				...corsHeaders,
			});

			// Extract org-id for bandwidth tracking (and add to header for cache compatibility)
			const organizationId = object.customMetadata?.['organization-id'];
			const videoId = extractVideoId(key);
			if (organizationId) {
				headers.set('X-Org-Id', organizationId);
			}

			// Determine file type for analytics categorization
			const getFileType = (path: string): string => {
				if (path.endsWith('.m3u8') || path.endsWith('.mpd')) return 'playlist';
				if (path.endsWith('.mp4') || path.endsWith('.m4s') || path.endsWith('.ts')) return 'segment';
				if (path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.png')) return 'thumbnail';
				if (path.endsWith('.key')) return 'key';
				if (path.endsWith('.vtt')) return 'subtitle';
				return 'other';
			};
			const fileType = getFileType(key);

			// 5. MANIFEST REWRITING
			if (isSigned && key.endsWith('.m3u8') && token) {
				const content = await object.text();
				const rewritten = rewritePlaylist(content, token);
				const rewrittenBytes = new TextEncoder().encode(rewritten).length;

				// Ensure signed manifests are NEVER cached by the browser/CDN
				headers.set('Cache-Control', 'private, no-cache, no-store, max-age=0');
				headers.set('Content-Length', rewrittenBytes.toString());

				// Log bandwidth
				logBandwidth(ctx, env, organizationId, videoId, rewrittenBytes, fileType);

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

				// Log bandwidth for range request
				logBandwidth(ctx, env, organizationId, videoId, resolvedRange.length, fileType);

				return new Response(object.body, { status: 206, headers });
			}

			headers.set('Content-Length', totalSize.toString());

			// Log bandwidth for full response
			logBandwidth(ctx, env, organizationId, videoId, totalSize, fileType);

			return new Response(object.body, { status: 200, headers });
		} catch (error) {
			console.error('Error serving content:', error);
			return new Response('Internal server error', { status: 500, headers: corsHeaders });
		}
	},
} satisfies ExportedHandler<Env>;
