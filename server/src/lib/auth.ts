import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './database'
import { admin, organization } from 'better-auth/plugins'

const trustedOrigins: string[] = [
  'https://clipmux.com',
  'https://www.clipmux.com',
  'https://clipmux-ui.pages.dev',
  'https://*.clipmux-ui.pages.dev',
  'https://*.pages.dev',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]

if (typeof process !== 'undefined' && process.env?.FRONTEND_URL) {
  trustedOrigins.push(...process.env.FRONTEND_URL.split(',').map((s) => s.trim()))
}

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


