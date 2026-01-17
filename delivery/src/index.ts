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

import * as jose from 'jose'

interface Env {
  TRANSCODED_BUCKET: R2Bucket
  JWT_SECRET: string
}

const MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.key': 'application/octet-stream',
}

const CACHE_CONTROL = {
  playlist: 'public, max-age=5',
  segment: 'public, max-age=31536000, immutable',
  thumbnail: 'public, max-age=86400',
  key: 'private, no-store, max-age=0',
  default: 'public, max-age=3600',
}

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function getCacheControl(path: string): string {
  if (path.endsWith('.m3u8')) return CACHE_CONTROL.playlist
  if (path.endsWith('.ts')) return CACHE_CONTROL.segment
  if (path.endsWith('.key')) return CACHE_CONTROL.key
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return CACHE_CONTROL.thumbnail
  return CACHE_CONTROL.default
}

function extractVideoId(path: string): string | null {
  const match = path.match(/^videos\/([^\/]+)\//)
  return match ? match[1] : null
}

async function verifyToken(token: string, secret: string, videoId: string): Promise<boolean> {
  try {
    const secretKey = new TextEncoder().encode(secret)
    const { payload } = await jose.jwtVerify(token, secretKey)
    return payload.video_id === videoId || payload.sub === videoId
  } catch {
    return false
  }
}

/**
 * Rewrite HLS playlist to include token in:
 * 1. #EXT-X-KEY URIs (for encryption key access)
 * 2. #EXT-X-MEDIA URIs (for audio/subtitle tracks)
 * 3. Variant playlist URIs (.m3u8 references in master playlist)
 */
function rewritePlaylist(content: string, token: string): string {
  let result = content
  
  // Debug: log original content (full content for debugging)
  console.log('=== PLAYLIST REWRITE DEBUG ===')
  console.log('Original content lines:', content.split('\n').length)
  console.log('FULL PLAYLIST CONTENT:')
  console.log(content)
  console.log('--- END CONTENT ---')
  
  // 1. Rewrite #EXT-X-KEY URIs (uses .*? to skip past any quoted attributes before URI)
  result = result.replace(
    /(#EXT-X-KEY:.*?URI=")([^"]+)(")/g,
    (match, prefix, uri, suffix) => {
      const separator = uri.includes('?') ? '&' : '?'
      console.log(`Rewriting KEY URI: ${uri}`)
      return `${prefix}${uri}${separator}token=${token}${suffix}`
    }
  )
  
  // 2. Rewrite #EXT-X-MEDIA URIs (audio/subtitle tracks - uses .*? for same reason)
  result = result.replace(
    /(#EXT-X-MEDIA:.*?URI=")([^"]+)(")/g,
    (match, prefix, uri, suffix) => {
      const separator = uri.includes('?') ? '&' : '?'
      console.log(`Rewriting MEDIA URI: ${uri}`)
      return `${prefix}${uri}${separator}token=${token}${suffix}`
    }
  )
  
  // 3. Rewrite variant playlist references (.m3u8 files as standalone lines)
  const m3u8Regex = /^([^#\s].*\.m3u8)$/gm
  const matches = content.match(m3u8Regex)
  console.log('Found .m3u8 references:', matches)
  
  result = result.replace(
    m3u8Regex,
    (uri) => {
      const separator = uri.includes('?') ? '&' : '?'
      console.log(`Rewriting m3u8 ref: ${uri} -> ${uri}${separator}token=...`)
      return `${uri}${separator}token=${token}`
    }
  )
  
  console.log('=== END PLAYLIST REWRITE ===')
  return result
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders })
    }

    const url = new URL(request.url)
    const key = url.pathname.slice(1)
    const token = url.searchParams.get('token')

    if (!key) return new Response('Not found', { status: 404, headers: corsHeaders })

    try {
      // 1. SETUP RANGE REQUEST (Standard)
      const rangeHeader = request.headers.get('Range')
      const options: R2GetOptions = {}
      let rangeOffset: number | undefined
      let rangeLength: number | undefined

      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10)
          const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined
          rangeOffset = start
          rangeLength = end !== undefined ? (end - start + 1) : undefined
          options.range = { offset: rangeOffset, length: rangeLength }
        }
      }

      // 2. FETCH OBJECT (Optimized: Get metadata AND handle in one shot)
      const object = await env.TRANSCODED_BUCKET.get(key, options)

      if (!object) {
        return new Response('Not found', { status: 404, headers: corsHeaders })
      }

      // --- DEBUG LOG START ---
      console.log(`Checking ${key}`);
      console.log("Metadata found:", JSON.stringify(object.customMetadata));
      // --- DEBUG LOG END ---

      // 3. CHECK AUTH (Using the metadata we just fetched!)
      const playbackPolicy = object.customMetadata?.['playback-policy'] || object.customMetadata?.playback_policy || 'public'
      const isSigned = playbackPolicy === 'signed'
      
      // Determine if we need to enforce security
      // We check .key files specifically because they are the "Master Lock"
      const isProtectedResource = key.endsWith('.m3u8') || key.endsWith('.key')

      if (isSigned && isProtectedResource) {
        if (!token) {
          return new Response('Unauthorized: Token required', { status: 401, headers: corsHeaders })
        }
        
        const videoId = extractVideoId(key)
        if (!videoId) {
           return new Response('Invalid Path', { status: 400, headers: corsHeaders })
        }

        const isValid = await verifyToken(token, env.JWT_SECRET, videoId)
        if (!isValid) {
          return new Response('Unauthorized: Invalid token', { status: 401, headers: corsHeaders })
        }
      }

      // 4. PREPARE HEADERS
      const headers = new Headers({
        'Content-Type': getMimeType(key),
        'Cache-Control': getCacheControl(key),
        'ETag': object.httpEtag,
        'Accept-Ranges': 'bytes',
        ...corsHeaders,
      })

      // 5. MANIFEST REWRITING
      if (isSigned && key.endsWith('.m3u8') && token) {
        const content = await object.text()
        const rewritten = rewritePlaylist(content, token)
        
        // Ensure signed manifests are NEVER cached by the browser/CDN
        headers.set('Cache-Control', 'private, no-cache, no-store, max-age=0')
        headers.set('Content-Length', new TextEncoder().encode(rewritten).length.toString())
        
        return new Response(rewritten, { status: 200, headers })
      }

      // 6. SERVE BODY (Range or Full)
      const isRangeRequest = rangeOffset !== undefined && 'body' in object
      
      if (isRangeRequest) {
        const totalSize = object.size 
        const start = rangeOffset!
        let end = totalSize - 1
        if (rangeLength) {
          end = start + rangeLength - 1
        }
        if (end > totalSize - 1) end = totalSize - 1

        const contentLength = end - start + 1
        headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`)
        headers.set('Content-Length', contentLength.toString())

        return new Response(object.body, { status: 206, headers })
      } 

      headers.set('Content-Length', object.size.toString())
      return new Response(object.body, { status: 200, headers })

    } catch (error) {
      console.error('Error serving content:', error)
      return new Response('Internal server error', { status: 500, headers: corsHeaders })
    }
  },
} satisfies ExportedHandler<Env>