import {
	computeDaysLeft,
	DAYS_LEFT_HISTORY_DAYS,
	isCountStale,
	quantityInCurrentUnit,
	type DailyUse,
	type DaysLeftOut,
} from '@repo/inventory'
import { addDays } from '@repo/reservations'
import { invItemGroupMembers, invItems, invMovements } from '@repo/tenant-db'
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { loadUnitChanges } from './inventory-history.ts'
import { type StockRow } from './inventory-items-service.ts'

/**
 * Days of stock left (#492). Use is what the ledger already records: dishes
 * sold (`sale` movements from recipes), waste and batches made (`batch_used`),
 * and stock sent out to another place (`transfer_out`, so a transfer counts as
 * use only at the sending location). Per location, last 28 days, and never a
 * second usage series: the weekday and Ramadan weighting is `weekdayDemand`
 * from prep, reached through `computeDaysLeft`.
 *
 * Older rows are brought to the item's current unit (#494); the history of a
 * duplicate merged into an item (#493) counts for the kept item; a group's use
 * is its members' use in group units (#495).
 */
const USE_KINDS = ['sale', 'waste', 'batch_used', 'transfer_out'] as const

export async function loadUseHistory(
	db: InventoryReader,
	locationId: string,
	today: string,
): Promise<Map<string, DailyUse[]>> {
	const from = addDays(today, -DAYS_LEFT_HISTORY_DAYS)
	const [grouped, changes, merged, members] = await Promise.all([
		db
			.select({
				itemId: invMovements.itemId,
				date: invMovements.businessDate,
				total: sql<number>`sum(${invMovements.quantity})`,
			})
			.from(invMovements)
			.where(
				and(
					eq(invMovements.locationId, locationId),
					gte(invMovements.businessDate, from),
					lt(invMovements.businessDate, today),
					inArray(invMovements.kind, [...USE_KINDS]),
				),
			)
			.groupBy(invMovements.itemId, invMovements.businessDate),
		loadUnitChanges(db),
		db
			.select({ id: invItems.id, into: invItems.mergedIntoId })
			.from(invItems)
			.where(isNotNull(invItems.mergedIntoId)),
		db.select().from(invItemGroupMembers),
	])
	// itemId -> date -> signed quantity (negative is use).
	const byItem = new Map<string, Map<string, number>>()
	const add = (itemId: string, date: string, quantity: number) => {
		const days = byItem.get(itemId) ?? new Map<string, number>()
		days.set(date, (days.get(date) ?? 0) + quantity)
		byItem.set(itemId, days)
	}
	const changed = new Set(changes.keys())
	for (const row of grouped) {
		if (changed.has(row.itemId)) continue
		add(row.itemId, row.date, Number(row.total))
	}
	if (changed.size > 0) {
		// Items whose unit changed: convert each row by when it was written.
		const raw = await queryInChunks([...changed], (chunk) =>
			db
				.select({
					itemId: invMovements.itemId,
					date: invMovements.businessDate,
					quantity: invMovements.quantity,
					createdAt: invMovements.createdAt,
				})
				.from(invMovements)
				.where(
					and(
						eq(invMovements.locationId, locationId),
						gte(invMovements.businessDate, from),
						lt(invMovements.businessDate, today),
						inArray(invMovements.kind, [...USE_KINDS]),
						inArray(invMovements.itemId, chunk),
					),
				),
		)
		for (const row of raw) {
			add(
				row.itemId,
				row.date,
				quantityInCurrentUnit(
					row.quantity,
					row.createdAt,
					changes.get(row.itemId) ?? [],
				),
			)
		}
	}
	for (const row of merged) {
		const days = byItem.get(row.id)
		if (!days) continue
		for (const [date, quantity] of days) add(row.into!, date, quantity)
	}
	for (const member of members) {
		const days = byItem.get(member.memberItemId)
		if (!days) continue
		for (const [date, quantity] of days) {
			add(
				member.groupItemId,
				date,
				Math.round((quantity * member.groupQuantity) / member.memberQuantity),
			)
		}
	}
	const history = new Map<string, DailyUse[]>()
	for (const [itemId, days] of byItem) {
		history.set(
			itemId,
			[...days.entries()]
				.map(([date, signed]) => ({ date, quantity: Math.max(0, -signed) }))
				.filter((day) => day.quantity > 0),
		)
	}
	return history
}

/** Days left for each stock row (archived rows get none). */
export async function loadDaysLeft(
	db: InventoryReader,
	input: {
		locationId: string
		today: string
		now: number
		rows: readonly StockRow[]
	},
): Promise<Map<string, DaysLeftOut>> {
	const history = await loadUseHistory(db, input.locationId, input.today)
	const out = new Map<string, DaysLeftOut>()
	for (const row of input.rows) {
		if (row.item.archivedAt !== null) continue
		const left = computeDaysLeft({
			today: input.today,
			onHand: row.onHand,
			history: history.get(row.item.id) ?? [],
		})
		out.set(row.item.id, {
			...left,
			stale: isCountStale(row.lastCountedAt, input.now),
		})
	}
	return out
}
