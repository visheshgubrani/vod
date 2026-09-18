/**
 * Pure helpers for patching text configuration files.
 */

/**
 * Replace the first `"bucket_name": "<name>"` value in delivery/wrangler.jsonc.
 * Returns the new text, or null when no bucket_name entry is found.
 */
export function patchBucketName(wranglerText: string, bucket: string): string | null {
  const bucketNamePattern = /("bucket_name"\s*:\s*")[^"]+(")/
  if (!bucketNamePattern.test(wranglerText)) return null

  return wranglerText.replace(
    bucketNamePattern,
    (_whole, prefix: string, suffix: string) => `${prefix}${bucket}${suffix}`,
  )
}

const REQUIRED_DATASETS = [
  { binding: 'USAGE_ANALYTICS', dataset: 'bandwidth_usage' },
  { binding: 'PLAYBACK_ANALYTICS', dataset: 'playback_events' },
] as const

type DatasetBinding = (typeof REQUIRED_DATASETS)[number]

/**
 * Add, repair, or remove the Analytics Engine dataset bindings in
 * delivery/wrangler.jsonc.
 *
 * Both `USAGE_ANALYTICS` (bandwidth_usage) and `PLAYBACK_ANALYTICS`
 * (playback_events) are provisioned together when analytics are on, and both
 * are omitted when analytics are off. Existing datasets in the account are
 * never deleted. Edits are JSONC-aware so a compact file stays valid JSON
 * and a bandwidth-only array is reconciled rather than left incomplete.
 */
export function patchAnalyticsEngineDatasets(wranglerText: string, enabled: boolean): string {
  if (!enabled) return removeArrayProperty(wranglerText, 'analytics_engine_datasets')

  const loc = findArrayProperty(wranglerText, 'analytics_engine_datasets')
  if (!loc) return insertDatasetsProperty(wranglerText)

  const inner = wranglerText.slice(loc.open + 1, loc.close)
  const present = bindingsIn(inner)
  const missing = REQUIRED_DATASETS.filter((item) => !present.has(item.binding))
  if (missing.length === 0) return wranglerText
  return insertBindings(wranglerText, loc, missing)
}

function skipTrivia(text: string, index: number): number {
  let i = index
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    break
  }
  return i
}

function findMatchingBracket(text: string, open: number): number | null {
  const openCh = text[open]
  const closeCh = openCh === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escape = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === undefined) break
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 1
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === openCh) depth += 1
    else if (ch === closeCh) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

function findArrayProperty(
  text: string,
  key: string,
): { keyStart: number; open: number; close: number } | null {
  const match = new RegExp(`"${key}"\\s*:`).exec(text)
  if (!match) return null
  const open = skipTrivia(text, match.index + match[0].length)
  if (text[open] !== '[') return null
  const close = findMatchingBracket(text, open)
  if (close === null) return null
  return { keyStart: match.index, open, close }
}

function bindingsIn(inner: string): Set<string> {
  const found = new Set<string>()
  for (const match of inner.matchAll(/"binding"\s*:\s*"([^"]+)"/g)) {
    if (match[1]) found.add(match[1])
  }
  return found
}

function fileIndent(text: string): string {
  return text.includes('\t"r2_buckets"') || text.includes('\t"name"') ? '\t' : '  '
}

function datasetsBlock(indent: string): string {
  const inner = indent === '\t' ? '\t\t' : `${indent}  `
  return (
    `${indent}"analytics_engine_datasets": [\n` +
    `${inner}{ "binding": "USAGE_ANALYTICS", "dataset": "bandwidth_usage" },\n` +
    `${inner}{ "binding": "PLAYBACK_ANALYTICS", "dataset": "playback_events" }\n` +
    `${indent}]`
  )
}

function insertDatasetsProperty(text: string): string {
  const block = datasetsBlock(fileIndent(text))
  const r2 = findArrayProperty(text, 'r2_buckets')
  if (r2) {
    const afterArray = skipTrivia(text, r2.close + 1)
    if (text[afterArray] === ',') {
      const afterComma = skipTrivia(text, afterArray + 1)
      if (afterComma >= text.length || text[afterComma] === '}') {
        return text.slice(0, afterArray) + ',\n' + block + text.slice(afterComma)
      }
      return text.slice(0, afterArray + 1) + '\n' + block + ',\n' + text.slice(afterComma)
    }
    return text.slice(0, r2.close + 1) + ',\n' + block + text.slice(r2.close + 1)
  }
  const lastBrace = text.lastIndexOf('}')
  if (lastBrace < 0) return text
  return text.slice(0, lastBrace) + ',\n' + block + '\n' + text.slice(lastBrace)
}

function insertBindings(
  text: string,
  loc: { open: number; close: number },
  missing: readonly DatasetBinding[],
): string {
  const inner = text.slice(loc.open + 1, loc.close)
  const compact = !inner.includes('\n')
  const formatted = missing.map(
    (item) => `{ "binding": "${item.binding}", "dataset": "${item.dataset}" }`,
  )
  const trimmed = inner.trim()
  if (trimmed === '') {
    const insertion = compact
      ? formatted.join(', ')
      : `\n${fileIndent(text)}  ${formatted.join(`,\n${fileIndent(text)}  `)}\n${fileIndent(text)}`
    return text.slice(0, loc.open + 1) + insertion + text.slice(loc.close)
  }

  let insertAt = loc.close
  while (insertAt > loc.open && /[ \t\n\r]/.test(text[insertAt - 1] ?? '')) insertAt -= 1
  const needsComma = text[insertAt - 1] !== ','
  if (compact) {
    const insertion = (needsComma ? ', ' : '') + formatted.join(', ')
    return text.slice(0, insertAt) + insertion + text.slice(loc.close)
  }

  const closeLineStart = text.lastIndexOf('\n', loc.close)
  const closingIndent = text.slice(closeLineStart + 1, loc.close).match(/^[ \t]*/)?.[0] ?? ''
  const itemIndent = closingIndent + (closingIndent.includes('\t') ? '\t' : '  ')
  const pretty = formatted.map((item) => `${itemIndent}${item}`).join(',\n')
  const insertion = `${needsComma ? ',' : ''}\n${pretty}\n${closingIndent}`
  return text.slice(0, insertAt) + insertion + text.slice(loc.close)
}

function removeArrayProperty(text: string, key: string): string {
  const loc = findArrayProperty(text, key)
  if (!loc) return text
  let start = loc.keyStart
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1
  let end = skipTrivia(text, loc.close + 1)
  if (text[end] === ',') {
    end += 1
    if (text[end] === '\r' && text[end + 1] === '\n') end += 2
    else if (text[end] === '\n') end += 1
  } else if (text[end] === '\r' && text[end + 1] === '\n') {
    end += 2
  } else if (text[end] === '\n') {
    end += 1
  }
  return text.slice(0, start) + text.slice(end)
}
