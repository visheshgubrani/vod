import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from '../db/schema'

// Instead of exporting a static 'db', we export a function
export const getDb = (databaseUrl: string) => {
  const sql = neon(databaseUrl)
  return drizzle(sql, { schema })
}
