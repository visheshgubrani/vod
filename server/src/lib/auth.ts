/**
 * better-auth instance factory.
 *
 * Was a module-scope `betterAuth({...})` reading `process.env` with `|| ''`
 * fallbacks for the OAuth client ids and a hardcoded `http://localhost:8787`
 * baseURL. On Workers that instance was built at isolate start, so a credential
 * arriving only as a binding produced an auth instance with empty client ids and
 * a localhost base — a misconfiguration that fails into a broken login instead of
 * an error. Now the composition root passes the resolved config and the installed
 * database, and every input is visible at the call site.
 */

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, organization } from 'better-auth/plugins'
import type { Db } from './database'
import type { OpenVodConfig } from './config'

const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]

export type Auth = ReturnType<typeof createAuth>

export function createAuth(db: Db, config: OpenVodConfig) {
  // Trusted origins come exclusively from configuration (FRONTEND_URL /
  // CORS_ORIGINS) plus local development defaults — the same list CORS uses.
  const trustedOrigins: string[] = [...LOCAL_DEV_ORIGINS, ...config.corsPatterns]

  return betterAuth({
    ...(config.betterAuthSecret ? { secret: config.betterAuthSecret } : {}),
    database: drizzleAdapter(db, {
      provider: 'pg',
    }),
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes — session served from cookie, skips DB
      },
    },
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        prompt: 'select_account',
        clientId: config.oauth.google.clientId,
        clientSecret: config.oauth.google.clientSecret,
      },
      github: {
        clientId: config.oauth.github.clientId,
        clientSecret: config.oauth.github.clientSecret,
      },
    },
    trustedOrigins,
    plugins: [admin(), organization()],
    baseURL: config.betterAuthUrl ?? 'http://localhost:8787',
  })
}
