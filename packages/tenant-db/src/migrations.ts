import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/libsql/migrator'
import type { TenantDatabase } from './types.ts'

/**
 * Shared tenant-DB migration runner.
 *
 * Both the Node/OCI filesystem path and the Cloudflare Durable Object path must
 * apply migrations when a tenant database is first opened, because existing
 * `tenant_{orgId}.db` files are long-lived: adding a column to an existing table
 * would otherwise break column-enumerating reads (`select().from(table)`) until
 * the org happened to be re-provisioned.
 */

const MIGRATION_RETRIES = 5
const MIGRATION_RETRY_DELAY_MS = 100

export function tenantMigrationsFolder(): string {
	const currentFile = fileURLToPath(import.meta.url)
	const packageRoot = path.dirname(path.dirname(currentFile))
	return path.join(packageRoot, 'drizzle')
}

function collectErrorMessages(error: unknown): string[] {
	const parts: string[] = []
	let current: unknown = error
	for (let i = 0; i < 5 && current; i++) {
		if (current instanceof Error) {
			parts.push(current.message)
			current = (current as { cause?: unknown }).cause
		} else {
			parts.push(String(current))
			break
		}
	}
	return parts
}

function isSqliteBusy(error: unknown) {
	return collectErrorMessages(error).some(
		(message) =>
			message.includes('SQLITE_BUSY') || message.includes('database is locked'),
	)
}

function isAlreadyAppliedError(error: unknown) {
	return collectErrorMessages(error).some((message) =>
		/already exists/i.test(message),
	)
}

async function hasCustomersTable(db: TenantDatabase) {
	const row = await db.get<{ name: string }>(
		sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'customers' LIMIT 1`,
	)
	return Boolean(row?.name)
}

/**
 * Apply pending Drizzle migrations to a tenant database. Idempotent and safe to
 * call on every connection open (Drizzle tracks applied migrations).
 */
export async function applyTenantMigrations(
	db: TenantDatabase,
	orgId: string,
): Promise<void> {
	const migrationsFolder = tenantMigrationsFolder()
	let retries = MIGRATION_RETRIES
	let delay = MIGRATION_RETRY_DELAY_MS

	while (true) {
		try {
			await migrate(db, { migrationsFolder })
			return
		} catch (error) {
			if (retries > 0 && isSqliteBusy(error)) {
				console.warn(
					`SQLITE_BUSY during migration for ${orgId}, retrying in ${delay}ms...`,
				)
				await new Promise((resolve) => setTimeout(resolve, delay))
				retries--
				delay *= 2
				continue
			}

			if (isAlreadyAppliedError(error) && (await hasCustomersTable(db))) {
				console.info(
					`Tenant DB for ${orgId} already migrated; treating as up to date`,
				)
				return
			}

			throw error
		}
	}
}
