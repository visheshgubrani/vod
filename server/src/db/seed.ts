import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { user, organization, member } from './schema'
import 'dotenv/config'

const run = async () => {
  if (!process.env.DATABASE_URL) throw new Error('No DB URL')

  const sql = neon(process.env.DATABASE_URL)
  const db = drizzle(sql)

  console.log('🌱 Seeding First Tenant...')

  // 1. Create User
  const newUserId = 'user_admin'
  await db
    .insert(user)
    .values({
      id: newUserId,
      name: 'Admin Dev',
      email: 'admin@localhost',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing()

  // 2. Create Organization
  const newOrgId = 'org_default'
  await db
    .insert(organization)
    .values({
      id: newOrgId,
      name: 'OpenVOD Local',
      slug: 'openvod-local', // Unique slug
      createdAt: new Date(),
    })
    .onConflictDoNothing()

  // 3. Link them (Make user the OWNER)
  await db
    .insert(member)
    .values({
      id: 'mem_1',
      userId: newUserId,
      organizationId: newOrgId,
      role: 'owner',
      createdAt: new Date(),
    })
    .onConflictDoNothing()

  console.log(`✅ Seeded! \nUser ID: ${newUserId} \nOrg ID: ${newOrgId}`)
}

run()
