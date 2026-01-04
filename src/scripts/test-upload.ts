import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { eq } from 'drizzle-orm'
import { session, user } from '../db/schema'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Ensure .env is loaded even if script is run from a different cwd
const __dirname = fileURLToPath(new URL('.', import.meta.url))
config({ path: resolve(__dirname, '../../.env') })

// 1. SETUP
const API_URL = 'http://localhost:8787'
const DATABASE_URL = process.env.DATABASE_URL
console.log(DATABASE_URL)

if (!DATABASE_URL) throw new Error('❌ DATABASE_URL is missing from .env')

const sql = neon(DATABASE_URL)
const db = drizzle(sql)

async function run() {
  console.log('🧪 Starting Upload Test...')

  // 2. CREATE A FAKE SESSION (The "Backdoor")
  const testToken = 'test-token-' + crypto.randomUUID()
  const adminUserId = 'user_admin' // Must match your seed.ts

  // Ensure user exists (just in case)
  const [admin] = await db.select().from(user).where(eq(user.id, adminUserId))
  if (!admin)
    throw new Error("❌ User 'user_admin' not found. Did you run seed.ts?")

  // Insert valid session directly into DB
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 1) // Valid for 1 day

  await db.insert(session).values({
    id: crypto.randomUUID(),
    userId: adminUserId,
    token: testToken,
    expiresAt: expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    // Important: Link to the organization we seeded
    activeOrganizationId: 'org_default',
  })

  console.log(`✅ Generated Session Token: ${testToken}`)

  // 3. CALL THE API (Get Upload URL)
  console.log('📡 Requesting Presigned URL from Worker...')

  const response = await fetch(`${API_URL}/api/upload/url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Pass the token as a Cookie (how Better Auth expects it)
      Cookie: `better-auth.session_token=${testToken}`,
      // Pass origin to satisfy CORS
      Origin: 'http://localhost:3000',
    },
    body: JSON.stringify({
      filename: 'test-video.mp4',
      contentType: 'video/mp4',
      size: 1024, // 1KB dummy file
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`❌ API Failed: ${response.status} ${text}`)
  }

  const data: any = await response.json()
  console.log('✅ Got Presigned URL:', data.uploadUrl.substring(0, 50) + '...')

  // 4. TEST THE UPLOAD (Actually put file in R2)
  console.log('🚀 Uploading dummy file to R2...')

  const uploadRes = await fetch(data.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
    },
    body: 'THIS IS DUMMY VIDEO CONTENT',
  })

  if (!uploadRes.ok) {
    throw new Error(
      `❌ R2 Upload Failed: ${uploadRes.status} ${uploadRes.statusText}`
    )
  }

  console.log('🎉 SUCCESS! File uploaded to R2.')
  console.log(`📂 R2 Key: ${data.key}`)
}

run().catch(console.error)
