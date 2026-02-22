/**
 * One-time migration: add index on video.organization_id
 * Run with: npx tsx src/scripts/add-video-org-index.ts
 */
import 'dotenv/config'
import { neon } from '@neondatabase/serverless'

async function main() {
  const sql = neon(process.env.DATABASE_URL!)

  console.log('Creating index video_organizationId_idx on video(organization_id)...')

  await sql`
    CREATE INDEX IF NOT EXISTS "video_organizationId_idx"
    ON "video" ("organization_id")
  `

  console.log('✅ Done! Index created successfully.')
}

main().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
