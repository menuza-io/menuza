import fs from 'node:fs'
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

const lockPath = path.join(packageDir, 'db/.migrate.lock')

async function withMigrateLock<T>(fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + 120_000
	while (Date.now() < deadline) {
		try {
			fs.mkdirSync(lockPath)
			fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid))
			break
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
	}
	if (!fs.existsSync(lockPath)) {
		throw new Error('Could not acquire database migrate lock')
	}
	try {
		return await fn()
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true })
	}
}

await withMigrateLock(async () => {
	await db.run(sql`PRAGMA busy_timeout = 5000`)
	await db.run(sql`PRAGMA journal_mode = WAL`)
	// Table + widen legacy rows before journal (0015 only adds indexes + org columns).
	await ensureOrganizationLocationColumns()
	await migrate(db, {
		migrationsFolder: path.join(packageDir, 'drizzle'),
	})
	await ensureOrganizationRoleAssignmentTriggers()
	await ensureOrganizationLocationColumns()
})
console.log('✅ Database migrations completed successfully')
