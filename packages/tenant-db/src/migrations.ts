import crypto from 'node:crypto'
import fs from 'node:fs'
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
const LEGACY_BASELINE_TAG = '0000_initial'
const LEGACY_BASELINE_MILLIS = 1787549109274
const LEGACY_BASELINE_TABLES = [
	'customers',
	'marketing_campaigns',
	'marketing_journeys',
	'journey_runs',
	'journey_step_executions',
	'marketing_messages',
] as const

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

function isLegacyBaselineCollision(error: unknown) {
	return collectErrorMessages(error).some((message) =>
		/\btable customers already exists\b/i.test(message),
	)
}

async function recordLegacyBaselineIfComplete(db: TenantDatabase) {
	const tables = await db.all<{ name: string }>(
		sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
	)
	if (
		!LEGACY_BASELINE_TABLES.every((table) =>
			tables.some((row) => row.name === table),
		)
	) {
		return false
	}

	await db.run(sql`
		CREATE TABLE IF NOT EXISTS __drizzle_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			hash text NOT NULL,
			created_at numeric
		)
	`)
	const existing = await db.get<{ count: number }>(
		sql`SELECT count(*) AS count FROM __drizzle_migrations`,
	)
	if ((existing?.count ?? 0) !== 0) return false

	const migrationPath = path.join(
		tenantMigrationsFolder(),
		`${LEGACY_BASELINE_TAG}.sql`,
	)
	const hash = crypto
		.createHash('sha256')
		.update(fs.readFileSync(migrationPath))
		.digest('hex')
	await db.run(sql`
		INSERT INTO __drizzle_migrations (hash, created_at)
		VALUES (${hash}, ${LEGACY_BASELINE_MILLIS})
	`)
	return true
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
			if (
				isLegacyBaselineCollision(error) &&
				(await recordLegacyBaselineIfComplete(db))
			) {
				continue
			}

			throw error
		}
	}
}
