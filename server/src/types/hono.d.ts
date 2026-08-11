import type { auth } from '../lib/auth'
import type { Logger } from '../lib/logger'

declare module 'hono' {
  interface ContextVariableMap {
    user: typeof auth.$Infer.Session.user
    session: typeof auth.$Infer.Session.session
    organizationId?: string | null
    apiKeyId?: string
    userId?: string
    logger?: Logger
    requestId?: string
  }
}
