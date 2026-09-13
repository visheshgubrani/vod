import '../lib/load-local-env'
import { createDb, dbDriverFromEnv } from '../lib/database'
import { user, organization, member } from './schema'

/**
 * Seed the first tenant.
 *
 * Goes through `createDb`/`dbDriverFromEnv` like every other database entrypoint,
 * so it honours `DB_DRIVER`. It used to construct a Neon client directly and
 * ignore the driver entirely — which meant `pnpm db:seed` could not seed the
 * Docker/Node Postgres that `.dev.vars.example` and `server/Dockerfile` both
 * describe, while migrations against the same database worked fine.
 */
const run = async () => {
  if (!process.env.DATABASE_URL) throw new Error('No DB URL')

  const db = createDb(process.env.DATABASE_URL, dbDriverFromEnv(process.env.DB_DRIVER))

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
