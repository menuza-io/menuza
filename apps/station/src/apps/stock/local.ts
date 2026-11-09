import {
	type StationCatalog,
	type StationRef,
	type UnitRef,
} from '@repo/inventory'
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
	/**
	 * Always `counting` now. `sent` only appears on a record made by an older
	 * build, which closed the count on this tablet when Send was tapped; it is
	 * read as "this person is done" (`isDone`).
	 */
	status: 'counting' | 'sent'
	/** When this person tapped "I'm done counting" (a per-device note the region keeps; the count stays open). */
	done?: number
	/** What the region last said about the count itself, once it is known to be past `counting`. */
	serverStatus?: CountState
	startedAt: number
	/** The code that refused the start, when it did. */
	startFailed?: string
	/** The server already had this count open: this tablet joined it. */
	joined?: boolean
}

/** A count's state at the region (`countStatusSchema`). */
export type CountState = 'counting' | 'in_review' | 'approved' | 'cancelled'

/** The person said they are done here. The count is still the manager's to close. */
export const isDone = (count: LocalCount) =>
	count.done !== undefined || count.status === 'sent'

/** The manager finished the count in the App: nothing can be added to it any more. */
export const isFinished = (count: Pick<LocalCount, 'serverStatus'>) =>
	count.serverStatus === 'approved' || count.serverStatus === 'cancelled'

const countsKey = (origin: string) => `counts:${origin}`
const mineKey = (origin: string, localId: string) => `mine:${origin}:${localId}`
const sheetKey = (origin: string, serverId: string) =>
	`sheet:${origin}:${serverId}`
const liveKey = (origin: string, localId: string) => `live:${origin}:${localId}`
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

/**
 * The units a row may have a live entry in at the region, by `rowKey`. The
 * region keeps one live entry per item, area and unit, and adds them up, so a
 * row's unit switch has to clear the old unit's entry (`saveCountEntry`).
 */
export type LiveUnits = Record<string, UnitRef[]>

export async function localLiveUnits(
	origin: string,
	localId: string,
): Promise<LiveUnits> {
	return (await readKey<LiveUnits>(liveKey(origin, localId))) ?? {}
}

export async function saveLiveUnits(
	origin: string,
	localId: string,
	live: LiveUnits,
): Promise<void> {
	await writeKey(liveKey(origin, localId), live)
}

/** Forgets a count on this tablet: its record, what was typed, its cached sheet and its unit memory. */
export async function dropLocalCount(
	origin: string,
	localId: string,
): Promise<void> {
	await db.transaction('rw', db.stockCatalog, async () => {
		const counts = await localCounts(origin)
		const gone = counts.find((count) => count.localId === localId)
		await saveLocalCounts(
			origin,
			counts.filter((count) => count.localId !== localId),
		)
		await db.stockCatalog.delete(mineKey(origin, localId))
		await db.stockCatalog.delete(liveKey(origin, localId))
		if (gone && 'id' in gone.ref)
			await db.stockCatalog.delete(sheetKey(origin, gone.ref.id))
	})
}

/**
 * Drops every count the manager already approved or cancelled, except the one
 * on screen (it says "This count is finished" first). Entries still waiting
 * for such a count stay in the outbox and end up as refusals the person reads.
 */
export async function dropFinishedCounts(
	origin: string,
	except: string | null = null,
): Promise<number> {
	const finished = (await localCounts(origin)).filter(
		(count) => isFinished(count) && count.localId !== except,
	)
	for (const count of finished) await dropLocalCount(origin, count.localId)
	return finished.length
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

/** A cached counting sheet is read again whenever its count is opened with a connection. */
const SHEET_KEEP_MS = 14 * 24 * 3_600_000

/** Forgets settled waste ids and old cached counting sheets (a finished count is dropped by `dropFinishedCounts`). */
export async function pruneLocal(now = Date.now()): Promise<void> {
	await db.transaction('rw', db.stockCatalog, db.stockQueue, async () => {
		await db.stockCatalog
			.where('key')
			.startsWith('waste:')
			.filter((row) => now - row.savedAt > WASTE_ID_KEEP_MS)
			.delete()
		await db.stockCatalog
			.where('key')
			.startsWith('sheet:')
			.filter((row) => now - row.savedAt > SHEET_KEEP_MS)
			.delete()
	})
}
