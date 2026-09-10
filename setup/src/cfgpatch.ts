/**
 * Pure helpers for patching text configuration files.
 */

/**
 * Replace the first `"bucket_name": "<name>"` value in delivery/wrangler.jsonc.
 * Returns the new text, or null when no bucket_name entry is found.
 */
export function patchBucketName(wranglerText: string, bucket: string): string | null {
  const result = wranglerText.replace(
    /("bucket_name"\s*:\s*")[^"]+(")/,
    (_whole, prefix: string, suffix: string) => `${prefix}${bucket}${suffix}`,
  )
  return result === wranglerText ? null : result
}
