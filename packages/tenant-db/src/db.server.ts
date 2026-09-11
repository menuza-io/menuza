import path from 'node:path'
import { ENV } from './package-env.js'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { remember } from '@epic-web/remember'
import { LRUCache } from 'lru-cache'
import { sql } from 'drizzle-orm'
import * as schema from './schema.ts'
import { resolveTenantDb, resolveTenantOrgIds } from './resolver.ts'
import type { TenantDatabase } from './types.ts'
import { TENANT_ORG_ID_PATTERN } from './regions.ts'
import { applyTenantMigrations } from './migrations.ts'

type TenantDbInstance = {
	db: ReturnType<typeof drizzle<typeof schema>>
	client: ReturnType<typeof createClient>
}

const dbCache = remember('tenant-db-cache', () => {
	return new LRUCache<string, TenantDbInstance>({
		max: 500,
		ttl: 1000 * 60 * 60, // 1 hour TTL
		dispose: (value, key) => {
			try {
				value.client.close()
				console.info(
					`Closed tenant DB connection for org ${key} due to cache eviction.`,
				)
			} catch (error) {
				console.error(
					`Failed to close tenant DB connection for org ${key}:`,
					error,
				)
			}
		},
	})
})

// Track in-flight connection setup to avoid duplicate PRAGMA runs for the same org
const pendingConnections = new Map<
	string,
	Promise<ReturnType<typeof drizzle<typeof schema>>>
>()

function getTenantDbDirectory() {
	if (ENV.TENANT_DB_DIR) {
		return path.resolve(ENV.TENANT_DB_DIR)
	}
	if (ENV.DATABASE_PATH) {
		return path.dirname(path.resolve(process.cwd(), ENV.DATABASE_PATH))
	}
	return path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		'../../../packages/database/db',
	)
}

function getTenantDbFilePath(orgId: string) {
	return path.join(getTenantDbDirectory(), `tenant_${orgId}.db`)
}

/**
 * Lists org IDs that have a provisioned tenant SQLite file on this node.
 */
function listTenantOrgIdsFromFilesystem(): string[] {
	const dir = getTenantDbDirectory()
	if (!fs.existsSync(dir)) return []

	return fs
		.readdirSync(dir)
		.filter(
			(fileName) => fileName.startsWith('tenant_') && fileName.endsWith('.db'),
		)
		.map((fileName) => fileName.slice('tenant_'.length, -'.db'.length))
		.filter((orgId) => TENANT_ORG_ID_PATTERN.test(orgId))
}

export async function listTenantOrgIds(): Promise<string[]> {
	return resolveTenantOrgIds(listTenantOrgIdsFromFilesystem)
}

/**
 * Returns an asynchronous Drizzle database instance for the specified tenant using @libsql/client.
 * WAL journal mode is set during connection setup (single-writer VM, not LiteFS).
 * @param orgId The organization ID
 * @param options.createIfMissing If true, creates the database file if it doesn't exist
 */
async function getTenantDbFromFilesystem(
	orgId: string,
	options: { createIfMissing?: boolean } = {},
) {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) {
		throw new Error('Invalid orgId')
	}

	const cached = dbCache.get(orgId)
	if (cached) return cached.db

	// Deduplicate concurrent connection attempts for the same org
	if (pendingConnections.has(orgId)) {
		return pendingConnections.get(orgId)!
	}

	const connectionPromise = (async () => {
		const baseDir = getTenantDbDirectory()

		if (!fs.existsSync(baseDir)) {
			if (!options.createIfMissing) {
				throw new Error(
					`Database directory not found and createIfMissing is false.`,
				)
			}
			fs.mkdirSync(baseDir, { recursive: true })
		}

		const dbPath = getTenantDbFilePath(orgId)

		if (!fs.existsSync(dbPath) && !options.createIfMissing) {
			throw new Error(`Database file not found: ${dbPath}`)
		}

		const client = createClient({ url: `file:${dbPath}` })
		const db = drizzle(client, { schema })

		// WAL is the default for a single-writer VM. DELETE is only needed when
		// a FUSE replicator (LiteFS) is in front of the file.
		await db.run(sql`PRAGMA journal_mode = WAL;`)
		await db.run(sql`PRAGMA busy_timeout = 30000;`)
		// Enforce referential integrity. SQLite/libSQL default to OFF, which
		// would silently accept orphaned rows and disable ON DELETE CASCADE.
		await db.run(sql`PRAGMA foreign_keys = ON;`)

		// Bring long-lived tenant files up to the current schema before anyone
		// reads them; mirrors the Durable Object path. Runs once per org per
		// process because the connection is cached below.
		await applyTenantMigrations(db, orgId)

		dbCache.set(orgId, { db, client })

		return db
	})()

	pendingConnections.set(orgId, connectionPromise)
	try {
		return await connectionPromise
	} finally {
		pendingConnections.delete(orgId)
	}
}

export async function getTenantDb(
	orgId: string,
	options: { createIfMissing?: boolean } = {},
): Promise<TenantDatabase> {
	return resolveTenantDb(orgId, options, getTenantDbFromFilesystem)
}

/**
 * Close any open connection and delete this tenant's SQLite files.
 * Idempotent: missing files are treated as success.
 */
export async function destroyTenantDb(orgId: string) {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) {
		throw new Error('Invalid orgId')
	}

	const pending = pendingConnections.get(orgId)
	if (pending) {
		try {
			await pending
		} catch {
			// Connection failed; still try to remove files.
		}
	}

	const cached = dbCache.get(orgId)
	if (cached) {
		try {
			cached.client.close()
		} catch (error) {
			console.error(
				`Failed to close tenant DB connection for org ${orgId}:`,
				error,
			)
		}
		dbCache.delete(orgId)
	}

	const dbPath = getTenantDbFilePath(orgId)
	for (const filePath of [
		dbPath,
		`${dbPath}-wal`,
		`${dbPath}-shm`,
		`${dbPath}-journal`,
	]) {
		try {
			fs.unlinkSync(filePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error
			}
		}
	}
}
