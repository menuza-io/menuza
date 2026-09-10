import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
	cachified as baseCachified,
	verboseReporter,
	mergeReporters,
	type CacheEntry,
	type Cache as CachifiedCache,
	type CachifiedOptions,
	type Cache,
	totalTtl,
	type CreateReporter,
} from '@epic-web/cachified'
import { remember } from '@epic-web/remember'
import {
	cachifiedTimingReporter,
	isCloudflareWorkerRuntime,
	type Timings,
} from '@repo/common'
import { getInstanceInfo } from '@repo/common/litefs'
import { LRUCache } from 'lru-cache'
import { z } from 'zod'
import { updatePrimaryCacheValue } from './cache_.sqlite.server'
import { ENV } from './package-env.ts'

const CACHE_DATABASE_PATH = ENV.CACHE_DATABASE_PATH ?? './cache.db'
const CACHE_KV_PREFIX = 'CACHE:'

export interface CacheKVNamespace {
	get(key: string, type?: 'text'): Promise<string | null>
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void>
	delete(key: string): Promise<void>
	list(options?: {
		prefix?: string
		limit?: number
		cursor?: string
	}): Promise<{
		keys: Array<{ name: string }>
		list_complete?: boolean
		cursor?: string
	}>
}

let kvNamespace: CacheKVNamespace | null = null

export function bindCacheKV(kv: CacheKVNamespace): void {
	kvNamespace = kv
}

function useKvBackend(): boolean {
	return kvNamespace !== null || isCloudflareWorkerRuntime()
}

function kvStorageKey(key: string) {
	return `${CACHE_KV_PREFIX}${key}`
}

function stripKvPrefix(name: string) {
	return name.startsWith(CACHE_KV_PREFIX)
		? name.slice(CACHE_KV_PREFIX.length)
		: name
}

type SqliteStatements = {
	getStatement: StatementSync
	setStatement: StatementSync
	deleteStatement: StatementSync
	getAllKeysStatement: StatementSync
	searchKeysStatement: StatementSync
	getCacheStatsStatement: StatementSync
	getCacheKeyDetailsStatement: StatementSync
	getAllCacheKeysWithDetailsStatement: StatementSync
	searchCacheKeysWithDetailsStatement: StatementSync
}

let cacheDb: DatabaseSync | null = null
let sqliteStatements: SqliteStatements | null = null

function createDatabase(tryAgain = true): DatabaseSync {
	const parentDir = path.dirname(CACHE_DATABASE_PATH)
	fs.mkdirSync(parentDir, { recursive: true })

	const db = new DatabaseSync(CACHE_DATABASE_PATH)

	try {
		// Always create cache table on all instances (primary and replicas)
		// This ensures prepared statements don't fail during module initialization
		// even if replica starts before database replication completes
		db.exec(`
			CREATE TABLE IF NOT EXISTS cache (
				key TEXT PRIMARY KEY,
				metadata TEXT,
				value TEXT
			)
		`)
	} catch (error: unknown) {
		fs.unlinkSync(CACHE_DATABASE_PATH)
		if (tryAgain) {
			console.error(
				`Error creating cache database, deleting the file at "${CACHE_DATABASE_PATH}" and trying again...`,
			)
			return createDatabase(false)
		}
		throw error
	}

	return db
}

function ensureSqliteCache(): SqliteStatements {
	if (!sqliteStatements) {
		cacheDb = remember('cacheDb', () => createDatabase())
		sqliteStatements = {
			getStatement: cacheDb.prepare(
				'SELECT value, metadata FROM cache WHERE key = ?',
			),
			setStatement: cacheDb.prepare(
				'INSERT OR REPLACE INTO cache (key, value, metadata) VALUES (?, ?, ?)',
			),
			deleteStatement: cacheDb.prepare('DELETE FROM cache WHERE key = ?'),
			getAllKeysStatement: cacheDb.prepare('SELECT key FROM cache LIMIT ?'),
			searchKeysStatement: cacheDb.prepare(
				'SELECT key FROM cache WHERE key LIKE ? LIMIT ?',
			),
			getCacheStatsStatement: cacheDb.prepare(`
				SELECT
					COUNT(*) as totalKeys,
					SUM(LENGTH(value)) as totalSize
				FROM cache
			`),
			getCacheKeyDetailsStatement: cacheDb.prepare(`
				SELECT
					key,
					LENGTH(value) as size,
					metadata
				FROM cache
				WHERE key = ?
			`),
			getAllCacheKeysWithDetailsStatement: cacheDb.prepare(`
				SELECT
					key,
					LENGTH(value) as size,
					metadata
				FROM cache
				ORDER BY key
				LIMIT ?
			`),
			searchCacheKeysWithDetailsStatement: cacheDb.prepare(`
				SELECT
					key,
					LENGTH(value) as size,
					metadata
				FROM cache
				WHERE key LIKE ?
				ORDER BY key
				LIMIT ?
			`),
		}
	}

	return sqliteStatements
}

const lru = remember(
	'lru-cache',
	() => new LRUCache<string, CacheEntry<unknown>>({ max: 5000 }),
)

export const lruCache = {
	name: 'app-memory-cache',
	set: (key, value) => {
		const ttl = totalTtl(value?.metadata)
		lru.set(key, value, {
			ttl: ttl === Infinity ? undefined : ttl,
			start: value?.metadata?.createdTime,
		})
		return value
	},
	get: (key) => lru.get(key),
	delete: (key) => lru.delete(key),
} satisfies Cache

const isBuffer = (obj: unknown): obj is Buffer =>
	Buffer.isBuffer(obj) || obj instanceof Uint8Array

function bufferReplacer(_key: string, value: unknown) {
	if (isBuffer(value)) {
		return {
			__isBuffer: true,
			data: value.toString('base64'),
		}
	}
	return value
}

function bufferReviver(_key: string, value: unknown) {
	if (
		value &&
		typeof value === 'object' &&
		'__isBuffer' in value &&
		(value as { data?: string }).data
	) {
		return Buffer.from((value as unknown as { data: string }).data, 'base64')
	}
	return value
}

const cacheEntrySchema = z.object({
	metadata: z.object({
		createdTime: z.number(),
		ttl: z.number().nullable().optional(),
		swr: z.number().nullable().optional(),
	}),
	value: z.unknown(),
})
const cacheQueryResultSchema = z.object({
	metadata: z.string(),
	value: z.string(),
})

function parseCacheEntry(
	metadataJson: string,
	valueJson: string,
): CacheEntry<unknown> | null {
	const parsedEntry = cacheEntrySchema.safeParse({
		metadata: JSON.parse(metadataJson),
		value: JSON.parse(valueJson, bufferReviver),
	})
	if (!parsedEntry.success) return null
	const { metadata, value } = parsedEntry.data
	if (!value) return null
	return { metadata, value }
}

function serializeCacheEntry(entry: CacheEntry<unknown>) {
	return {
		metadata: JSON.stringify(entry.metadata),
		value: JSON.stringify(entry.value, bufferReplacer),
	}
}

async function kvGet(key: string): Promise<CacheEntry<unknown> | null> {
	if (!kvNamespace) return null

	const raw = await kvNamespace.get(kvStorageKey(key), 'text')
	if (!raw) return null

	try {
		const parsed = JSON.parse(raw) as { metadata?: string; value?: string }
		if (!parsed.metadata || !parsed.value) return null
		return parseCacheEntry(parsed.metadata, parsed.value)
	} catch {
		return null
	}
}

async function kvSet(key: string, entry: CacheEntry<unknown>) {
	if (!kvNamespace) return

	const { metadata, value } = serializeCacheEntry(entry)
	const ttlMs = totalTtl(entry.metadata)
	const options: { expirationTtl?: number } = {}

	if (Number.isFinite(ttlMs)) {
		options.expirationTtl = Math.max(60, Math.ceil(ttlMs / 1000))
	}

	await kvNamespace.put(
		kvStorageKey(key),
		JSON.stringify({ metadata, value }),
		options,
	)
}

async function kvDelete(key: string) {
	if (!kvNamespace) return
	await kvNamespace.delete(kvStorageKey(key))
}

async function sqliteGet(key: string): Promise<CacheEntry<unknown> | null> {
	const { getStatement } = ensureSqliteCache()
	const result = getStatement.get(key)
	const parseResult = cacheQueryResultSchema.safeParse(result)
	if (!parseResult.success) return null
	return parseCacheEntry(parseResult.data.metadata, parseResult.data.value)
}

async function sqliteSet(key: string, entry: CacheEntry<unknown>) {
	const { setStatement } = ensureSqliteCache()
	const { metadata, value } = serializeCacheEntry(entry)
	setStatement.run(key, value, metadata)
}

async function sqliteDelete(key: string) {
	const { deleteStatement } = ensureSqliteCache()
	deleteStatement.run(key)
}

export const cache: CachifiedCache = {
	get name() {
		return useKvBackend() ? 'KV cache' : 'SQLite cache'
	},
	async get(key) {
		if (useKvBackend()) return kvGet(key)
		return sqliteGet(key)
	},
	async set(key, entry) {
		if (useKvBackend()) {
			await kvSet(key, entry)
			return
		}

		const { currentIsPrimary, primaryInstance } = await getInstanceInfo()

		if (currentIsPrimary) {
			await sqliteSet(key, entry)
		} else {
			// fire-and-forget cache update
			void updatePrimaryCacheValue({
				key,
				cacheValue: entry,
			})
				.then((response) => {
					if (!response.ok) {
						console.error(
							`Error updating cache value for key "${key}" on primary instance (${primaryInstance}): ${response.status} ${response.statusText}`,
							{ entry },
						)
					}
				})
				.catch((error) => {
					console.error(
						`Failed to update cache value for key "${key}" on primary instance (${primaryInstance}):`,
						error,
						{ entry },
					)
				})
		}
	},
	async delete(key) {
		if (useKvBackend()) {
			await kvDelete(key)
			return
		}

		const { currentIsPrimary, primaryInstance } = await getInstanceInfo()

		if (currentIsPrimary) {
			await sqliteDelete(key)
		} else {
			// fire-and-forget cache update
			void updatePrimaryCacheValue({
				key,
				cacheValue: undefined,
			})
				.then((response) => {
					if (!response.ok) {
						console.error(
							`Error deleting cache value for key "${key}" on primary instance (${primaryInstance}): ${response.status} ${response.statusText}`,
						)
					}
				})
				.catch((error) => {
					console.error(
						`Failed to delete cache value for key "${key}" on primary instance (${primaryInstance}):`,
						error,
					)
				})
		}
	},
}

export interface CacheKeyInfo {
	key: string
	size: number
	createdAt?: Date
	ttl?: number | null
	swr?: number | null
}

export interface CacheStats {
	sqlite: {
		totalKeys: number
		totalSize: number
		averageSize: number
	}
	lru: {
		totalKeys: number
		maxSize: number
		currentSize: number
	}
}

function mapSqliteRowToCacheKeyInfo(row: {
	key: string
	size: number
	metadata: string
}): CacheKeyInfo {
	let metadata: {
		createdTime?: number
		ttl?: number | null
		swr?: number | null
	} = {}
	try {
		metadata = JSON.parse(row.metadata) as any
	} catch {
		// ignore parse errors
	}

	return {
		key: row.key,
		size: row.size,
		createdAt: metadata.createdTime
			? new Date(metadata.createdTime)
			: undefined,
		ttl: metadata.ttl,
		swr: metadata.swr,
	}
}

async function listKvKeys(limit: number, search?: string) {
	if (!kvNamespace) return [] as string[]

	const keys: string[] = []
	let cursor: string | undefined

	while (keys.length < limit) {
		const page = await kvNamespace.list({
			prefix: CACHE_KV_PREFIX,
			limit: Math.min(limit - keys.length, 1000),
			...(cursor ? { cursor } : {}),
		})

		for (const listedKey of page.keys) {
			const key = stripKvPrefix(listedKey.name)
			if (!search || key.includes(search)) {
				keys.push(key)
				if (keys.length >= limit) break
			}
		}

		if (keys.length >= limit || page.list_complete !== false) break
		cursor = page.cursor
		if (!cursor) break
	}

	return keys
}

async function getKvKeyDetails(key: string): Promise<CacheKeyInfo | null> {
	if (!kvNamespace) return null

	const raw = await kvNamespace.get(kvStorageKey(key), 'text')
	if (!raw) return null

	try {
		const parsed = JSON.parse(raw) as { metadata?: string; value?: string }
		if (!parsed.metadata || !parsed.value) return null

		const metadata = JSON.parse(parsed.metadata) as {
			createdTime?: number
			ttl?: number | null
			swr?: number | null
		}

		return {
			key,
			size: raw.length,
			createdAt: metadata.createdTime
				? new Date(metadata.createdTime)
				: undefined,
			ttl: metadata.ttl,
			swr: metadata.swr,
		}
	} catch {
		return null
	}
}

export async function getCacheStats(): Promise<CacheStats> {
	if (useKvBackend()) {
		const keys = await listKvKeys(Number.MAX_SAFE_INTEGER)
		let totalSize = 0

		if (kvNamespace) {
			for (const key of keys) {
				const raw = await kvNamespace.get(kvStorageKey(key), 'text')
				totalSize += raw?.length ?? 0
			}
		}

		const totalKeys = keys.length

		return {
			sqlite: {
				totalKeys,
				totalSize,
				averageSize: totalKeys > 0 ? Math.round(totalSize / totalKeys) : 0,
			},
			lru: {
				totalKeys: lru.size,
				maxSize: lru.max || 0,
				currentSize: lru.size,
			},
		}
	}

	const { getCacheStatsStatement } = ensureSqliteCache()
	const sqliteStats = getCacheStatsStatement.get() as {
		totalKeys: number
		totalSize: number
	}

	return {
		sqlite: {
			totalKeys: sqliteStats.totalKeys || 0,
			totalSize: sqliteStats.totalSize || 0,
			averageSize:
				sqliteStats.totalKeys > 0
					? Math.round((sqliteStats.totalSize || 0) / sqliteStats.totalKeys)
					: 0,
		},
		lru: {
			totalKeys: lru.size,
			maxSize: lru.max || 0,
			currentSize: lru.size,
		},
	}
}

export async function getAllCacheKeys(limit: number) {
	if (useKvBackend()) {
		return {
			sqlite: await listKvKeys(limit),
			lru: [...lru.keys()],
		}
	}

	const { getAllKeysStatement } = ensureSqliteCache()

	return {
		sqlite: getAllKeysStatement
			.all(limit)
			.map((row) => (row as { key: string }).key),
		lru: [...lru.keys()],
	}
}

export async function getAllCacheKeysWithDetails(limit: number): Promise<{
	sqlite: CacheKeyInfo[]
	lru: CacheKeyInfo[]
}> {
	if (useKvBackend()) {
		const keys = await listKvKeys(limit)
		const sqliteKeys = (
			await Promise.all(keys.map((key) => getKvKeyDetails(key)))
		).filter((entry): entry is CacheKeyInfo => entry !== null)

		return {
			sqlite: sqliteKeys,
			lru: [...lru.keys()].slice(0, limit).map((key) => {
				const entry = lru.get(key)
				return {
					key,
					size: 0,
					createdAt: entry?.metadata?.createdTime
						? new Date(entry.metadata.createdTime)
						: undefined,
					ttl: entry?.metadata?.ttl,
					swr: entry?.metadata?.swr,
				}
			}),
		}
	}

	const { getAllCacheKeysWithDetailsStatement } = ensureSqliteCache()
	const sqliteRows = getAllCacheKeysWithDetailsStatement.all(limit) as Array<{
		key: string
		size: number
		metadata: string
	}>

	return {
		sqlite: sqliteRows.map(mapSqliteRowToCacheKeyInfo),
		lru: [...lru.keys()].slice(0, limit).map((key) => {
			const entry = lru.get(key)
			return {
				key,
				size: 0,
				createdAt: entry?.metadata?.createdTime
					? new Date(entry.metadata.createdTime)
					: undefined,
				ttl: entry?.metadata?.ttl,
				swr: entry?.metadata?.swr,
			}
		}),
	}
}

export async function searchCacheKeys(search: string, limit: number) {
	if (useKvBackend()) {
		return {
			sqlite: await listKvKeys(limit, search),
			lru: [...lru.keys()].filter((key) => key.includes(search)),
		}
	}

	const { searchKeysStatement } = ensureSqliteCache()

	return {
		sqlite: searchKeysStatement
			.all(`%${search}%`, limit)
			.map((row) => (row as { key: string }).key),
		lru: [...lru.keys()].filter((key) => key.includes(search)),
	}
}

export async function searchCacheKeysWithDetails(
	search: string,
	limit: number,
): Promise<{
	sqlite: CacheKeyInfo[]
	lru: CacheKeyInfo[]
}> {
	if (useKvBackend()) {
		const keys = await listKvKeys(limit, search)
		const sqliteKeys = (
			await Promise.all(keys.map((key) => getKvKeyDetails(key)))
		).filter((entry): entry is CacheKeyInfo => entry !== null)

		return {
			sqlite: sqliteKeys,
			lru: [...lru.keys()]
				.filter((key) => key.includes(search))
				.slice(0, limit)
				.map((key) => {
					const entry = lru.get(key)
					return {
						key,
						size: 0,
						createdAt: entry?.metadata?.createdTime
							? new Date(entry.metadata.createdTime)
							: undefined,
						ttl: entry?.metadata?.ttl,
						swr: entry?.metadata?.swr,
					}
				}),
		}
	}

	const { searchCacheKeysWithDetailsStatement } = ensureSqliteCache()
	const sqliteRows = searchCacheKeysWithDetailsStatement.all(
		`%${search}%`,
		limit,
	) as Array<{
		key: string
		size: number
		metadata: string
	}>

	return {
		sqlite: sqliteRows.map(mapSqliteRowToCacheKeyInfo),
		lru: [...lru.keys()]
			.filter((key) => key.includes(search))
			.slice(0, limit)
			.map((key) => {
				const entry = lru.get(key)
				return {
					key,
					size: 0,
					createdAt: entry?.metadata?.createdTime
						? new Date(entry.metadata.createdTime)
						: undefined,
					ttl: entry?.metadata?.ttl,
					swr: entry?.metadata?.swr,
				}
			}),
	}
}

export async function getCacheKeyDetails(
	key: string,
	type: 'sqlite' | 'lru',
): Promise<CacheKeyInfo | null> {
	if (type === 'sqlite') {
		if (useKvBackend()) return getKvKeyDetails(key)

		const { getCacheKeyDetailsStatement } = ensureSqliteCache()
		const row = getCacheKeyDetailsStatement.get(key) as
			{ key: string; size: number; metadata: string } | undefined
		if (!row) return null
		return mapSqliteRowToCacheKeyInfo(row)
	}

	const entry = lru.get(key)
	if (!entry) return null

	return {
		key,
		size: 0,
		createdAt: entry.metadata?.createdTime
			? new Date(entry.metadata.createdTime)
			: undefined,
		ttl: entry.metadata?.ttl,
		swr: entry.metadata?.swr,
	}
}

export async function clearCacheByType(
	type: 'sqlite' | 'lru',
): Promise<number> {
	if (type === 'sqlite') {
		if (useKvBackend()) {
			const keys = await listKvKeys(Number.MAX_SAFE_INTEGER)
			if (kvNamespace) {
				await Promise.all(keys.map((key) => kvDelete(key)))
			}
			return keys.length
		}

		ensureSqliteCache()
		const result = cacheDb!.prepare('DELETE FROM cache').run()
		return Number(result.changes) || 0
	}

	const count = lru.size
	lru.clear()
	return count
}

export async function deleteCacheKeys(
	keys: string[],
	type: 'sqlite' | 'lru',
): Promise<number> {
	let deletedCount = 0

	if (type === 'sqlite') {
		if (useKvBackend()) {
			for (const key of keys) {
				await kvDelete(key)
				deletedCount++
			}
			return deletedCount
		}

		const { deleteStatement } = ensureSqliteCache()
		for (const key of keys) {
			const result = deleteStatement.run(key)
			if (result.changes && result.changes > 0) {
				deletedCount++
			}
		}
	} else {
		for (const key of keys) {
			if (lru.delete(key)) {
				deletedCount++
			}
		}
	}

	return deletedCount
}

export async function cachified<Value>(
	{
		timings,
		...options
	}: CachifiedOptions<Value> & {
		timings?: Timings
	},
	reporter: CreateReporter<Value> = verboseReporter<Value>(),
): Promise<Value> {
	return baseCachified(
		options,
		mergeReporters(cachifiedTimingReporter(timings), reporter),
	)
}

export async function invalidateUserCache(userId: string) {
	await Promise.all([
		cache.delete(`user:${userId}`),
		cache.delete(`user-security:${userId}`),
		lruCache.delete(`user:${userId}`),
		lruCache.delete(`user-security:${userId}`),
	])
}

export async function invalidateUserOrganizationsCache(userId: string) {
	await Promise.all([
		cache.delete(`user-organizations:${userId}`),
		lruCache.delete(`user-organizations:${userId}`),
	])
}

export async function invalidateUserSecurityCache(userId: string) {
	await Promise.all([
		cache.delete(`user-security:${userId}`),
		lruCache.delete(`user-security:${userId}`),
	])
}

export async function invalidateUserFavoritesCache(userId: string) {
	await Promise.all([
		cache.delete(`user-favorites:${userId}`),
		lruCache.delete(`user-favorites:${userId}`),
	])
}
