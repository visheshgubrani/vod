import type { Auth } from '../lib/auth'
import type { Logger } from '../lib/logger'
import type { RuntimeCapabilities } from '../runtime/types'

declare module 'hono' {
  interface ContextVariableMap {
    user: Auth['$Infer']['Session']['user']
    session: Auth['$Infer']['Session']['session']
    /**
     * The active composition root. Set by the first middleware in `app.ts` and
     * the only way request handlers reach configuration, clients, the limiter,
     * the analytics sink and background work.
     */
    runtime: RuntimeCapabilities
    organizationId?: string | null
    apiKeyId?: string
    userId?: string
    logger?: Logger
    requestId?: string
  }
}
