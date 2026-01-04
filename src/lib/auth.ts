import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { getDb } from './database' // Import the function we just made
import { admin, organization } from 'better-auth/plugins'
import { Bindings } from '../types'

// We export a FUNCTION instead of an OBJECT
export const createAuth = (env: Bindings) => {
  const db = getDb(env.DATABASE_URL)

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
    }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        prompt: 'select_account',
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    trustedOrigins: [env.FRONTEND_URL || 'http://localhost:3000'],
    plugins: [admin(), organization()],

    baseURL: env.FRONTEND_URL,
  })
}
