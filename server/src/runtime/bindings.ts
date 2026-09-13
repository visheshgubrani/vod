import type { Bindings } from '../types'
import type { EnvLike } from '../lib/config'

/**
 * Narrow Workers bindings to the string map the configuration layer reads.
 *
 * Bindings are a mixed bag by design — secrets and vars are strings, the
 * Analytics Engine dataset is an object — while `loadConfig` wants a
 * `Record<string, string | undefined>`. This is the one place that conversion
 * happens, and it is why no `as unknown as Bindings` cast is needed in either
 * direction any more.
 *
 * Non-string bindings (the Analytics Engine dataset) are dropped here and read
 * directly by the Workers composition root, which is the only code that knows
 * their type.
 */
export function stringBindings(env: Bindings | Record<string, unknown> | undefined): EnvLike {
  const out: EnvLike = {}
  if (!env) return out
  for (const key of Object.keys(env)) {
    const value = (env as Record<string, unknown>)[key]
    if (typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}
