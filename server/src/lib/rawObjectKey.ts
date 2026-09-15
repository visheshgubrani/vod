/**
 * Object keys for the raw upload bucket.
 *
 * The original filename stays on the video title. Only a SigV4-safe name
 * goes in the key: R2 rejects CreateMultipartUpload when the key contains
 * apostrophes, `#`, brackets or other characters whose URI encoding
 * disagrees between the AWS SDK and R2.
 */

const UNSAFE_OBJECT_CHARS = /[^A-Za-z0-9._-]+/g
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,8}$/
const MAX_STEM_LENGTH = 180

export function buildRawObjectKey(
  organizationId: string | null | undefined,
  filename: string,
): { fileId: string; key: string } {
  const fileId = crypto.randomUUID()
  const org = organizationId || 'org_default'
  const safeName = sanitizeObjectFilename(filename, fileId)
  return { fileId, key: `${org}/raw/${fileId}/${safeName}` }
}

function takeBasename(filename: string): string {
  const parts = filename.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

function sanitizeObjectFilename(filename: string, fileId: string): string {
  const base = takeBasename(filename)
  const dot = base.lastIndexOf('.')
  let stem = base
  let ext = ''
  if (dot >= 0) {
    const candidate = base.slice(dot + 1)
    if (SAFE_EXTENSION.test(candidate)) {
      stem = base.slice(0, dot)
      ext = candidate
    }
  }

  let safe = stem.replace(UNSAFE_OBJECT_CHARS, '_')
  safe = safe.replace(/_+/g, '_')
  safe = safe.replace(/^[_.]+|[_.]+$/g, '')
  if (safe.length > MAX_STEM_LENGTH) {
    safe = safe.slice(0, MAX_STEM_LENGTH).replace(/[_.]+$/g, '')
  }

  if (!safe) {
    return ext ? `${fileId}.${ext}` : `${fileId}.bin`
  }
  return ext ? `${safe}.${ext}` : safe
}
