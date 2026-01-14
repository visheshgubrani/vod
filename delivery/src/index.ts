/**
 * ClipMux Delivery Worker
 * Serves video content (HLS, thumbnails) from the transcoded R2 bucket.
 */

interface Env {
  TRANSCODED_BUCKET: R2Bucket // Ensure this matches your wrangler.toml
}

const MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.key': 'application/octet-stream', // Added for your encryption keys later
}

const CACHE_CONTROL = {
  playlist: 'public, max-age=5',
  segment: 'public, max-age=31536000, immutable',
  thumbnail: 'public, max-age=86400',
  default: 'public, max-age=3600',
}

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function getCacheControl(path: string): string {
  if (path.endsWith('.m3u8')) return CACHE_CONTROL.playlist
  if (path.endsWith('.ts')) return CACHE_CONTROL.segment
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return CACHE_CONTROL.thumbnail
  return CACHE_CONTROL.default
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
    const key = url.pathname.slice(1) // e.g., "videos/123/playlist.m3u8"

    if (!key) return new Response('Not found', { status: 404, headers: corsHeaders })

    try {
      const rangeHeader = request.headers.get('Range')
      
      // 1. Setup options for R2
      const options: R2GetOptions = {}

      // 2. Parse Range Header - store values for later use
      let rangeOffset: number | undefined
      let rangeLength: number | undefined

      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10)
          const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined
          rangeOffset = start
          rangeLength = end !== undefined ? (end - start + 1) : undefined
          // R2 expects 'offset' and 'length' (not end index)
          options.range = { 
            offset: rangeOffset, 
            length: rangeLength 
          }
        }
      }

      // 3. Fetch from R2
      const object = await env.TRANSCODED_BUCKET.get(key, options)

      if (!object) {
        return new Response('Not found', { status: 404, headers: corsHeaders })
      }

      // 4. Build Headers
      const headers = new Headers({
        'Content-Type': getMimeType(key),
        'Cache-Control': getCacheControl(key),
        'ETag': object.httpEtag,
        'Accept-Ranges': 'bytes',
        ...corsHeaders,
      })

      // 5. Handle Partial Content (206) vs Full Content (200)
      const isRangeRequest = rangeOffset !== undefined && 'body' in object
      
      if (isRangeRequest) {
        // We requested a range, R2 returned the chunk.
        // object.size is the TOTAL file size in R2, not just the chunk size.
        const totalSize = object.size 
        const start = rangeOffset!
        // Calculate the end byte position of this specific chunk
        // If we requested length, end is start + length - 1. If not, end is total - 1.
        let end = totalSize - 1
        if (rangeLength) {
            end = start + rangeLength - 1
        }
        
        // Safety: Clamp end to totalSize
        if (end > totalSize - 1) end = totalSize - 1

        const contentLength = end - start + 1

        headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`)
        headers.set('Content-Length', contentLength.toString())

        return new Response(object.body, { status: 206, headers })
      } 

      // 6. Standard Response (200)
      headers.set('Content-Length', object.size.toString())
      
      return new Response(object.body, { status: 200, headers })

    } catch (error) {
      console.error('Error serving content:', error)
      return new Response('Internal server error', { status: 500, headers: corsHeaders })
    }
  },
} satisfies ExportedHandler<Env>