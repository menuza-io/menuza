import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { db } from './client.ts'
import { ensureOrganizationLocationColumns } from './ensure-organization-location-columns.ts'
import { ensureOrganizationRoleAssignmentTriggers } from './ensure-organization-role-triggers.ts'

const packageDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
)

await db.run(sql`PRAGMA busy_timeout = 5000`)
await db.run(sql`PRAGMA journal_mode = WAL`)
// Legacy / concurrent migrate: table + columns before journal (0015 uses IF NOT EXISTS).
await ensureOrganizationLocationColumns()
await migrate(db, {
	migrationsFolder: path.join(packageDir, 'drizzle'),
})
await ensureOrganizationRoleAssignmentTriggers()
await ensureOrganizationLocationColumns()
console.log('✅ Database migrations completed successfully')
