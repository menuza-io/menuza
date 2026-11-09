import { randomUUID } from 'node:crypto'
import {
	inventoryAllowsLocation,
	MAX_ENTRY_QUANTITY,
	parseUnitRef,
	STANDARD_UNIT_SPECS,
	STANDARD_UNITS,
	toBaseQuantity,
	type InventoryBaseUnit,
	type InventoryActorKind,
	type QuantityUnit,
	type StandardUnit,
	type UnitRef,
	type UnitSystem,
} from '@repo/inventory'
import {
	currentBusinessDate,
	isValidTimeZone,
	localParts,
} from '@repo/reservations'
import {
	invMovements,
	invItemUnits,
	rsvLocationSettings,
} from '@repo/tenant-db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	type InventoryTx,
} from '../lib/inventory-write.ts'

/**
 * Pieces shared by the inventory services: errors, actors, the location's
 * business date, unit references, cursors and the stock sums. No HTTP here;
 * the routes check the token's location, services re-check the location of
 * the record they load (`assertLocationAllowed`).
 */

export const newId = (): string => randomUUID()

export type InventoryActor = {
	kind: InventoryActorKind
	id: string | null
}

export const operatorActor = (userId: string): InventoryActor => ({
	kind: 'operator',
	id: userId,
})

/** 409 `invalid_request` with a machine reason, for a state the request cannot act on. */
export function stateConflict(reason: string): InventoryError {
	return new InventoryError('invalid_request', 409, { reason })
}

export function badRequest(reason: string): InventoryError {
	return new InventoryError('invalid_request', 400, { reason })
}

export function notFound(): InventoryError {
	return new InventoryError('not_found', 404)
}

export function staleVersion(currentVersion: number): InventoryError {
	return new InventoryError('stale_version', 409, { currentVersion })
}

export function assertVersion(current: number, expected: number): void {
	if (current !== expected) throw staleVersion(current)
}

/** The record's location must be one the token may use. */
export function assertLocationAllowed(
	locationIds: readonly string[] | null,
	locationId: string,
): void {
	if (!inventoryAllowsLocation(locationIds, locationId)) {
		throw new InventoryError('location_forbidden', 403)
	}
}

/** Locations a token may see, as a filter: `null` means all of them. */
export type LocationScope = readonly string[] | null

export function locationVisible(
	scope: LocationScope,
	locationId: string,
): boolean {
	return inventoryAllowsLocation(scope, locationId)
}

// ── Time ────────────────────────────────────────────────────────────────────

/** The business date (`YYYY-MM-DD`) of `now` at a location. */
export async function locationBusinessDate(
	db: InventoryReader,
	locationId: string,
	now: number,
): Promise<string> {
	const row = await db
		.select({
			timeZone: rsvLocationSettings.timeZone,
			dayStartMin: rsvLocationSettings.dayStartMin,
		})
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (row && isValidTimeZone(row.timeZone)) {
		return currentBusinessDate(now, row.timeZone, row.dayStartMin)
	}
	return currentBusinessDate(now, 'UTC', 240)
}

export type LocationClock = {
	timeZone: string
	/** The business date (`YYYY-MM-DD`) of `now`. */
	date: string
	/** The wall clock at the location right now (the calendar date, not the business date). */
	local: { date: string; time: string }
}

const two = (value: number): string => String(value).padStart(2, '0')

/**
 * The location's business date and wall clock at `now`. A location without
 * reservations settings has no time zone: UTC and a 04:00 day start, as
 * `locationBusinessDate`.
 */
export async function locationClock(
	db: InventoryReader,
	locationId: string,
	now: number,
): Promise<LocationClock> {
	const row = await db
		.select({
			timeZone: rsvLocationSettings.timeZone,
			dayStartMin: rsvLocationSettings.dayStartMin,
		})
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	const valid = row && isValidTimeZone(row.timeZone)
	const timeZone = valid ? row.timeZone : 'UTC'
	const parts = localParts(now, timeZone)
	return {
		timeZone,
		date: currentBusinessDate(now, timeZone, valid ? row.dayStartMin : 240),
		local: {
			date: `${parts.year}-${two(parts.month)}-${two(parts.day)}`,
			time: `${two(parts.hour)}:${two(parts.minute)}`,
		},
	}
}

// ── Cursors ─────────────────────────────────────────────────────────────────

/** A keyset cursor: a sort number and an id. */
export function encodeCursor(sort: number, id: string): string {
	return `${sort}:${id}`
}

export function decodeCursor(
	cursor: string | undefined,
): { sort: number; id: string } | null {
	if (cursor === undefined || cursor === '') return null
	const match = /^(\d{1,16}):([A-Za-z0-9_-]{1,64})$/.exec(cursor)
	if (!match) throw badRequest('cursor')
	return { sort: Number(match[1]), id: match[2]! }
}

/** An offset cursor for lists that are sorted and filtered in memory. */
export function decodeOffsetCursor(cursor: string | undefined): number {
	if (cursor === undefined || cursor === '') return 0
	if (!/^\d{1,6}$/.test(cursor)) throw badRequest('cursor')
	return Number(cursor)
}

// ── Units ───────────────────────────────────────────────────────────────────

export type ItemUnitRow = {
	id: string
	itemId: string
	name: string
	baseQuantity: number
	usedAt: number | null
	archivedAt: number | null
}

const STANDARD_UNIT_SET = new Set<string>(STANDARD_UNITS)

/** A stored unit (a standard key or a unit id) as it travels on the wire. */
export function wireUnit(stored: string): UnitRef {
	return (STANDARD_UNIT_SET.has(stored) ? stored : `unit:${stored}`) as UnitRef
}

/** A wire unit reference as stored (a standard key or a bare unit id). */
export function storedUnit(ref: string): string {
	return ref.startsWith('unit:') ? ref.slice(5) : ref
}

/** The unit an item is counted in when nobody chose one. */
export function defaultCountUnit(
	base: InventoryBaseUnit,
	system: UnitSystem,
): StandardUnit {
	if (base === 'piece') return 'piece'
	if (base === 'g') return system === 'us' ? 'lb' : 'kg'
	return system === 'us' ? 'gal' : 'l'
}

export async function loadItemUnits(
	db: InventoryReader,
	itemIds: readonly string[],
): Promise<Map<string, ItemUnitRow[]>> {
	const rows = await queryInChunks(itemIds, (chunk) =>
		db
			.select()
			.from(invItemUnits)
			.where(inArray(invItemUnits.itemId, chunk))
			.orderBy(invItemUnits.createdAt, sql`rowid`),
	)
	return groupUnits(rows)
}

export function groupUnits(rows: ItemUnitRow[]): Map<string, ItemUnitRow[]> {
	const map = new Map<string, ItemUnitRow[]>()
	for (const row of rows) {
		const list = map.get(row.itemId)
		if (list) list.push(row)
		else map.set(row.itemId, [row])
	}
	return map
}

/**
 * Resolves a wire unit reference for an item: a standard unit must measure
 * the item's base unit, a named unit must be one of the item's active units.
 * Anything else is 400 `unit_mismatch`.
 */
export function resolveQuantityUnit(
	ref: string,
	base: InventoryBaseUnit,
	units: readonly ItemUnitRow[],
	options: { allowArchived?: boolean } = {},
): { unit: QuantityUnit; named: ItemUnitRow | null } {
	const parsed = parseUnitRef(ref as UnitRef)
	if (parsed.kind === 'standard') {
		if (STANDARD_UNIT_SPECS[parsed.unit]?.base !== base) {
			throw new InventoryError('unit_mismatch', 400)
		}
		return { unit: { kind: 'standard', unit: parsed.unit }, named: null }
	}
	const named = units.find((unit) => unit.id === parsed.id)
	if (!named || (named.archivedAt !== null && !options.allowArchived)) {
		throw new InventoryError('unit_mismatch', 400)
	}
	return {
		unit: { kind: 'named', baseQuantity: named.baseQuantity },
		named,
	}
}

/**
 * An amount a person typed, as stored base thousandths. 400 when it is out
 * of range, `unit_mismatch` when the unit cannot measure the item.
 */
export function typedToBase(
	amount: number,
	ref: string,
	base: InventoryBaseUnit,
	units: readonly ItemUnitRow[],
): { quantity: number; named: ItemUnitRow | null } {
	const { unit, named } = resolveQuantityUnit(ref, base, units)
	const quantity = toBaseQuantity(amount, unit, base)
	if (!Number.isSafeInteger(quantity) || quantity > MAX_ENTRY_QUANTITY) {
		throw badRequest('amount_out_of_range')
	}
	return { quantity, named }
}

/** Marks named units as used, so their size is fixed from now on. */
export async function markUnitsUsed(
	tx: InventoryTx,
	unitIds: readonly string[],
	now: number,
): Promise<void> {
	const ids = [...new Set(unitIds)]
	await forEachInChunks(ids, (chunk) =>
		tx
			.update(invItemUnits)
			.set({ usedAt: now })
			.where(and(inArray(invItemUnits.id, chunk), isNull(invItemUnits.usedAt))),
	)
}

// ── Stock sums ──────────────────────────────────────────────────────────────

/** On hand of every item at a location (items with no movement are absent). */
export async function onHandByItem(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			itemId: invMovements.itemId,
			total: sql<number>`sum(${invMovements.quantity})`,
		})
		.from(invMovements)
		.where(eq(invMovements.locationId, locationId))
		.groupBy(invMovements.itemId)
	return new Map(rows.map((row) => [row.itemId, Number(row.total ?? 0)]))
}

/** On hand of one item at every location. */
export async function onHandByLocation(
	db: InventoryReader,
	itemId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			locationId: invMovements.locationId,
			total: sql<number>`sum(${invMovements.quantity})`,
		})
		.from(invMovements)
		.where(eq(invMovements.itemId, itemId))
		.groupBy(invMovements.locationId)
	return new Map(rows.map((row) => [row.locationId, Number(row.total ?? 0)]))
}

/** On hand of one item across the organization. */
export async function onHandTotal(
	db: InventoryReader,
	itemId: string,
): Promise<number> {
	const row = await db
		.select({ total: sql<number>`sum(${invMovements.quantity})` })
		.from(invMovements)
		.where(eq(invMovements.itemId, itemId))
		.get()
	return Number(row?.total ?? 0)
}
