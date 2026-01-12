import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from '../db/schema'

const databaseUrl = process.env.DATABASE_URL!

export const db = drizzle(databaseUrl, { schema })
