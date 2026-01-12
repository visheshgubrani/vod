import type { auth } from '../lib/auth'

declare module 'hono' {
  interface ContextVariableMap {
    user: typeof auth.$Infer.Session.user
    session: typeof auth.$Infer.Session.session
  }
}
