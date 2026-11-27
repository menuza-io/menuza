import {
	inventoryValueMinorClamped,
	remainingLots,
	useByFromShelfLife,
	validateConfirmedLots,
	type Freshness,
	type FreshnessRow,
	type ItemLots,
	type LotStock,
	type StockLot,
} from '@repo/inventory'
import {
	invItemCosts,
	invItemPlaces,
	invItems,
	invLotTakes,
	invStockLots,
	invWaste,
	type InvStockLotRow,
} from '@repo/tenant-db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { addDays } from '@repo/reservations'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	badRequest,
	locationClock,
	notFound,
	onHandByItem,
	stateConflict,
	wireUnit,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { resolveLocationTime } from './inventory-location-settings.ts'
import { logWaste } from './inventory-waste-service.ts'

/**
 * Use-by dates on stock (#479). The ledger stays the one stock record: a lot
 * only says that some quantity arrived with a date, and what is left of it is
 * read through `remainingLots` (oldest date first). Writers that lower stock
 * need no knowledge of lots; the ones that name a lot (waste of expired stock,
 * a cancelled delivery) record a take.
 *
 * Everything is behind `inventory.use_by`: with the flag off nothing is
 * recorded here and the routes answer 403 `feature_disabled`.
 */

/** Rows listed under each heading of Today. */
const FRESHNESS_LIMIT = 20
/** A date further than this from today is a typing mistake. */
const DATE_PAST_DAYS = 366
const DATE_FUTURE_DAYS = 3650

export function assertUseByEnabled(caller: InventoryCaller): void {
	if (!caller.features?.useBy) {
		throw new InventoryError('feature_disabled', 403, { feature: 'useBy' })
	}
}

function lotOf(row: InvStockLotRow): StockLot {
	return {
		id: row.id,
		useByDate: row.useByDate,
		quantity: row.quantity,
		baseline: row.baseline,
		createdAt: row.createdAt,
	}
}

/**
 * The dated stock of items at one location: lots, takes and the ledger's
 * on-hand figure, folded by `remainingLots`. `itemIds` null reads every item
 * that has a lot.
 */
export async function loadLotStocks(
	db: InventoryReader,
	input: {
		locationId: string
		itemIds: readonly string[] | null
		today: string
	},
): Promise<Map<string, LotStock>> {
	const lotRows: InvStockLotRow[] =
		input.itemIds === null
			? await db
					.select()
					.from(invStockLots)
					.where(eq(invStockLots.locationId, input.locationId))
			: await queryInChunks(input.itemIds, (chunk) =>
					db
						.select()
						.from(invStockLots)
						.where(
							and(
								eq(invStockLots.locationId, input.locationId),
								inArray(invStockLots.itemId, chunk),
							),
						),
				)
	const byItem = new Map<string, InvStockLotRow[]>()
	for (const row of lotRows) {
		const list = byItem.get(row.itemId)
		if (list) list.push(row)
		else byItem.set(row.itemId, [row])
	}
	const takeRows = await queryInChunks(
		lotRows.map((row) => row.id),
		(chunk) =>
			db
				.select({ lotId: invLotTakes.lotId, quantity: invLotTakes.quantity })
				.from(invLotTakes)
				.where(inArray(invLotTakes.lotId, chunk)),
	)
	const onHand = await onHandByItem(db, input.locationId)
	const out = new Map<string, LotStock>()
	for (const [itemId, rows] of byItem) {
		const ids = new Set(rows.map((row) => row.id))
		out.set(
			itemId,
			remainingLots({
				onHand: onHand.get(itemId) ?? 0,
				lots: rows.map(lotOf),
				takes: takeRows.filter((take) => ids.has(take.lotId)),
				today: input.today,
			}),
		)
	}
	return out
}

/** `GET /items/:id/lots?locationId=`. */
export async function getItemLots(
	db: InventoryReader,
	input: { itemId: string; locationId: string; caller: InventoryCaller; now: number },
): Promise<ItemLots> {
	assertUseByEnabled(input.caller)
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const item = await db
		.select()
		.from(invItems)
		.where(eq(invItems.id, input.itemId))
		.get()
	if (!item) throw notFound()
	const clock = await locationClock(db, input.locationId, input.now)
	const stocks = await loadLotStocks(db, {
		locationId: input.locationId,
		itemIds: [item.id],
		today: clock.date,
	})
	const stock = stocks.get(item.id)
	const sources = new Map(
		(
			await db
				.select({ id: invStockLots.id, source: invStockLots.sourceType })
				.from(invStockLots)
				.where(
					and(
						eq(invStockLots.locationId, input.locationId),
						eq(invStockLots.itemId, item.id),
					),
				)
		).map((row) => [row.id, row.source]),
	)
	const place = await db
		.select({ countUnit: invItemPlaces.countUnit })
		.from(invItemPlaces)
		.where(
			and(
				eq(invItemPlaces.itemId, item.id),
				eq(invItemPlaces.locationId, input.locationId),
			),
		)
		.get()
	const onHand = (await onHandByItem(db, input.locationId)).get(item.id) ?? 0
	return {
		itemId: item.id,
		locationId: input.locationId,
		date: clock.date,
		trackByDate: item.trackByDate,
		baseUnit: item.baseUnit,
		countUnit: place?.countUnit ? wireUnit(place.countUnit) : null,
		onHand,
		undated: stock?.undated ?? Math.max(0, onHand),
		lots: (stock?.lots ?? []).map((lot) => ({
			id: lot.id,
			useByDate: lot.useByDate,
			remaining: lot.remaining,
			daysLeft: lot.daysLeft,
			status: lot.status,
			source: sources.get(lot.id) ?? 'delivery',
		})),
	}
}

/**
 * Today's "Use first" and "Expired" lists: tracked items with dated stock
 * left, soonest date first. A lot with a use-by date today or in the next two
 * days is "use first"; past the date it is expired.
 */
export async function getFreshness(
	db: InventoryReader,
	input: { locationId: string; caller: InventoryCaller; now: number },
): Promise<Freshness> {
	const { caller, locationId } = input
	const clock = await locationClock(db, locationId, input.now)
	const empty = (): Freshness => ({
		locationId,
		date: clock.date,
		expired: [],
		useFirst: [],
		expiredCount: 0,
		useFirstCount: 0,
	})
	const stocks = await loadLotStocks(db, {
		locationId,
		itemIds: null,
		today: clock.date,
	})
	if (stocks.size === 0) return empty()
	const itemIds = [...stocks.keys()]
	const [items, places, costs] = await Promise.all([
		queryInChunks(itemIds, (chunk) =>
			db
				.select()
				.from(invItems)
				.where(and(inArray(invItems.id, chunk), isNull(invItems.archivedAt))),
		),
		queryInChunks(itemIds, (chunk) =>
			db
				.select({
					itemId: invItemPlaces.itemId,
					countUnit: invItemPlaces.countUnit,
				})
				.from(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.locationId, locationId),
						// bounded: its own statement, one chunk of at most 90 ids
						inArray(invItemPlaces.itemId, chunk),
					),
				),
		),
		queryInChunks(itemIds, (chunk) =>
			db.select().from(invItemCosts).where(inArray(invItemCosts.itemId, chunk)),
		),
	])
	const itemById = new Map(items.map((item) => [item.id, item]))
	const placeById = new Map(places.map((row) => [row.itemId, row.countUnit]))
	const costById = new Map(costs.map((row) => [row.itemId, row]))
	const expired: FreshnessRow[] = []
	const useFirst: FreshnessRow[] = []
	for (const [itemId, stock] of stocks) {
		const item = itemById.get(itemId)
		// Only items still tracked by date: turning it off clears the lists.
		if (!item || !item.trackByDate) continue
		for (const lot of stock.lots) {
			if (lot.status === 'ok') continue
			const cost = costById.get(itemId)
			const row: FreshnessRow = {
				lotId: lot.id,
				itemId,
				itemName: item.name,
				baseUnit: item.baseUnit,
				countUnit: placeById.get(itemId) ? wireUnit(placeById.get(itemId)!) : null,
				useByDate: lot.useByDate,
				remaining: lot.remaining,
				daysLeft: lot.daysLeft,
				status: lot.status,
			}
			if (caller.cost && cost?.avgCostMicro != null) {
				row.valueMinor = inventoryValueMinorClamped(
					lot.remaining,
					cost.avgCostMicro,
				)
				row.currency = cost.currency
			}
			;(lot.status === 'expired' ? expired : useFirst).push(row)
		}
	}
	const order = (a: FreshnessRow, b: FreshnessRow) =>
		(a.useByDate < b.useByDate ? -1 : a.useByDate > b.useByDate ? 1 : 0) ||
		a.itemName.localeCompare(b.itemName)
	expired.sort(order)
	useFirst.sort(order)
	return {
		locationId,
		date: clock.date,
		expired: expired.slice(0, FRESHNESS_LIMIT),
		useFirst: useFirst.slice(0, FRESHNESS_LIMIT),
		expiredCount: expired.length,
		useFirstCount: useFirst.length,
	}
}

// ── Recording ───────────────────────────────────────────────────────────────

function assertDateInRange(date: string, today: string): void {
	if (date < addDays(today, -DATE_PAST_DAYS)) throw badRequest('use_by_date')
	if (date > addDays(today, DATE_FUTURE_DAYS)) throw badRequest('use_by_date')
}

/**
 * Notes a received (or made) quantity with its use-by date, for an item
 * tracked by date. The date is the one typed, else the shelf life from
 * `receivedAt` in the location's time zone, else nothing is recorded. Runs in
 * the writer's own transaction. Never refuses a delivery for a missing date.
 */
export async function recordLotForReceipt(
	tx: InventoryTx,
	input: {
		caller: InventoryCaller
		locationId: string
		item: { id: string; trackByDate: boolean; shelfLifeHours: number | null }
		quantity: number
		sourceType: 'delivery' | 'batch'
		sourceId: string
		useByDate?: string | null
		receivedAt: number
		now: number
	},
): Promise<{ useByDate: string } | null> {
	if (!input.caller.features?.useBy) return null
	if (!input.item.trackByDate || input.quantity <= 0) return null
	let useByDate = input.useByDate ?? null
	if (!useByDate) {
		if (input.item.shelfLifeHours === null) return null
		const time = await resolveLocationTime(tx, input.locationId)
		useByDate = useByFromShelfLife({
			at: input.receivedAt,
			shelfLifeHours: input.item.shelfLifeHours,
			timeZone: time.timeZone ?? 'UTC',
		})
	} else {
		const clock = await locationClock(tx, input.locationId, input.now)
		assertDateInRange(useByDate, clock.date)
	}
	await tx.insert(invStockLots).values({
		locationId: input.locationId,
		itemId: input.item.id,
		useByDate,
		quantity: input.quantity,
		sourceType: input.sourceType,
		sourceId: input.sourceId,
		baseline: false,
		createdAt: input.now,
	})
	return { useByDate }
}

/**
 * A cancelled delivery takes its own lots back out (the cancel's movement
 * lowers the ledger by the same amount), so the dates of stock that never
 * arrived do not push other lots off the front.
 */
export async function takeLotsOfCancelledDelivery(
	tx: InventoryTx,
	input: { lineIds: readonly string[]; now: number },
): Promise<void> {
	if (input.lineIds.length === 0) return
	const lots = await queryInChunks(input.lineIds, (chunk) =>
		tx
			.select()
			.from(invStockLots)
			.where(
				and(
					eq(invStockLots.sourceType, 'delivery'),
					inArray(invStockLots.sourceId, chunk),
				),
			),
	)
	if (lots.length === 0) return
	const taken = await queryInChunks(
		lots.map((lot) => lot.id),
		(chunk) =>
			tx
				.select({ lotId: invLotTakes.lotId, quantity: invLotTakes.quantity })
				.from(invLotTakes)
				.where(inArray(invLotTakes.lotId, chunk)),
	)
	for (const lot of lots) {
		const used = taken
			.filter((take) => take.lotId === lot.id)
			.reduce((sum, take) => sum + take.quantity, 0)
		const left = lot.quantity - used
		if (left <= 0) continue
		await tx.insert(invLotTakes).values({
			lotId: lot.id,
			quantity: left,
			reason: 'delivery_cancel',
			sourceId: lot.sourceId,
			createdAt: input.now,
		})
	}
}

/**
 * `POST /items/:id/lots/confirm`: a person checked the dates on the shelf.
 * The dates become the item's baseline at the location; stock beyond them
 * stays undated. Counts can confirm dates this way or just totals.
 */
export async function confirmLots(
	caller: InventoryCaller,
	input: {
		itemId: string
		body: {
			clientId: string
			locationId: string
			lots: { useByDate: string; quantity: number }[]
		}
		idempotency: InventoryIdempotency
	},
): Promise<ItemLots> {
	assertUseByEnabled(caller)
	assertLocationAllowed(caller.locationIds, input.body.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const item = await tx
				.select()
				.from(invItems)
				.where(eq(invItems.id, input.itemId))
				.get()
			if (!item || item.archivedAt !== null) throw notFound()
			if (!item.trackByDate) throw stateConflict('not_tracked_by_date')
			const clock = await locationClock(tx, input.body.locationId, ctx.now)
			const onHand =
				(await onHandByItem(tx, input.body.locationId)).get(item.id) ?? 0
			const verdict = validateConfirmedLots(input.body.lots, onHand)
			if (verdict !== 'ok') throw badRequest(`lots_${verdict}`)
			for (const lot of input.body.lots) assertDateInRange(lot.useByDate, clock.date)
			for (const lot of input.body.lots) {
				await tx.insert(invStockLots).values({
					locationId: input.body.locationId,
					itemId: item.id,
					useByDate: lot.useByDate,
					quantity: lot.quantity,
					sourceType: 'confirm',
					sourceId: `${input.body.clientId}:${lot.useByDate}`,
					baseline: true,
					createdAt: ctx.now,
				})
			}
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'lots.confirm',
				resourceType: 'item',
				resourceId: item.id,
				locationId: input.body.locationId,
				detail: { dates: input.body.lots.length },
				at: ctx.now,
			})
			return getItemLots(tx, {
				itemId: item.id,
				locationId: input.body.locationId,
				caller,
				now: ctx.now,
			})
		},
	)
}

/**
 * `POST /lots/:lotId/waste`: one tap from the Expired list. The stock of that
 * date is thrown away as waste (reason `expired`) through the one waste writer,
 * and taken from that date, not from the oldest one.
 */
export async function wasteLot(
	caller: InventoryCaller,
	input: {
		lotId: string
		body: { clientId: string; locationId: string; quantity?: number }
		idempotency: InventoryIdempotency
		now?: number
	},
): Promise<{
	wasteId: string
	itemId: string
	quantity: number
	valueMinor?: number
	currency?: string
	duplicate: boolean
}> {
	assertUseByEnabled(caller)
	assertLocationAllowed(caller.locationIds, input.body.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const lot = await tx
				.select()
				.from(invStockLots)
				.where(eq(invStockLots.id, input.lotId))
				.get()
			if (!lot || lot.locationId !== input.body.locationId) throw notFound()
			const item = await tx
				.select()
				.from(invItems)
				.where(eq(invItems.id, lot.itemId))
				.get()
			if (!item || item.archivedAt !== null) throw notFound()

			// A replay of the same tap: the waste entry already exists.
			const earlier = await tx
				.select({ id: invWaste.id, quantity: invWaste.quantity })
				.from(invWaste)
				.where(eq(invWaste.clientId, input.body.clientId))
				.get()
			if (earlier) {
				return {
					wasteId: earlier.id,
					itemId: item.id,
					quantity: earlier.quantity,
					duplicate: true,
				}
			}

			const clock = await locationClock(tx, lot.locationId, input.now ?? ctx.now)
			const stock = (
				await loadLotStocks(tx, {
					locationId: lot.locationId,
					itemIds: [item.id],
					today: clock.date,
				})
			).get(item.id)
			const left = stock?.lots.find((row) => row.id === lot.id)?.remaining ?? 0
			if (left <= 0) throw stateConflict('lot_empty')
			const quantity = input.body.quantity ?? left
			if (quantity > left) throw badRequest('quantity_exceeds_lot')

			const logged = await logWaste(
				caller,
				{
					entries: [
						{
							clientId: input.body.clientId,
							locationId: lot.locationId,
							itemId: item.id,
							amount: quantity / 1000,
							unit: item.baseUnit,
							reason: 'expired',
						},
					],
				},
				{},
			)
			const accepted = logged.accepted[0]
			if (!accepted) throw stateConflict('waste_not_recorded')
			await tx.insert(invLotTakes).values({
				lotId: lot.id,
				quantity,
				reason: 'expired_waste',
				sourceId: accepted.id,
				createdAt: ctx.now,
			})
			return {
				wasteId: accepted.id,
				itemId: item.id,
				quantity,
				...(accepted.valueMinor !== undefined
					? { valueMinor: accepted.valueMinor, currency: accepted.currency }
					: {}),
				duplicate: false,
			}
		},
	)
}
