import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { remember } from '@epic-web/remember'
import { createClient, type Client } from '@libsql/client'
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql'
import {
	drizzle as drizzleD1,
	type AnyD1Database,
	type DrizzleD1Database,
} from 'drizzle-orm/d1'
import { ENV } from './package-env.ts'
import * as relations from './relations.ts'
import * as tables from './schema.ts'

export const schema = { ...tables, ...relations }

function getPackageDir() {
	try {
		const metaUrl = import.meta.url
		if (typeof metaUrl !== 'string' || metaUrl.length === 0) {
			return '.'
		}
		return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..')
	} catch {
		return '.'
	}
}

type LibsqlDb = ReturnType<typeof drizzleLibsql<typeof schema>>
export type ControlPlaneDb = LibsqlDb

let d1Db: DrizzleD1Database<typeof schema> | null = null
let libsqlDb: LibsqlDb | null = null
let libsqlClientInstance: Client | null = null

/**
 * Resolve the control-plane SQLite file to an absolute `file:` URL.
 *
 * `DATABASE_URL` may be cwd-relative (`file:./db/data.db`) or absolute.
 * Prefer an existing file so all processes open the same database.
 */
export function resolveSqliteFileUrl() {
	const raw = ENV.DATABASE_URL
	if (raw) {
		const filePath = raw.replace(/^file:/, '').replace(/\?.*$/, '')
		if (path.isAbsolute(filePath)) {
			return `file:${filePath}`
		}

		const fromCwd = path.resolve(process.cwd(), filePath)
		if (fs.existsSync(fromCwd)) {
			return `file:${fromCwd}`
		}

		const fromPackage = path.resolve(getPackageDir(), filePath)
		if (fs.existsSync(fromPackage)) {
			return `file:${fromPackage}`
		}

		if (ENV.DATABASE_PATH) {
			return `file:${path.resolve(process.cwd(), ENV.DATABASE_PATH)}`
		}

		return `file:${fromCwd}`
	}

	if (ENV.DATABASE_PATH) {
		return `file:${path.resolve(process.cwd(), ENV.DATABASE_PATH)}`
	}

	return `file:${path.resolve(getPackageDir(), 'db/data.db')}`
}

export function bindCloudflareD1(database: AnyD1Database): void {
	const client = drizzleD1(database, { schema })
	// D1 rejects SQL BEGIN/SAVEPOINT. A Worker request is already single-threaded
	// against one primary; run the callback without a transaction wrapper.
	client.transaction = ((transaction) =>
		transaction(client as never)) as typeof client.transaction
	d1Db = client
}

export function isD1Bound(): boolean {
	return d1Db !== null
}

function isCloudflareWorkerRuntime(): boolean {
	const workerCaches = (globalThis as { caches?: { default?: unknown } }).caches
	return workerCaches !== undefined && 'default' in workerCaches
}

function getLibsqlClient(): Client {
	if (isD1Bound()) {
		throw new Error('sqliteClient is not available when D1 is bound')
	}

	if (isCloudflareWorkerRuntime()) {
		throw new Error(
			'Call bindCloudflareD1() before using db on Cloudflare Workers',
		)
	}

	if (!libsqlClientInstance) {
		libsqlClientInstance = remember('libsql', () => {
			const url = resolveSqliteFileUrl()
			fs.mkdirSync(path.dirname(url.replace(/^file:/, '')), { recursive: true })
			// libsql opens a logical connection per execute()/transaction(). `timeout`
			// sets busy_timeout on each of those; `concurrency: 1` serializes in-process writers.
			const client = createClient({
				url,
				timeout: 5000,
				concurrency: 1,
			})
			void client.execute('PRAGMA journal_mode = WAL')
			return client
		})
	}

	return libsqlClientInstance
}

function getLibsqlDb(): LibsqlDb {
	if (!libsqlDb) {
		libsqlDb = remember('drizzle', () =>
			drizzleLibsql(getLibsqlClient(), { schema }),
		)
	}

	return libsqlDb
}

function getDb(): LibsqlDb | DrizzleD1Database<typeof schema> {
	if (d1Db) return d1Db
	return getLibsqlDb()
}

function bindDbMethod<
	T extends LibsqlDb | DrizzleD1Database<typeof schema>,
	K extends keyof T,
>(target: T, prop: K): T[K] {
	const value = target[prop]
	if (typeof value === 'function') {
		return ((...args: unknown[]) =>
			(value as (...methodArgs: unknown[]) => unknown).apply(
				target,
				args,
			)) as T[K]
	}
	return value
}

export const db: ControlPlaneDb = new Proxy({} as ControlPlaneDb, {
	get(_target, prop, receiver) {
		if (prop === 'then') return undefined
		const target = getDb()
		const value = Reflect.get(target, prop, receiver)
		if (typeof value === 'function') {
			return bindDbMethod(target, prop as keyof typeof target)
		}
		return value
	},
})

export const sqliteClient = new Proxy({} as Client, {
	get(_target, prop, receiver) {
		if (prop === 'then') return undefined
		const target = getLibsqlClient()
		const value = Reflect.get(target, prop, receiver)
		if (typeof value === 'function') {
			return ((...args: unknown[]) =>
				(value as (...methodArgs: unknown[]) => unknown).apply(
					target,
					args,
				)) as Client[keyof Client]
		}
		return value
	},
})
