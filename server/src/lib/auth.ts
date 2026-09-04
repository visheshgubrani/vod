import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './database'
import { parseOriginList } from './config'
import { admin, organization } from 'better-auth/plugins'

const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]

// Trusted origins come exclusively from environment configuration
// (FRONTEND_URL / CORS_ORIGINS) plus local development defaults.
const trustedOrigins: string[] = [
  ...LOCAL_DEV_ORIGINS,
  ...parseOriginList(
    typeof process !== 'undefined' ? process.env?.FRONTEND_URL : undefined,
  ),
  ...parseOriginList(
    typeof process !== 'undefined' ? process.env?.CORS_ORIGINS : undefined,
  ),
]

export const auth = betterAuth({
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
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    },
  },
  trustedOrigins,
  plugins: [admin(), organization()],
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:8787',
})


