import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { db } from './client.ts'
import { ensureOrganizationRoleAssignmentTriggers } from './ensure-organization-role-triggers.ts'

const packageDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
)

await db.run(sql`PRAGMA busy_timeout = 5000`)
await db.run(sql`PRAGMA journal_mode = WAL`)
await migrate(db, {
	migrationsFolder: path.join(packageDir, 'drizzle'),
})
await ensureOrganizationRoleAssignmentTriggers()
console.log('✅ Database migrations completed successfully')
