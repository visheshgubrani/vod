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

const JWT_ISSUER = 'clipmux';
const JWT_AUDIENCE = 'playback';
const UNKNOWN_USER_AGENT = 'unknown';
const ANY_DOMAIN_PATTERN = '*';

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
	'.vtt': 'text/vtt',
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

/** Resources that must never be cached for signed videos (playlists contain token-bearing URLs). */
function isNoCacheResource(path: string): boolean {
	return (
		path.endsWith('.m3u8') ||
		path.endsWith('.mpd') ||
		path.endsWith('.key')
	);
}

type NormalizedRange = {
	start: number;
	end: number;
	length: number;
};

function withTokenQuery(uri: string, token: string): string {
	if (!uri || uri.startsWith('data:') || uri.startsWith('blob:') || /(?:\?|&)token=/.test(uri)) {
		return uri;
	}
	const separator = uri.includes('?') ? '&' : '?';
	return `${uri}${separator}token=${token}`;
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

function normalizePlaybackUserAgent(value: string | null | undefined): string {
	if (!value) return UNKNOWN_USER_AGENT;
	const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
	if (!normalized) return UNKNOWN_USER_AGENT;

	// Normalize to browser engine/family so minor version updates don't break playback.
	if (normalized.includes('applecoremedia')) return 'applecoremedia';
	if (normalized.includes('edg/') || normalized.includes('edga/') || normalized.includes('edgios/')) {
		return 'edge';
	}
	if (normalized.includes('opr/') || normalized.includes('opera')) return 'opera';
	if (
		normalized.includes('chrome/') ||
		normalized.includes('crios/') ||
		normalized.includes('chromium/') ||
		normalized.includes('crmo/')
	) {
		return 'chrome';
	}
	if (normalized.includes('firefox/') || normalized.includes('fxios/')) return 'firefox';
	if (normalized.includes('safari/')) return 'safari';
	if (normalized.includes('webkit/')) return 'webkit';
	if (normalized.includes('gecko/')) return 'gecko';

	return UNKNOWN_USER_AGENT;
}

function getUserAgentFromRequest(request: Request): string {
	return normalizePlaybackUserAgent(request.headers.get('user-agent'));
}

function hostnameFromHeaderValue(value: string | null): string | null {
	if (!value) return null;

	try {
		const parsed = new URL(value);
		return parsed.hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

function getRequestPlaybackDomain(request: Request): {
	domain: string | null;
	source: 'referer' | 'origin' | 'none';
	referer: string | null;
	origin: string | null;
} {
	const referer = request.headers.get('referer');
	const origin = request.headers.get('origin');
	const refererDomain = hostnameFromHeaderValue(referer);
	if (refererDomain) {
		return { domain: refererDomain, source: 'referer', referer, origin };
	}

	const originDomain = hostnameFromHeaderValue(origin);
	if (originDomain) {
		return { domain: originDomain, source: 'origin', referer, origin };
	}

	return { domain: null, source: 'none', referer, origin };
}

function normalizeDomainPattern(value: string): string | null {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	if (trimmed === ANY_DOMAIN_PATTERN) return ANY_DOMAIN_PATTERN;

	const isWildcard = trimmed.startsWith('*.');
	const candidate = isWildcard ? trimmed.slice(2) : trimmed;
	if (!candidate) return null;

	try {
		const parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
		const hostname = parsed.hostname.toLowerCase();
		if (!hostname || hostname.includes('*')) return null;
		return isWildcard ? `*.${hostname}` : hostname;
	} catch {
		return null;
	}
}

function normalizeAllowedDomainsClaim(value: unknown): string[] {
	if (!Array.isArray(value)) return [ANY_DOMAIN_PATTERN];

	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') continue;
		const domainPattern = normalizeDomainPattern(item);
		if (!domainPattern) continue;
		if (domainPattern === ANY_DOMAIN_PATTERN) return [ANY_DOMAIN_PATTERN];
		if (!seen.has(domainPattern)) {
			seen.add(domainPattern);
			normalized.push(domainPattern);
		}
	}

	return normalized.length > 0 ? normalized : [ANY_DOMAIN_PATTERN];
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
	if (pattern === ANY_DOMAIN_PATTERN) return true;
	if (pattern.startsWith('*.')) {
		const base = pattern.slice(2);
		return domain.length > base.length && domain.endsWith(`.${base}`);
	}
	return domain === pattern;
}

function isDomainAllowed(
	requestDomain: string | null,
	allowedDomains: string[],
	allowNoReferrer: boolean
): boolean {
	if (!requestDomain) {
		return allowNoReferrer;
	}

	if (allowedDomains.includes(ANY_DOMAIN_PATTERN)) {
		return true;
	}

	return allowedDomains.some((pattern) => domainMatchesPattern(requestDomain, pattern));
}

async function hashPlaybackValue(value: string): Promise<string> {
	const data = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function verifyToken(
	token: string,
	secret: string,
	videoId: string,
	request: Request,
	organizationId?: string,
	resourceKey?: string
): Promise<boolean> {
	try {
		const secretKey = new TextEncoder().encode(secret);
		const { payload } = await jose.jwtVerify(token, secretKey, {
			issuer: JWT_ISSUER,
			audience: JWT_AUDIENCE,
		});
		const tokenSubject = typeof payload.sub === 'string' ? payload.sub : undefined;
		const tokenVideoId = typeof payload.video_id === 'string' ? payload.video_id : tokenSubject;
		if (tokenVideoId !== videoId) {
			console.warn('[playback-ip-debug] reject: video-id mismatch', {
				resourceKey: resourceKey || null,
				requestVideoId: videoId,
				tokenVideoId: tokenVideoId || null,
			});
			return false;
		}

		const tokenUserAgentHash = typeof payload.ua_hash === 'string' ? payload.ua_hash : undefined;
		const tokenAllowedDomains = normalizeAllowedDomainsClaim(payload.allowed_domains);
		const tokenAllowNoReferrer =
			typeof payload.allow_no_referrer === 'boolean' ? payload.allow_no_referrer : true;
		const requestPlaybackDomain = getRequestPlaybackDomain(request);
		const requestRawUserAgent = request.headers.get('user-agent');
		const requestNormalizedUserAgent = getUserAgentFromRequest(request);

		console.log('[playback-ip-debug] verify-start', {
			resourceKey: resourceKey || null,
			videoId,
			tokenVideoId: tokenVideoId || null,
			tokenSubject: tokenSubject || null,
			tokenHasUaHash: Boolean(tokenUserAgentHash),
			tokenAllowedDomains,
			tokenAllowNoReferrer,
			requestDomain: requestPlaybackDomain.domain,
			requestDomainSource: requestPlaybackDomain.source,
			requestReferer: requestPlaybackDomain.referer,
			requestOrigin: requestPlaybackDomain.origin,
			requestRawUserAgent,
			requestNormalizedUserAgent,
		});

		if (tokenUserAgentHash) {
			const requestUserAgentHash = await hashPlaybackValue(requestNormalizedUserAgent);
			const isUserAgentHashMatch = tokenUserAgentHash === requestUserAgentHash;

			console.log('[playback-ip-debug] verify-ua-compare', {
				resourceKey: resourceKey || null,
				requestNormalizedUserAgent,
				requestUserAgentHash,
				tokenUserAgentHash,
				isUserAgentHashMatch,
			});

			if (!isUserAgentHashMatch) {
				const userAgent = (requestRawUserAgent || '').toLowerCase();
				const isAppleCoreMedia = userAgent.includes('applecoremedia');
				
				// Common casting and smart TV user agents
				const isCastingDevice = userAgent.includes('crkey') || 
					userAgent.includes('chromecast') || 
					userAgent.includes('roku') || 
					userAgent.includes('tizen') || 
					userAgent.includes('webos') || 
					userAgent.includes('appletv');

				// Native players and casting devices change the User-Agent. 
				// If alternate playback device is detected, allow user-agent mismatch.
				if (isAppleCoreMedia || isCastingDevice) {
					console.log('[playback-ip-debug] allow: user-agent exception', {
						resourceKey: resourceKey || null,
						isAppleCoreMedia,
						isCastingDevice,
						requestRawUserAgent,
						requestNormalizedUserAgent,
					});
				} else {
					console.warn('[playback-ip-debug] reject: binding mismatch', {
						resourceKey: resourceKey || null,
						isAppleCoreMedia,
						isCastingDevice,
						requestRawUserAgent,
						requestNormalizedUserAgent,
						requestUserAgentHash,
						tokenUserAgentHash,
					});
					return false;
				}
			}
		} else {
			console.warn('[playback-ip-debug] warn: missing ua_hash claim, skipping ua binding', {
				resourceKey: resourceKey || null,
			});
		}

		const domainAllowed = isDomainAllowed(
			requestPlaybackDomain.domain,
			tokenAllowedDomains,
			tokenAllowNoReferrer
		);
		console.log('[playback-ip-debug] verify-domain-compare', {
			resourceKey: resourceKey || null,
			requestDomain: requestPlaybackDomain.domain,
			requestDomainSource: requestPlaybackDomain.source,
			tokenAllowedDomains,
			tokenAllowNoReferrer,
			domainAllowed,
		});
		if (!domainAllowed) {
			console.warn('[playback-ip-debug] reject: domain restriction mismatch', {
				resourceKey: resourceKey || null,
				requestDomain: requestPlaybackDomain.domain,
				requestDomainSource: requestPlaybackDomain.source,
				tokenAllowedDomains,
				tokenAllowNoReferrer,
			});
			return false;
		}

		if (organizationId) {
			const tokenOrgId = typeof payload.org_id === 'string' ? payload.org_id : undefined;
			const isOrgMatch = tokenOrgId === organizationId;
			if (!isOrgMatch) {
				console.warn('[playback-ip-debug] reject: org mismatch', {
					resourceKey: resourceKey || null,
					tokenOrgId: tokenOrgId || null,
					requestOrgId: organizationId,
				});
			}
			return isOrgMatch;
		}

		console.log('[playback-ip-debug] allow: token verified', {
			resourceKey: resourceKey || null,
			videoId,
		});
		return true;
	} catch (error) {
		console.error('[playback-ip-debug] reject: token verification error', {
			resourceKey: resourceKey || null,
			videoId,
			error: error instanceof Error ? error.message : String(error),
		});
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
		return `${prefix}${withTokenQuery(uri, token)}${suffix}`;
	});

	// 2. Rewrite #EXT-X-MEDIA URIs (audio/subtitle tracks - uses .*? for same reason)
	result = result.replace(/(#EXT-X-MEDIA:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		if (uri.startsWith('data:')) return match;
		return `${prefix}${withTokenQuery(uri, token)}${suffix}`;
	});

	// 3. Rewrite variant playlist references (.m3u8 files as standalone lines, with optional query)
	result = result.replace(/^[^#\s].*\.m3u8(?:\?.*)?$/gm, (uri) => {
		return withTokenQuery(uri, token);
	});

	// 4. Rewrite #EXT-X-MAP URIs (fMP4 init segments)
	result = result.replace(/(#EXT-X-MAP:.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
		return `${prefix}${withTokenQuery(uri, token)}${suffix}`;
	});

	// 5. Rewrite segment references (.mp4, .m4s, .ts media files as standalone lines, with optional query)
	// NOTE: Must use non-capturing groups (?:...) — capturing groups break the replace callback
	result = result.replace(/^[^#\s].*\.(?:mp4|m4s|ts)(?:\?.*)?$/gm, (uri) => {
		return withTokenQuery(uri, token);
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
			// 1. SETUP RANGE REQUEST (delegate parsing to R2 for standards-compliant behavior)
			const rangeHeader = request.headers.get('Range');
			const options: R2GetOptions = {};
			const hasRangeHeader = Boolean(rangeHeader);
			if (hasRangeHeader) {
				options.range = request.headers;
			}

			// 2. FETCH OBJECT (Optimized: Get metadata AND handle in one shot)
			const object = await env.TRANSCODED_BUCKET.get(key, options);

			if (!object) {
				return new Response('Not found', { status: 404, headers: corsHeaders });
			}



			// 3. CHECK AUTH
			const playbackPolicy = object.customMetadata?.['playback-policy'] || object.customMetadata?.playback_policy || 'public';
			const isSigned = playbackPolicy === 'signed';
			const organizationId = object.customMetadata?.['organization-id'];
			const videoId = extractVideoId(key);

			// All resources under a signed video require a valid token
			if (isSigned) {
				if (!token) {
					return new Response('Unauthorized: Token required', { status: 401, headers: corsHeaders });
				}

				if (!videoId) {
					return new Response('Invalid Path', { status: 400, headers: corsHeaders });
				}

				const isValid = await verifyToken(token, env.JWT_SECRET, videoId, request, organizationId, key);
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

			// Only playlists/keys need no-cache for signed videos.
			// Segments keep immutable caching — the token in the URL acts as cache key,
			// so different tokens = different cache entries (expired ones evict naturally).
			if (isSigned && isNoCacheResource(key)) {
				headers.set('Cache-Control', 'private, no-store, max-age=0');
				headers.set('Pragma', 'no-cache');
			}

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
      if (isSigned && token && (key.endsWith('.m3u8') || key.endsWith('.mpd'))) {
        const content = await object.text();
        let rewritten = content;

        if (key.endsWith('.m3u8')) {
          // 1. Rewrite #EXT-X-KEY, #EXT-X-MAP, and #EXT-X-MEDIA URIs (combined for efficiency)
          rewritten = rewritten.replace(/(#(?:EXT-X-KEY|EXT-X-MAP|EXT-X-MEDIA):.*?URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
            return `${prefix}${withTokenQuery(uri, token)}${suffix}`;
          });

          // 2. Rewrite standalone variant playlists and segments, safely capturing the optional \r
          rewritten = rewritten.replace(/^([^#\s][^\r\n]*\.(?:m3u8|mp4|m4s|ts)(?:\?[^\r\n]*)?)(\r?)$/gm, (match, uri, carriageReturn) => {
            return `${withTokenQuery(uri, token)}${carriageReturn}`;
          });
          
        } else if (key.endsWith('.mpd')) {
          // 3. DASH Rewriting: Catch media and initialization paths inside the XML
          rewritten = rewritten.replace(/(media=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
            return `${prefix}${withTokenQuery(uri, token)}${suffix}`;
          });
          rewritten = rewritten.replace(/(initialization=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
            return `${prefix}${withTokenQuery(uri, token)}${suffix}`;
          });
        }

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
			const resolvedRange = object.range ? resolveRange(object.range, totalSize) : null;

			if (hasRangeHeader && !resolvedRange) {
				headers.set('Content-Range', `bytes */${totalSize}`);
				headers.set('Content-Length', '0');
				return new Response(null, { status: 416, headers });
			}

			if (hasRangeHeader && resolvedRange && 'body' in object) {
				headers.set('Vary', 'Range');
				headers.set('Content-Range', `bytes ${resolvedRange.start}-${resolvedRange.end}/${totalSize}`);
				headers.set('Content-Length', resolvedRange.length.toString());

				return serveMetered(
					object.body,
					206,
					headers,
					ctx,
					env,
					organizationId,
					videoId,
					fileType
				);
			}

			headers.set('Content-Length', totalSize.toString());

			return serveMetered(
				object.body,
				200,
				headers,
				ctx,
				env,
				organizationId,
				videoId,
				fileType
			);
		} catch (error) {
			console.error('Error serving content:', error);
			return new Response('Internal server error', { status: 500, headers: corsHeaders });
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * Streams the response body while counting actual bytes transferred.
 * Uses pipeThrough to attach metering inline — no race conditions,
 * correct backpressure, and native cancellation handling.
 */
function serveMetered(
	objectBody: ReadableStream,
	status: number,
	headers: Headers,
	ctx: ExecutionContext,
	env: Env,
	organizationId: string | undefined,
	videoId: string | null,
	fileType: string
): Response {
	let bytesServed = 0;

	const meter = new TransformStream({
		transform(chunk, controller) {
			bytesServed += chunk.byteLength;
			controller.enqueue(chunk);
		},
		flush() {
			// Stream completed successfully — log total bytes
			logBandwidth(ctx, env, organizationId, videoId, bytesServed, fileType);
		},
		cancel() {
			// Client disconnected early — log whatever was actually sent
			if (bytesServed > 0) {
				logBandwidth(ctx, env, organizationId, videoId, bytesServed, fileType);
			}
		},
	});

	const metered = objectBody.pipeThrough(meter);

	return new Response(metered, { status, headers });
}
