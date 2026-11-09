import {
	inventoryValueMinor,
	PICKABLE_WASTE_REASONS,
	WASTE_UNDO_WINDOW_MS,
	type WasteEntry,
	type WasteSummary,
} from '@repo/inventory'
import { daysBetween } from '@repo/reservations'
import { invItemCosts, invItems, invMovements, invWaste } from '@repo/tenant-db'
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
	 * `refused` and the others are saved, instead of failing the request.
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
		const refused: Array<{ clientId: string; code: string }> = []
		const lateSync: string[] = []
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
			const item = itemById.get(entry.itemId)
			if (!item || item.archivedAt !== null) {
				if (station) {
					refused.push({
						clientId: entry.clientId,
						code: item ? 'item_archived' : 'not_found',
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
					refused.push({ clientId: entry.clientId, code: error.code })
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
				createdAt: ctx.now,
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
				createdAt: ctx.now,
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
		const done = await tx
			.select({ id: invWaste.id })
			.from(invWaste)
			.where(eq(invWaste.reversesId, original.id))
			.get()
		if (done) throw new InventoryError('already_undone', 409)
		if (
			ctx.now - original.createdAt >
			(station?.windowMs ?? WASTE_UNDO_WINDOW_MS)
		) {
			throw new InventoryError('undo_expired', 409)
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

/** Waste rows as wire entries, with item names and who undid them. */
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
	const [items, reversals] = await Promise.all([
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
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const undone = new Map(reversals.map((row) => [row.reversesId, row.at]))
	return rows.map((row) => {
		const item = row.itemId ? itemById.get(row.itemId) : undefined
		const entry: WasteEntry = {
			id: row.id,
			locationId: row.locationId,
			itemId: row.itemId,
			itemName: item?.name ?? null,
			category: item?.category ?? null,
			baseUnit: item?.baseUnit ?? null,
			quantity: row.quantity,
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
		return entry
	})
}

export async function listWaste(
	db: InventoryReader,
	input: { query: ListWasteQuery; cost: boolean },
) {
	const { query } = input
	const cursor = decodeCursor(query.cursor)
	const rows = await db
		.select()
		.from(invWaste)
		.where(
			and(
				eq(invWaste.locationId, query.locationId),
				gte(invWaste.businessDate, query.from),
				lte(invWaste.businessDate, query.to),
				isNull(invWaste.reversesId),
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
		.limit(query.limit + 1)
	const page = rows.slice(0, query.limit)
	const last = page.at(-1)
	return {
		entries: await entriesFor(db, page, input.cost),
		nextCursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	}
}

type Bucket = { count: number; value: number }

function add(map: Map<string, Bucket>, key: string, value: number) {
	const bucket = map.get(key) ?? { count: 0, value: 0 }
	bucket.count += 1
	bucket.value += value
	map.set(key, bucket)
}

/** Waste in a period by reason, category and day; undone entries are left out. */
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
	const live = rows.filter((row) => !undone.has(row.id))
	const itemIds = [
		...new Set(
			live.map((row) => row.itemId).filter((id): id is string => !!id),
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
	let total = 0
	let currency: string | undefined
	for (const row of live) {
		const value = row.valueMinor ?? 0
		total += value
		currency ??= row.currency ?? undefined
		add(byReason, row.reason, value)
		add(byDay, row.businessDate, value)
		const item = row.itemId ? itemById.get(row.itemId) : undefined
		add(byCategory, item?.category ?? 'other', value)
		if (row.itemId) add(byItem, row.itemId, value)
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
		count: live.length,
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
