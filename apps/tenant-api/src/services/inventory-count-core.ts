import {
	invCountEntries,
	invCountListItems,
	invCounts,
	invMovements,
} from '@repo/tenant-db'
import { STANDARD_UNITS } from '@repo/inventory'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { assertLocationAllowed, notFound } from './inventory-common.ts'
import {
	type InventoryCaller,
	type StockRow,
} from './inventory-items-service.ts'

/**
 * The count model's shared pieces: live entries, as-of expected, scope. Kept
 * apart from `inventory-counts-service.ts` so the second-person check, the
 * device list, the late entries and the schedules read the same rules instead
 * of copying them.
 */

export type CountRow = typeof invCounts.$inferSelect
export type EntryRow = typeof invCountEntries.$inferSelect

/** Counts that are not closed: `counting` and `in_review` (both take entries). */
export const OPEN_STATUSES = ['counting', 'in_review'] as const
/**
 * Only a count being counted is started against or joined: one waiting for
 * review neither blocks a new count nor captures a Station start.
 */
export const COUNTING = 'counting' as const

// ── Entries ─────────────────────────────────────────────────────────────────

/** An entry that clears its counter's earlier entry has no amount. */
export const CLEARED = ''

const STANDARD_UNIT_KEYS = new Set<string>(STANDARD_UNITS)

/**
 * The unit slot of an entry: every standard unit (g, kg, l, piece ...) shares
 * one slot, so 5 kg corrected to 5000 g replaces the entry instead of adding
 * to it; each named unit (a box, a crate) has its own slot, so "2 boxes and
 * 3 kg" stays two live entries (see `countEntrySchema`).
 */
export function unitSlot(enteredUnit: string): string {
	return STANDARD_UNIT_KEYS.has(enteredUnit) ? '~standard' : enteredUnit
}

function liveKey(row: EntryRow): string {
	return [
		row.itemId,
		row.areaId ?? '',
		row.counterKind,
		row.counterId ?? '',
		unitSlot(row.enteredUnit),
	].join('|')
}

/**
 * The live entries: the latest per item, area, counter and unit slot (`rows`
 * oldest first, returned oldest-latest first); an entry that cleared its
 * predecessor drops out.
 */
export function liveEntries(rows: readonly EntryRow[]): EntryRow[] {
	const latest = new Map<string, EntryRow>()
	for (const row of rows) {
		const key = liveKey(row)
		// Delete first so the map stays in order of each slot's latest entry.
		latest.delete(key)
		latest.set(key, row)
	}
	return [...latest.values()].filter((row) => row.enteredAmount !== CLEARED)
}

export async function loadEntries(
	db: InventoryReader,
	countIds: readonly string[],
): Promise<Map<string, EntryRow[]>> {
	const rows = await queryInChunks(countIds, (chunk) =>
		db
			.select()
			.from(invCountEntries)
			.where(inArray(invCountEntries.countId, chunk))
			.orderBy(invCountEntries.createdAt, sql`rowid`),
	)
	const map = new Map<string, EntryRow[]>()
	for (const row of rows) {
		const list = map.get(row.countId)
		if (list) list.push(row)
		else map.set(row.countId, [row])
	}
	return map
}

/** Counted base quantity per item (sum of live entries); items nobody counted are absent. */
export function countedTotals(live: readonly EntryRow[]): Map<string, number> {
	const totals = new Map<string, number>()
	for (const row of live) {
		totals.set(row.itemId, (totals.get(row.itemId) ?? 0) + row.quantity)
	}
	return totals
}

// ── As-of expected ──────────────────────────────────────────────────────────

/**
 * The instant each counted item is "as of": the time of its latest live entry
 * (the moment someone last measured it). An item nobody counted is absent.
 */
export function countedAtByItem(
	live: readonly EntryRow[],
): Map<string, number> {
	const at = new Map<string, number>()
	for (const row of live) {
		if (row.createdAt > (at.get(row.itemId) ?? -1)) {
			at.set(row.itemId, row.createdAt)
		}
	}
	return at
}

export type AsOf = {
	/** On hand as of the item's counted instant: live on-hand minus what moved after it. */
	expected: number
	/** A later approved count already measured this item: this count leaves it alone. */
	superseded: boolean
}

/**
 * The count approval rule. Counted quantities are compared with the ledger AS
 * OF each item's latest entry, never with the live on-hand: movements after
 * that instant (a delivery at 14:00 after a 10:00 count, sales, waste) are not
 * part of "expected" and survive approval. Items nobody counted are absent
 * from the result (callers use the live on-hand for them).
 */
export async function expectedAsOf(
	db: InventoryReader,
	locationId: string,
	scope: readonly StockRow[],
	countedAt: ReadonlyMap<string, number>,
): Promise<Map<string, AsOf>> {
	const result = new Map<string, AsOf>()
	const counted = scope.filter((row) => countedAt.has(row.item.id))
	if (counted.length === 0) return result
	let earliest = Number.POSITIVE_INFINITY
	for (const row of counted) {
		earliest = Math.min(earliest, countedAt.get(row.item.id)!)
	}
	const after = await queryInChunks(
		counted.map((row) => row.item.id),
		(chunk) =>
			db
				.select({
					itemId: invMovements.itemId,
					kind: invMovements.kind,
					createdAt: invMovements.createdAt,
					quantity: invMovements.quantity,
				})
				.from(invMovements)
				.where(
					and(
						eq(invMovements.locationId, locationId),
						inArray(invMovements.itemId, chunk),
						gt(invMovements.createdAt, earliest),
					),
				),
	)
	const movedAfter = new Map<string, number>()
	const superseded = new Set<string>()
	for (const move of after) {
		if (move.createdAt <= countedAt.get(move.itemId)!) continue
		movedAfter.set(
			move.itemId,
			(movedAfter.get(move.itemId) ?? 0) + move.quantity,
		)
		if (move.kind === 'count') superseded.add(move.itemId)
	}
	for (const row of counted) {
		result.set(row.item.id, {
			expected: row.onHand - (movedAfter.get(row.item.id) ?? 0),
			superseded: superseded.has(row.item.id),
		})
	}
	return result
}

// ── Scope and review ────────────────────────────────────────────────────────

export async function countScope(
	db: InventoryReader,
	count: CountRow,
	stock: StockRow[],
): Promise<StockRow[]> {
	if (!count.listId) {
		// A quick count with no list is the key items (#490); a full count is
		// everything the location keeps.
		return stock.filter(
			(row) => row.place !== null && (count.kind !== 'quick' || row.item.isKey),
		)
	}
	const rows = await db
		.select({ itemId: invCountListItems.itemId })
		.from(invCountListItems)
		.where(eq(invCountListItems.listId, count.listId))
	const wanted = new Set(rows.map((row) => row.itemId))
	return stock.filter((row) => wanted.has(row.item.id))
}

export async function loadCount(
	db: InventoryReader,
	id: string,
): Promise<CountRow> {
	const row = await db
		.select()
		.from(invCounts)
		.where(eq(invCounts.id, id))
		.get()
	if (!row) throw notFound()
	return row
}

/** A count the token's locations allow (404 for a missing one, 403 for an excluded location). */
export async function loadAllowedCount(
	db: InventoryReader,
	id: string,
	caller: Pick<InventoryCaller, 'locationIds'>,
): Promise<CountRow> {
	const row = await loadCount(db, id)
	assertLocationAllowed(caller.locationIds, row.locationId)
	return row
}

/** Entries of the count itself (pass 1). The second person's blind count (pass 2) is never summed in (#525). */
export function firstPass(rows: readonly EntryRow[]): EntryRow[] {
	return rows.filter((row) => row.pass !== 2)
}

/** The second person's entries (pass 2, #525). */
export function secondPass(rows: readonly EntryRow[]): EntryRow[] {
	return rows.filter((row) => row.pass === 2)
}

/** One person, whatever login or PIN they used: a staff member linked to a login is that login's person. */
export type PersonKey = string
