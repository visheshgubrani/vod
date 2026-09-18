import '../lib/load-local-env'
import { createDb } from '../lib/database'
import { user, organization, member } from './schema'

/**
 * Seed the first tenant.
 *
 * Goes through `createDb` like every other database entrypoint, so it uses the
 * same postgres-js client as the API.
 */
const run = async () => {
  if (!process.env.DATABASE_URL) throw new Error('No DB URL')

  const db = createDb(process.env.DATABASE_URL)

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
      name: 'ClipMux Local',
      slug: 'clipmux-local', // Unique slug
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

run().then(
  () => process.exit(0),
  (err) => {
    console.error('❌ Seed failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
