import { type StationCatalog, type StationRef } from '@repo/inventory'
import { type CountValues } from './model.ts'
import { type PosSettings } from '~/lib/config.ts'
import { db } from '~/lib/db.ts'

/**
 * What the Stock app keeps on the tablet besides its outbox: the catalogue
 * per location, the counts this tablet is working on and what was typed in
 * them, and a few small memories (recent waste, which entry became which
 * server id). All in the `stockCatalog` store, keyed by restaurant (`origin`).
 */

/** The restaurant a row was made for: a row is only ever sent to it, and demo mode has its own. */
export function stockOrigin(
	settings: Pick<PosSettings, 'demo' | 'tenantApiUrl' | 'slug'>,
): string {
	return settings.demo
		? 'demo'
		: `${settings.tenantApiUrl.replace(/\/+$/, '')}|${settings.slug}`
}

export async function readKey<T>(key: string): Promise<T | undefined> {
	return (await db.stockCatalog.get(key))?.value as T | undefined
}

export async function writeKey(key: string, value: unknown): Promise<void> {
	await db.stockCatalog.put({ key, value, savedAt: Date.now() })
}

// ── Catalogue ───────────────────────────────────────────────────────────────

export type CachedCatalog = {
	catalog: StationCatalog
	/** When the server last said this is current (an answer or a 304). */
	checkedAt: number
}

const catalogKey = (origin: string, locationId: string) =>
	`catalog:${origin}:${locationId}`

export const loadCachedCatalog = (origin: string, locationId: string) =>
	readKey<CachedCatalog>(catalogKey(origin, locationId))

export const saveCachedCatalog = (
	origin: string,
	locationId: string,
	cached: CachedCatalog,
) => writeKey(catalogKey(origin, locationId), cached)

// ── Counts this tablet is working on ────────────────────────────────────────

/**
 * A count as this tablet knows it. `localId` is stable: the `clientId` of the
 * start item for a count begun here, `srv-<id>` for one joined from the list.
 * `ref` is how queued items name it: `{ clientId }` while its start waits in
 * the outbox, `{ id }` once the server has it.
 */
export type LocalCount = {
	localId: string
	ref: StationRef
	listId: string | null
	listName: string | null
	/** `sent` once Send for review was tapped: this tablet adds nothing more. */
	status: 'counting' | 'sent'
	startedAt: number
	/** The code that refused the start, when it did. */
	startFailed?: string
	/** The server already had this count open: this tablet joined it. */
	joined?: boolean
}

const countsKey = (origin: string) => `counts:${origin}`
const mineKey = (origin: string, localId: string) => `mine:${origin}:${localId}`
const sheetKey = (origin: string, serverId: string) =>
	`sheet:${origin}:${serverId}`
const recentKey = (origin: string) => `recent-waste:${origin}`
export const wasteKey = (origin: string, clientId: string) =>
	`waste:${origin}:${clientId}`

export async function localCounts(origin: string): Promise<LocalCount[]> {
	return (await readKey<LocalCount[]>(countsKey(origin))) ?? []
}

export async function saveLocalCounts(
	origin: string,
	counts: LocalCount[],
): Promise<void> {
	await writeKey(countsKey(origin), counts)
}

/** What was typed in a count here, by `rowKey`; survives a reload and a sync. */
export async function localValues(
	origin: string,
	localId: string,
): Promise<CountValues> {
	return (await readKey<CountValues>(mineKey(origin, localId))) ?? {}
}

export async function saveLocalValues(
	origin: string,
	localId: string,
	values: CountValues,
): Promise<void> {
	await writeKey(mineKey(origin, localId), values)
}

export async function dropLocalCount(
	origin: string,
	localId: string,
): Promise<void> {
	await db.transaction('rw', db.stockCatalog, async () => {
		await saveLocalCounts(
			origin,
			(await localCounts(origin)).filter((count) => count.localId !== localId),
		)
		await db.stockCatalog.delete(mineKey(origin, localId))
	})
}

/** The counting sheet the server last sent for a count (what this person typed there, which items someone counted). */
export const loadCachedSheet = (origin: string, serverId: string) =>
	readKey<unknown>(sheetKey(origin, serverId))

export const saveCachedSheet = (
	origin: string,
	serverId: string,
	sheet: unknown,
) => writeKey(sheetKey(origin, serverId), sheet)

// ── Small memories ──────────────────────────────────────────────────────────

/** Items wasted here lately, newest first, for the waste picker's chips. */
export async function recentWaste(origin: string): Promise<string[]> {
	return (await readKey<string[]>(recentKey(origin))) ?? []
}

export async function rememberWaste(
	origin: string,
	itemId: string,
): Promise<void> {
	const before = await recentWaste(origin)
	await writeKey(
		recentKey(origin),
		[itemId, ...before.filter((id) => id !== itemId)].slice(0, 12),
	)
}

/** How long a settled waste entry's server id is kept for an undo (the server accepts one for five minutes). */
const WASTE_ID_KEEP_MS = 15 * 60_000

/** Forgets settled waste ids and sent counts that are no longer of use. */
export async function pruneLocal(now = Date.now()): Promise<void> {
	await db.transaction('rw', db.stockCatalog, db.stockQueue, async () => {
		await db.stockCatalog
			.where('key')
			.startsWith('waste:')
			.filter((row) => now - row.savedAt > WASTE_ID_KEEP_MS)
			.delete()
	})
}
