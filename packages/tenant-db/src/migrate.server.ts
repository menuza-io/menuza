import { getTenantDb } from './db.server.ts'
import { applyTenantMigrations } from './migrations.ts'

const migrationLocks = new Map<string, Promise<unknown>>()

/**
 * Provisions a database for a given tenant.
 * Applies the latest Drizzle migrations to ensure the schema is up to date.
 * Safe to call again if the schema is already present (republish / retry).
 *
 * Opening the connection already applies pending migrations (see
 * `getTenantDbFromFilesystem`); this wrapper adds the create-if-missing
 * behavior and per-org serialization used by the provisioning routes.
 */
export async function provisionTenantDb(orgId: string) {
	if (!migrationLocks.has(orgId)) {
		const promise = (async () => {
			try {
				const db = await getTenantDb(orgId, { createIfMissing: true })
				console.info(`Provisioning tenant DB for orgId: ${orgId}`)
				await applyTenantMigrations(db, orgId)
				console.info(`Successfully provisioned tenant DB for orgId: ${orgId}`)
				return db
			} finally {
				migrationLocks.delete(orgId)
			}
		})()
		migrationLocks.set(orgId, promise)
	}
	return await migrationLocks.get(orgId)
}
