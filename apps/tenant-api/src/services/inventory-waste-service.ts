import {
	inventoryValueMinor,
	PICKABLE_WASTE_REASONS,
	WASTE_UNDO_WINDOW_MS,
	type CorrectWaste,
	type WasteCorrection,
	type WasteEntry,
	type WasteEntryRefusalCode,
	type WasteSummary,
	quantityInCurrentUnit,
} from '@repo/inventory'
import { daysBetween } from '@repo/reservations'
import {
	invCountEntries,
	invCounts,
	invItemCosts,
	invItems,
	invMovements,
	invWaste,
	invWasteCorrections,
	invWasteDishes,
	getTenantDb,
} from '@repo/tenant-db'
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { countInstants } from './inventory-food-cost.ts'
import { loadUnitChanges } from './inventory-history.ts'
import {
	assertLocationAllowed,
	badRequest,
	decodeCursor,
	encodeCursor,
	type InventoryActor,
	loadItemUnits,
	locationBusinessDate,
	markUnitsUsed,
	newId,
	notFound,
	typedToBase,
} from './inventory-common.ts'
import {
	type ListWasteQuery,
	type LogWasteInput,
} from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

type WasteRow = typeof invWaste.$inferSelect
type CorrectionRow = typeof invWasteCorrections.$inferSelect
type DishRow = typeof invWasteDishes.$inferSelect

const PICKABLE = new Set<string>(PICKABLE_WASTE_REASONS)

/** Longest period a summary covers. */
const MAX_SUMMARY_DAYS = 366

/**
 * Logs waste. Every entry is validated before any is written; a bad one
 * fails the whole request. A replayed `clientId` is reported in `duplicates`.
 * Each entry writes the waste row and its negative `waste` movement, valued
 * at the item's weighted average cost when it has one.
 */
export type LogWasteOptions = {
	/**
	 * Waste logged on a Station tablet: the rows record the terminal
	 * (`source: 'station'`, `device_id`), and `lateSync` / `madeAt` name, per
	 * `clientId`, entries that arrived long after they happened (flagged for a
	 * manager) and when the tablet made them (the business date follows it).
	 * With a station, an entry that cannot be logged (unknown or archived item,
	 * a unit the item cannot use, an amount out of range) is reported in
	 * `refused` with a stable code (`WASTE_ENTRY_REFUSAL_CODES`) and the others
	 * are saved, instead of failing the request.
	 */
	station?: {
		deviceId: string
		lateSync?: (clientId: string) => boolean
		madeAt?: (clientId: string) => number | undefined
		/** Who each entry is logged for (default the caller). */
		actorFor?: (clientId: string) => InventoryActor
		/** The session's person: the audit trail names them when they synced someone else's entry. */
		syncedBy?: string
	}
}

export async function logWaste(
	caller: InventoryCaller,
	body: LogWasteInput,
	options: LogWasteOptions = {},
) {
	const { station } = options
	for (const entry of body.entries) {
		assertLocationAllowed(caller.locationIds, entry.locationId)
		if (!PICKABLE.has(entry.reason)) {
			throw new InventoryError('reason_not_allowed', 400)
		}
	}
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const clientIds = body.entries.map((entry) => entry.clientId)
		const existing = await queryInChunks(clientIds, (chunk) =>
			tx.select().from(invWaste).where(inArray(invWaste.clientId, chunk)),
		)
		const byClient = new Map(existing.map((row) => [row.clientId, row]))
		const itemIds = [...new Set(body.entries.map((entry) => entry.itemId))]
		const [items, costs, units] = await Promise.all([
			queryInChunks(itemIds, (chunk) =>
				tx.select().from(invItems).where(inArray(invItems.id, chunk)),
			),
			queryInChunks(itemIds, (costChunk) =>
				tx
					.select()
					.from(invItemCosts)
					.where(inArray(invItemCosts.itemId, costChunk)),
			),
			loadItemUnits(tx, itemIds),
		])
		const itemById = new Map(items.map((item) => [item.id, item]))
		const costById = new Map(costs.map((cost) => [cost.itemId, cost]))
		const dates = new Map<string, string>()

		const accepted: Array<{
			clientId: string
			id: string
			quantity: number
			valueMinor?: number
			currency?: string
		}> = []
		const duplicates: Array<{ clientId: string; id: string }> = []
		const refused: Array<{ clientId: string; code: WasteEntryRefusalCode }> = []
		const lateSync: string[] = []
		// Entries stored earlier in this same request, by `clientId`: a repeat
		// inside one batch is a duplicate, never a unique-index violation.
		const inBatch = new Map<
			string,
			{ id: string; entry: (typeof body.entries)[number] }
		>()
		const usedUnits: string[] = []
		const actors = new Map<
			string,
			{ actor: InventoryActor; first: string; entries: number }
		>()
		for (const entry of body.entries) {
			const known = byClient.get(entry.clientId)
			if (known) {
				if (
					known.reversesId !== null ||
					known.itemId !== entry.itemId ||
					known.locationId !== entry.locationId
				) {
					throw new InventoryError('idempotency_conflict', 409)
				}
				duplicates.push({ clientId: entry.clientId, id: known.id })
				continue
			}
			const first = inBatch.get(entry.clientId)
			if (first) {
				if (
					first.entry.itemId !== entry.itemId ||
					first.entry.locationId !== entry.locationId
				) {
					if (station) {
						refused.push({
							clientId: entry.clientId,
							code: 'idempotency_conflict',
						})
						continue
					}
					throw new InventoryError('idempotency_conflict', 409)
				}
				duplicates.push({ clientId: entry.clientId, id: first.id })
				continue
			}
			const item = itemById.get(entry.itemId)
			if (!item || item.archivedAt !== null) {
				if (station) {
					refused.push({
						clientId: entry.clientId,
						code: item ? 'item_archived' : 'item_unknown',
					})
					continue
				}
				throw notFound()
			}
			let typed: ReturnType<typeof typedToBase>
			try {
				typed = typedToBase(
					entry.amount,
					entry.unit,
					item.baseUnit,
					units.get(item.id) ?? [],
				)
				if (typed.quantity <= 0) throw badRequest('amount')
			} catch (error) {
				if (station && error instanceof InventoryError) {
					refused.push({
						clientId: entry.clientId,
						code:
							error.code === 'unit_mismatch'
								? 'unit_mismatch'
								: 'quantity_invalid',
					})
					continue
				}
				throw error
			}
			if (typed.named) usedUnits.push(typed.named.id)
			const cost = costById.get(item.id)
			const costMicro = cost?.avgCostMicro ?? cost?.lastCostMicro ?? null
			const value =
				cost && costMicro !== null
					? inventoryValueMinor(typed.quantity, costMicro)
					: null
			const madeAt = Math.min(
				station?.madeAt?.(entry.clientId) ?? ctx.now,
				ctx.now,
			)
			const dateKey = `${entry.locationId}:${madeAt}`
			let businessDate = dates.get(dateKey)
			if (!businessDate) {
				businessDate = await locationBusinessDate(tx, entry.locationId, madeAt)
				dates.set(dateKey, businessDate)
			}
			const late = station?.lateSync?.(entry.clientId) === true
			if (late) lateSync.push(entry.clientId)
			const actor = station?.actorFor?.(entry.clientId) ?? caller.actor
			const id = newId()
			await tx.insert(invWaste).values({
				id,
				locationId: entry.locationId,
				itemId: item.id,
				quantity: typed.quantity,
				reason: entry.reason,
				note: entry.note?.length ? entry.note : null,
				valueMinor: value,
				currency: value === null ? null : cost!.currency,
				actorKind: actor.kind,
				actorId: actor.id,
				clientId: entry.clientId,
				businessDate,
				source: station ? 'station' : 'operator',
				deviceId: station?.deviceId ?? null,
				lateSync: late,
				createdAt: madeAt,
			})
			await tx.insert(invMovements).values({
				locationId: entry.locationId,
				itemId: item.id,
				quantity: -typed.quantity,
				valueMinor: value === null ? null : -value,
				currency: value === null ? null : cost!.currency,
				kind: 'waste',
				reason: entry.reason,
				sourceType: 'waste',
				sourceId: id,
				eventKey: `waste:${id}`,
				businessDate,
				actorKind: actor.kind,
				actorId: actor.id,
				note: entry.note?.length ? entry.note : null,
				createdAt: madeAt,
			})
			const out: (typeof accepted)[number] = {
				clientId: entry.clientId,
				id,
				quantity: typed.quantity,
			}
			if (caller.cost && value !== null) {
				out.valueMinor = value
				out.currency = cost!.currency
			}
			accepted.push(out)
			inBatch.set(entry.clientId, { id, entry })
			const key = `${actor.kind}|${actor.id ?? ''}`
			const group = actors.get(key)
			if (group) group.entries += 1
			else actors.set(key, { actor, first: id, entries: 1 })
		}
		await markUnitsUsed(tx, usedUnits, ctx.now)
		// One audit row per person the waste is logged for.
		for (const { actor, first, entries: n } of actors.values()) {
			await recordInventoryAudit(tx, {
				actorKind: actor.kind,
				actorId: actor.id,
				action: 'waste.log',
				resourceType: 'waste',
				resourceId: first,
				locationId: body.entries[0]!.locationId,
				detail:
					station?.syncedBy && actor.id !== station.syncedBy
						? { entries: n, syncedBy: station.syncedBy }
						: { entries: n },
				at: ctx.now,
			})
		}
		return station
			? { accepted, duplicates, refused, lateSync }
			: { accepted, duplicates }
	})
}

export type UndoWasteOptions = {
	/**
	 * Undo from a Station tablet: only the caller's own entry from this
	 * terminal (anything else is a 404), within `windowMs` of when the region
	 * stored it. The reversing entry names the terminal too.
	 */
	station?: { deviceId: string; windowMs: number }
}

/** Undoes waste within the window, once, by a reversing entry (the original stays). */
export async function undoWaste(
	caller: InventoryCaller,
	input: { id: string; clientId: string },
	options: UndoWasteOptions = {},
): Promise<WasteEntry> {
	const { station } = options
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const replay = await tx
			.select()
			.from(invWaste)
			.where(eq(invWaste.clientId, input.clientId))
			.get()
		if (replay) {
			if (
				replay.reversesId !== input.id ||
				(station &&
					(replay.deviceId !== station.deviceId ||
						replay.actorKind !== caller.actor.kind ||
						replay.actorId !== caller.actor.id))
			) {
				throw new InventoryError('idempotency_conflict', 409)
			}
			assertLocationAllowed(caller.locationIds, replay.locationId)
			return (await entriesFor(tx, [replay], caller.cost))[0]!
		}
		const original = await tx
			.select()
			.from(invWaste)
			.where(eq(invWaste.id, input.id))
			.get()
		if (!original || original.reversesId !== null) throw notFound()
		assertLocationAllowed(caller.locationIds, original.locationId)
		if (
			station &&
			(original.source !== 'station' ||
				original.deviceId !== station.deviceId ||
				original.actorKind !== caller.actor.kind ||
				original.actorId !== caller.actor.id)
		) {
			throw notFound()
		}
		// A dish's rows are taken back together (`undoWasteDish`), never one by one.
		if (original.groupId !== null) throw notFound()
		const done = await tx
			.select({ id: invWaste.id })
			.from(invWaste)
			.where(eq(invWaste.reversesId, original.id))
			.get()
		if (done) throw new InventoryError('already_undone', 409)
		// A later correction already changed the figure: the undo would reverse the wrong amount.
		const corrected = await tx
			.select({ id: invWasteCorrections.id })
			.from(invWasteCorrections)
			.where(eq(invWasteCorrections.wasteId, original.id))
			.get()
		if (corrected) throw new InventoryError('already_corrected', 409)
		if (
			ctx.now - original.createdAt >
			(station?.windowMs ?? WASTE_UNDO_WINDOW_MS)
		) {
			throw new InventoryError('undo_expired', 409)
		}
		// The item's unit changed since this was logged: the reversal would put
		// the old quantity into stock counted in the new unit.
		if (original.itemId) {
			const changes = (await loadUnitChanges(tx, [original.itemId])).get(
				original.itemId,
			)
			if (changes?.some((change) => change.at > original.createdAt)) {
				throw new InventoryError('undo_expired', 409)
			}
		}
		const id = newId()
		const businessDate = await locationBusinessDate(
			tx,
			original.locationId,
			ctx.now,
		)
		await tx.insert(invWaste).values({
			id,
			locationId: original.locationId,
			itemId: original.itemId,
			dishRef: original.dishRef,
			quantity: original.quantity,
			reason: original.reason,
			note: null,
			valueMinor: original.valueMinor,
			currency: original.currency,
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			clientId: input.clientId,
			reversesId: original.id,
			businessDate,
			source: station ? 'station' : 'operator',
			deviceId: station?.deviceId ?? null,
			createdAt: ctx.now,
		})
		if (original.itemId) {
			await tx.insert(invMovements).values({
				locationId: original.locationId,
				itemId: original.itemId,
				quantity: original.quantity,
				valueMinor: original.valueMinor,
				currency: original.currency,
				kind: 'waste',
				reason: original.reason,
				sourceType: 'waste',
				sourceId: id,
				eventKey: `waste-undo:${original.id}`,
				businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				createdAt: ctx.now,
			})
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'waste.undo',
			resourceType: 'waste',
			resourceId: original.id,
			locationId: original.locationId,
			at: ctx.now,
		})
		const row = await tx
			.select()
			.from(invWaste)
			.where(eq(invWaste.id, id))
			.get()
		return (await entriesFor(tx, [row!], caller.cost))[0]!
	})
}

// ── Corrections (#522) ──────────────────────────────────────────────────────

/** The correction rows of waste rows, oldest first. */
async function loadCorrections(
	db: InventoryReader,
	wasteIds: readonly string[],
): Promise<Map<string, CorrectionRow[]>> {
	const rows = await queryInChunks(wasteIds, (chunk) =>
		db
			.select()
			.from(invWasteCorrections)
			.where(inArray(invWasteCorrections.wasteId, chunk))
			.orderBy(invWasteCorrections.createdAt, sql`rowid`),
	)
	const byWaste = new Map<string, CorrectionRow[]>()
	for (const row of rows) {
		const list = byWaste.get(row.wasteId)
		if (list) list.push(row)
		else byWaste.set(row.wasteId, [row])
	}
	return byWaste
}

/** What a row counts for now: its quantity, or the latest correction's. */
const currentQuantityOf = (
	row: Pick<WasteRow, 'quantity'>,
	corrections: readonly CorrectionRow[] | undefined,
): number =>
	corrections && corrections.length > 0
		? corrections[corrections.length - 1]!.newQuantity
		: row.quantity

/** The row's money at another quantity, in proportion (exact integer math). */
function valueAt(
	row: Pick<WasteRow, 'valueMinor' | 'quantity'>,
	quantity: number,
): number | null {
	if (row.valueMinor === null) return null
	if (quantity === row.quantity) return row.valueMinor
	const numerator = BigInt(row.valueMinor) * BigInt(quantity)
	const divisor = BigInt(row.quantity)
	return Number((numerator + divisor / 2n) / divisor)
}

/**
 * Entries an approved count already covers: a full or quick count at the
 * place, approved after the entry was logged, that has a figure for its item
 * (the count's instant is the time of its latest entry, as food cost reads it).
 * A correction after that moves no stock: the count measured the shelves
 * with the waste already gone.
 */
async function countCovered(
	db: InventoryReader,
	rows: readonly WasteRow[],
): Promise<Set<string>> {
	const covered = new Set<string>()
	const byLocation = new Map<string, WasteRow[]>()
	for (const row of rows) {
		if (!row.itemId) continue
		const list = byLocation.get(row.locationId)
		if (list) list.push(row)
		else byLocation.set(row.locationId, [row])
	}
	for (const [locationId, list] of byLocation) {
		const earliest = Math.min(...list.map((row) => row.createdAt))
		const counts = await db
			.select({ id: invCounts.id, approvedAt: invCounts.approvedAt })
			.from(invCounts)
			.where(
				and(
					eq(invCounts.locationId, locationId),
					eq(invCounts.status, 'approved'),
					gte(invCounts.approvedAt, earliest),
				),
			)
		if (counts.length === 0) continue
		const instants = await countInstants(
			db,
			counts.map((count) => count.id),
		)
		const at = new Map(
			counts.map((count) => [
				count.id,
				instants.get(count.id) ?? count.approvedAt!,
			]),
		)
		const entries = await queryInChunks(
			counts.map((count) => count.id),
			(chunk) =>
				db
					.select({
						countId: invCountEntries.countId,
						itemId: invCountEntries.itemId,
					})
					.from(invCountEntries)
					.where(inArray(invCountEntries.countId, chunk)),
		)
		const counted = new Map<string, number>()
		for (const entry of entries) {
			const instant = at.get(entry.countId)!
			const best = counted.get(entry.itemId)
			// The latest count that covers the item decides.
			if (best === undefined || instant > best)
				counted.set(entry.itemId, instant)
		}
		for (const row of list) {
			const instant = counted.get(row.itemId!)
			if (instant !== undefined && instant > row.createdAt) covered.add(row.id)
		}
	}
	return covered
}

/** Waste rows as wire entries, with item names, who undid them and what was corrected. */
async function entriesFor(
	db: InventoryReader,
	rows: readonly WasteRow[],
	cost: boolean,
): Promise<WasteEntry[]> {
	const itemIds = [
		...new Set(
			rows.map((row) => row.itemId).filter((id): id is string => !!id),
		),
	]
	const [items, reversals, corrections, covered] = await Promise.all([
		queryInChunks(itemIds, (chunk) =>
			db
				.select({
					id: invItems.id,
					name: invItems.name,
					category: invItems.category,
					baseUnit: invItems.baseUnit,
				})
				.from(invItems)
				.where(inArray(invItems.id, chunk)),
		),
		queryInChunks(
			rows.map((row) => row.id),
			(reversalChunk) =>
				db
					.select({ reversesId: invWaste.reversesId, at: invWaste.createdAt })
					.from(invWaste)
					.where(inArray(invWaste.reversesId, reversalChunk)),
		),
		loadCorrections(
			db,
			rows.map((row) => row.id),
		),
		countCovered(
			db,
			rows.filter((row) => row.reversesId === null),
		),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const undone = new Map(reversals.map((row) => [row.reversesId, row.at]))
	const unitChanges = await loadUnitChanges(
		db,
		rows.flatMap((row) => (row.itemId ? [row.itemId] : [])),
	)
	return rows.map((row) => {
		const item = row.itemId ? itemById.get(row.itemId) : undefined
		const shown = (quantity: number) =>
			row.itemId
				? quantityInCurrentUnit(
						quantity,
						row.createdAt,
						unitChanges.get(row.itemId) ?? [],
					)
				: quantity
		const entry: WasteEntry = {
			id: row.id,
			locationId: row.locationId,
			itemId: row.itemId,
			itemName: item?.name ?? null,
			category: item?.category ?? null,
			baseUnit: item?.baseUnit ?? null,
			// Logged in the unit the item had then; shown in today's.
			quantity: shown(row.quantity),
			reason: row.reason,
			note: row.note,
			actor: { kind: row.actorKind, id: row.actorId },
			businessDate: row.businessDate,
			createdAt: row.createdAt,
			undoneAt: undone.get(row.id) ?? null,
			reversesId: row.reversesId,
		}
		if (cost && row.valueMinor !== null) {
			entry.valueMinor = row.valueMinor
			if (row.currency) entry.currency = row.currency
		}
		const own = corrections.get(row.id)
		if (own && own.length > 0) {
			const current = currentQuantityOf(row, own)
			entry.currentQuantity = shown(current)
			entry.corrections = own.map((correction) =>
				toCorrection(correction, shown, cost),
			)
			const value = valueAt(row, current)
			if (cost && value !== null) entry.currentValueMinor = value
		}
		if (row.reversesId === null && row.itemId) {
			entry.countedSince = covered.has(row.id)
		}
		return entry
	})
}

function toCorrection(
	row: CorrectionRow,
	shown: (quantity: number) => number,
	cost: boolean,
): WasteCorrection {
	const out: WasteCorrection = {
		id: row.id,
		kind: row.kind,
		previousQuantity: shown(row.previousQuantity),
		newQuantity: shown(row.newQuantity),
		stockEffect: row.stockEffect,
		reason: row.reason,
		actor: { kind: row.actorKind, id: row.actorId },
		createdAt: row.createdAt,
	}
	if (cost && row.valueDeltaMinor !== null) {
		out.valueDeltaMinor = row.valueDeltaMinor
		if (row.currency) out.currency = row.currency
	}
	return out
}

/** A dish group as one wire entry: "2 x <dish>", its ingredients summed. */
async function groupEntriesFor(
	db: InventoryReader,
	headers: readonly DishRow[],
	cost: boolean,
): Promise<WasteEntry[]> {
	if (headers.length === 0) return []
	const rows = await queryInChunks(
		headers.map((header) => header.id),
		(chunk) =>
			db.select().from(invWaste).where(inArray(invWaste.groupId, chunk)),
	)
	const originals = rows.filter((row) => row.reversesId === null)
	const [corrections, covered] = await Promise.all([
		loadCorrections(
			db,
			originals.map((row) => row.id),
		),
		countCovered(db, originals),
	])
	const reversedAt = new Map<string, number>()
	for (const row of rows) {
		if (row.reversesId !== null) {
			reversedAt.set(row.reversesId, row.createdAt)
		}
	}
	return headers.map((header): WasteEntry => {
		const own = originals.filter((row) => row.groupId === header.id)
		const original = own.reduce((sum, row) => sum + row.quantity, 0)
		const current = own.reduce(
			(sum, row) => sum + currentQuantityOf(row, corrections.get(row.id)),
			0,
		)
		const times = own.flatMap((row) => {
			const at = reversedAt.get(row.id)
			return at === undefined ? [] : [at]
		})
		const priced = own.filter((row) => row.valueMinor !== null)
		const value = priced.reduce((sum, row) => sum + row.valueMinor!, 0)
		const currentValue = priced.reduce(
			(sum, row) =>
				sum +
				(valueAt(row, currentQuantityOf(row, corrections.get(row.id))) ?? 0),
			0,
		)
		const dishes =
			original === 0
				? header.quantity
				: Math.round((header.quantity * current) / original)
		const groupCorrections = new Map<string, CorrectionRow[]>()
		for (const row of own) {
			for (const correction of corrections.get(row.id) ?? []) {
				// One correction of the dish is one row per ingredient, written together.
				const key = `${correction.createdAt}:${correction.kind}`
				const list = groupCorrections.get(key)
				if (list) list.push(correction)
				else groupCorrections.set(key, [correction])
			}
		}
		const entry: WasteEntry = {
			id: header.id,
			locationId: header.locationId,
			itemId: null,
			itemName: null,
			category: null,
			baseUnit: null,
			quantity: header.quantity,
			reason: header.reason,
			note: header.note,
			actor: { kind: header.actorKind, id: header.actorId },
			businessDate: header.businessDate,
			createdAt: header.createdAt,
			undoneAt:
				own.length > 0 && times.length === own.length
					? Math.max(...times)
					: null,
			reversesId: null,
			dish: {
				groupId: header.id,
				menuItemId: header.menuItemId,
				variantId: header.variantId,
				options: parseOptions(header.options),
				dishes: header.quantity,
				basis: header.basis,
				ingredients: own.filter((row) => row.itemId !== null).length,
			},
			countedSince: own.some((row) => covered.has(row.id)),
		}
		if (cost && priced.length > 0) {
			entry.valueMinor = value
			const currency = priced[0]!.currency
			if (currency) entry.currency = currency
		}
		if (groupCorrections.size > 0) {
			entry.currentQuantity = dishes
			if (cost && priced.length > 0) entry.currentValueMinor = currentValue
			entry.corrections = [...groupCorrections.values()]
				.sort((a, b) => a[0]!.createdAt - b[0]!.createdAt)
				.map((list) => {
					const first = list[0]!
					const before = list.reduce((sum, c) => sum + c.previousQuantity, 0)
					const after = list.reduce((sum, c) => sum + c.newQuantity, 0)
					const total = own.reduce((sum, row) => sum + row.quantity, 0)
					return {
						id: first.id,
						kind: first.kind,
						previousQuantity: Math.round((header.quantity * before) / total),
						newQuantity: Math.round((header.quantity * after) / total),
						stockEffect: list.some((c) => c.stockEffect === 'applied')
							? 'applied'
							: list.some((c) => c.stockEffect === 'covered_by_count')
								? 'covered_by_count'
								: 'none',
						reason: first.reason,
						actor: { kind: first.actorKind, id: first.actorId },
						createdAt: first.createdAt,
						...(cost
							? {
									valueDeltaMinor: list.reduce(
										(sum, c) => sum + (c.valueDeltaMinor ?? 0),
										0,
									),
									...(first.currency ? { currency: first.currency } : {}),
								}
							: {}),
					} satisfies WasteCorrection
				})
		}
		return entry
	})
}

function parseOptions(
	raw: string | null,
): WasteEntry['dish'] extends infer D
	? D extends { options: infer O }
		? O
		: never
	: never {
	if (!raw) return [] as never
	try {
		const parsed: unknown = JSON.parse(raw)
		return (Array.isArray(parsed) ? parsed : []) as never
	} catch {
		return [] as never
	}
}

/** One entry (a logged item, or a dish group) by id, as the log shows it. */
export async function getWasteEntry(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller },
): Promise<WasteEntry> {
	const row = await db
		.select()
		.from(invWaste)
		.where(eq(invWaste.id, input.id))
		.get()
	if (row && row.reversesId === null && row.groupId === null) {
		assertLocationAllowed(input.caller.locationIds, row.locationId)
		return (await entriesFor(db, [row], input.caller.cost))[0]!
	}
	const header = await db
		.select()
		.from(invWasteDishes)
		.where(eq(invWasteDishes.id, input.id))
		.get()
	if (!header) throw notFound()
	assertLocationAllowed(input.caller.locationIds, header.locationId)
	return (await groupEntriesFor(db, [header], input.caller.cost))[0]!
}

export async function listWaste(
	db: InventoryReader,
	input: { query: ListWasteQuery; cost: boolean },
) {
	const { query } = input
	const cursor = decodeCursor(query.cursor)
	const [rows, headers] = await Promise.all([
		db
			.select()
			.from(invWaste)
			.where(
				and(
					eq(invWaste.locationId, query.locationId),
					gte(invWaste.businessDate, query.from),
					lte(invWaste.businessDate, query.to),
					isNull(invWaste.reversesId),
					// A dish's ingredient rows are shown as the dish, below.
					isNull(invWaste.groupId),
					query.reason ? eq(invWaste.reason, query.reason) : undefined,
					cursor
						? or(
								sql`${invWaste.createdAt} < ${cursor.sort}`,
								and(
									eq(invWaste.createdAt, cursor.sort),
									sql`${invWaste.id} < ${cursor.id}`,
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(invWaste.createdAt), desc(invWaste.id))
			.limit(query.limit + 1),
		db
			.select()
			.from(invWasteDishes)
			.where(
				and(
					eq(invWasteDishes.locationId, query.locationId),
					gte(invWasteDishes.businessDate, query.from),
					lte(invWasteDishes.businessDate, query.to),
					query.reason ? eq(invWasteDishes.reason, query.reason) : undefined,
					cursor
						? or(
								sql`${invWasteDishes.createdAt} < ${cursor.sort}`,
								and(
									eq(invWasteDishes.createdAt, cursor.sort),
									sql`${invWasteDishes.id} < ${cursor.id}`,
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(invWasteDishes.createdAt), desc(invWasteDishes.id))
			.limit(query.limit + 1),
	])
	type Item = { at: number; id: string; row?: WasteRow; header?: DishRow }
	const merged: Item[] = [
		...rows.map((row): Item => ({ at: row.createdAt, id: row.id, row })),
		...headers.map((header): Item => ({
			at: header.createdAt,
			id: header.id,
			header,
		})),
	].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
	const page = merged.slice(0, query.limit)
	const last = page.at(-1)
	const [single, grouped] = await Promise.all([
		entriesFor(
			db,
			page.flatMap((item) => (item.row ? [item.row] : [])),
			input.cost,
		),
		groupEntriesFor(
			db,
			page.flatMap((item) => (item.header ? [item.header] : [])),
			input.cost,
		),
	])
	const byId = new Map(
		[...single, ...grouped].map((entry) => [entry.id, entry]),
	)
	return {
		entries: page.map((item) => byId.get(item.id)!),
		nextCursor:
			merged.length > query.limit && last
				? encodeCursor(last.at, last.id)
				: null,
	}
}

type Bucket = { count: number; value: number; groups: Set<string> }

function add(
	map: Map<string, Bucket>,
	key: string,
	value: number,
	group: string | null,
) {
	const bucket = map.get(key) ?? {
		count: 0,
		value: 0,
		groups: new Set<string>(),
	}
	// A dish is one time wasted, however many ingredients it adds up to.
	if (group === null) bucket.count += 1
	else if (!bucket.groups.has(group)) {
		bucket.groups.add(group)
		bucket.count += 1
	}
	bucket.value += value
	map.set(key, bucket)
}

/**
 * Waste in a period by reason, category and day; undone entries are left out,
 * a corrected one counts at its corrected figure and a reversed one not at all
 * (#522), and a dish is one time wasted (#517).
 */
export async function wasteSummary(
	db: InventoryReader,
	input: { locationId: string; from: string; to: string; cost: boolean },
): Promise<WasteSummary> {
	const { locationId, from, to } = input
	if (to < from || daysBetween(from, to) >= MAX_SUMMARY_DAYS) {
		throw badRequest('period')
	}
	const rows = await db
		.select()
		.from(invWaste)
		.where(
			and(
				eq(invWaste.locationId, locationId),
				gte(invWaste.businessDate, from),
				lte(invWaste.businessDate, to),
				isNull(invWaste.reversesId),
			),
		)
	const reversed = await queryInChunks(
		rows.map((row) => row.id),
		(chunk) =>
			db
				.select({ reversesId: invWaste.reversesId })
				.from(invWaste)
				.where(
					and(
						isNotNull(invWaste.reversesId),
						inArray(invWaste.reversesId, chunk),
					),
				),
	)
	const undone = new Set(reversed.map((row) => row.reversesId))
	const corrections = await loadCorrections(
		db,
		rows.map((row) => row.id),
	)
	// What each live row counts for: its corrected quantity, none when reversed.
	const live = rows
		.filter((row) => !undone.has(row.id))
		.map((row) => ({
			row,
			quantity: currentQuantityOf(row, corrections.get(row.id)),
		}))
		.filter((entry) => entry.quantity > 0)
	const itemIds = [
		...new Set(
			live.map((entry) => entry.row.itemId).filter((id): id is string => !!id),
		),
	]
	const items = await queryInChunks(itemIds, (chunk) =>
		db
			.select({
				id: invItems.id,
				name: invItems.name,
				category: invItems.category,
			})
			.from(invItems)
			.where(inArray(invItems.id, chunk)),
	)
	const itemById = new Map(items.map((item) => [item.id, item]))

	const byReason = new Map<string, Bucket>()
	const byCategory = new Map<string, Bucket>()
	const byDay = new Map<string, Bucket>()
	const byItem = new Map<string, Bucket>()
	const groups = new Set<string>()
	let total = 0
	let currency: string | undefined
	for (const { row, quantity } of live) {
		const value = valueAt(row, quantity) ?? 0
		total += value
		currency ??= row.currency ?? undefined
		const group = row.groupId
		if (group === null) groups.add(row.id)
		else groups.add(group)
		add(byReason, row.reason, value, group)
		add(byDay, row.businessDate, value, group)
		const item = row.itemId ? itemById.get(row.itemId) : undefined
		add(byCategory, item?.category ?? 'other', value, group)
		if (row.itemId) add(byItem, row.itemId, value, group)
	}
	const money = input.cost
	const bucket = (b: Bucket) =>
		money ? { count: b.count, valueMinor: b.value } : { count: b.count }
	const ranked = (map: Map<string, Bucket>) =>
		[...map.entries()].sort(
			(a, b) =>
				(money ? b[1].value - a[1].value : 0) ||
				b[1].count - a[1].count ||
				(a[0] < b[0] ? -1 : 1),
		)
	const summary: WasteSummary = {
		from,
		to,
		count: groups.size,
		byReason: ranked(byReason).map(([reason, b]) => ({
			reason: reason as WasteSummary['byReason'][number]['reason'],
			...bucket(b),
		})),
		byCategory: ranked(byCategory).map(([category, b]) => ({
			category,
			...bucket(b),
		})),
		byDay: [...byDay.entries()]
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([date, b]) => ({ date, ...bucket(b) })),
		topItems: ranked(byItem)
			.slice(0, 5)
			.map(([itemId, b]) => ({
				itemId,
				itemName: itemById.get(itemId)?.name ?? '',
				...bucket(b),
			})),
	}
	if (money) {
		summary.valueMinor = total
		if (currency) summary.currency = currency
		const purchases = await db
			.select({
				total: sql<number>`coalesce(sum(${invMovements.valueMinor}), 0)`,
			})
			.from(invMovements)
			.where(
				and(
					eq(invMovements.locationId, locationId),
					eq(invMovements.kind, 'delivery'),
					gte(invMovements.businessDate, from),
					lte(invMovements.businessDate, to),
				),
			)
			.get()
		summary.purchasesMinor = Number(purchases?.total ?? 0)
	}
	return summary
}

/**
 * A later correction of a waste entry (#522): reverse it, or change its
 * quantity, with a reason. The original rows never change: each corrected row
 * gets a correction (what it was, what it is now) and the log shows both. Stock
 * moves by the difference with a `waste` movement, unless an approved count at
 * the place already covers the entry (then only the waste figures change, and
 * `stockEffect` says `covered_by_count`). `id` is a logged item's id or a dish
 * group's. This is not the undo window: it works on any entry that was not
 * undone, at any age.
 */
export async function correctWaste(
	caller: InventoryCaller,
	input: { id: string; body: CorrectWaste },
): Promise<WasteEntry> {
	const { body } = input
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const single = await tx
			.select()
			.from(invWaste)
			.where(eq(invWaste.id, input.id))
			.get()
		let header: DishRow | null = null
		let originals: WasteRow[]
		if (single) {
			// A dish's rows are corrected as the dish; a reversing row is not an entry.
			if (single.reversesId !== null || single.groupId !== null) {
				throw notFound()
			}
			originals = [single]
		} else {
			header =
				(await tx
					.select()
					.from(invWasteDishes)
					.where(eq(invWasteDishes.id, input.id))
					.get()) ?? null
			if (!header) throw notFound()
			originals = (
				await tx.select().from(invWaste).where(eq(invWaste.groupId, header.id))
			)
				.filter((row) => row.reversesId === null)
				.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
		}
		const location = header?.locationId ?? single!.locationId
		assertLocationAllowed(caller.locationIds, location)

		// A repeat of the same correction answers the same.
		const replay = await tx
			.select({ wasteId: invWasteCorrections.wasteId })
			.from(invWasteCorrections)
			.where(eq(invWasteCorrections.clientId, `${body.clientId}:0`))
			.get()
		if (replay) {
			if (!originals.some((row) => row.id === replay.wasteId)) {
				throw new InventoryError('idempotency_conflict', 409)
			}
			return
		}

		const reversals = await queryInChunks(
			originals.map((row) => row.id),
			(chunk) =>
				tx
					.select({ id: invWaste.id })
					.from(invWaste)
					.where(inArray(invWaste.reversesId, chunk)),
		)
		if (reversals.length > 0) throw new InventoryError('already_undone', 409)
		const corrections = await loadCorrections(
			tx,
			originals.map((row) => row.id),
		)
		const current = new Map(
			originals.map((row) => [
				row.id,
				currentQuantityOf(row, corrections.get(row.id)),
			]),
		)
		const currentTotal = [...current.values()].reduce((a, b) => a + b, 0)
		if (currentTotal === 0) throw new InventoryError('already_reversed', 409)

		// Quantities after the correction, per row.
		const next = new Map<string, number>()
		if (body.kind === 'reverse') {
			for (const row of originals) next.set(row.id, 0)
		} else if (header) {
			if (body.dishes === undefined) throw badRequest('dishes')
			const wasDishes = Math.max(
				1,
				Math.round(
					(header.quantity * currentTotal) /
						originals.reduce((s, r) => s + r.quantity, 0),
				),
			)
			for (const row of originals) {
				const was = current.get(row.id)!
				next.set(
					row.id,
					was === 0
						? 0
						: Math.max(1, Math.round((was * body.dishes) / wasDishes)),
				)
			}
		} else {
			if (body.amount === undefined || body.unit === undefined) {
				throw badRequest('amount')
			}
			const row = originals[0]!
			if (!row.itemId) throw badRequest('amount')
			const item = await tx
				.select()
				.from(invItems)
				.where(eq(invItems.id, row.itemId))
				.get()
			if (!item) throw notFound()
			const units = await loadItemUnits(tx, [item.id])
			const typed = typedToBase(
				body.amount,
				body.unit,
				item.baseUnit,
				units.get(item.id) ?? [],
			)
			if (typed.quantity <= 0) throw badRequest('amount')
			next.set(row.id, typed.quantity)
		}
		// The unit of an item changed since: the stored figure is in another unit.
		const unitChanges = await loadUnitChanges(
			tx,
			originals.flatMap((row) => (row.itemId ? [row.itemId] : [])),
		)
		for (const row of originals) {
			if (
				row.itemId &&
				unitChanges.get(row.itemId)?.some((change) => change.at > row.createdAt)
			) {
				throw new InventoryError('invalid_request', 409, {
					reason: 'unit_changed',
				})
			}
		}
		const changed = originals.filter(
			(row) => next.get(row.id) !== current.get(row.id),
		)
		if (changed.length === 0) throw badRequest('unchanged')

		const covered = await countCovered(tx, originals)
		const businessDate = await locationBusinessDate(tx, location, ctx.now)
		let applied = 0
		let skipped = 0
		for (const [index, row] of changed.entries()) {
			const before = current.get(row.id)!
			const after = next.get(row.id)!
			const id = newId()
			const stockEffect = !row.itemId
				? 'none'
				: covered.has(row.id)
					? 'covered_by_count'
					: 'applied'
			const valueBefore = valueAt(row, before)
			const valueAfter = valueAt(row, after)
			await tx.insert(invWasteCorrections).values({
				id,
				clientId: `${body.clientId}:${index}`,
				wasteId: row.id,
				groupId: header?.id ?? null,
				kind: after === 0 ? 'reverse' : 'quantity',
				previousQuantity: before,
				newQuantity: after,
				valueDeltaMinor:
					valueBefore === null || valueAfter === null
						? null
						: valueAfter - valueBefore,
				currency: row.valueMinor === null ? null : row.currency,
				stockEffect,
				reason: body.reason,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				businessDate,
				createdAt: ctx.now,
			})
			if (stockEffect === 'applied') {
				applied += 1
				await tx.insert(invMovements).values({
					locationId: row.locationId,
					itemId: row.itemId!,
					// Waste that goes down gives stock back; waste that goes up takes more.
					quantity: before - after,
					valueMinor:
						valueBefore === null || valueAfter === null
							? null
							: valueBefore - valueAfter,
					currency:
						valueBefore === null || valueAfter === null ? null : row.currency,
					kind: 'waste',
					reason: row.reason,
					sourceType: 'waste_correction',
					sourceId: id,
					eventKey: `waste-correction:${id}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
				})
			} else if (stockEffect === 'covered_by_count') {
				skipped += 1
			}
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'waste.correct',
			resourceType: 'waste',
			resourceId: input.id,
			locationId: location,
			detail: {
				kind: body.kind,
				rows: changed.length,
				stockMoved: applied,
				coveredByCount: skipped,
			},
			at: ctx.now,
		})
	})
	return getWasteEntry(await getTenantDb(caller.orgId), {
		id: input.id,
		caller,
	})
}
