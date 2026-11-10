import { type Compare, type CompareRow } from '@repo/inventory'
import { addDays } from '@repo/reservations'
import { invCounts, invTransfers } from '@repo/tenant-db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { locationClock } from './inventory-common.ts'
import { computeFoodCost } from './inventory-food-cost.ts'
import {
	type InventoryCaller,
	loadLocationStock,
	stockValueMinor,
} from './inventory-items-service.ts'
import { getInventorySettings } from './inventory-settings-service.ts'
import { wasteSummary } from './inventory-waste-service.ts'

/**
 * The same few numbers for each location the person may see, so a chain owner
 * spots the branch that is off: items low and out, the last approved count,
 * waste this week, transfers waiting, and (with the cost grant) stock value,
 * waste cost and food cost. Locations the token does not cover are left out,
 * never answered with an error (the App names the locations it knows).
 */
export async function compareLocations(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationIds: readonly string[]
		now: number
	},
): Promise<Compare> {
	const { caller } = input
	const allowed = input.locationIds.filter(
		(id) => caller.locationIds === null || caller.locationIds.includes(id),
	)
	const settings = await getInventorySettings(db, caller.region)
	const rows: CompareRow[] = []
	let date = ''
	for (const locationId of allowed) {
		const clock = await locationClock(db, locationId, input.now)
		date ||= clock.date
		const [stock, waste, lastCount, incoming, outgoing] = await Promise.all([
			loadLocationStock(db, locationId),
			wasteSummary(db, {
				locationId,
				from: addDays(clock.date, -6),
				to: clock.date,
				cost: caller.cost,
			}),
			db
				.select({ at: sql<number | null>`max(${invCounts.approvedAt})` })
				.from(invCounts)
				.where(
					and(
						eq(invCounts.locationId, locationId),
						eq(invCounts.status, 'approved'),
					),
				)
				.get(),
			db
				.select({ n: sql<number>`count(*)` })
				.from(invTransfers)
				.where(
					and(
						eq(invTransfers.toLocationId, locationId),
						eq(invTransfers.status, 'sent'),
					),
				)
				.get(),
			db
				.select({ n: sql<number>`count(*)` })
				.from(invTransfers)
				.where(
					and(
						eq(invTransfers.fromLocationId, locationId),
						inArray(invTransfers.status, ['requested', 'draft']),
					),
				)
				.get(),
		])
		const row: CompareRow = {
			locationId,
			lowItems: stock.filter((entry) => entry.status === 'low').length,
			outItems: stock.filter((entry) => entry.status === 'out').length,
			lastCountAt: lastCount?.at ?? null,
			wasteWeekCount: waste.count,
			incomingTransfers: Number(incoming?.n ?? 0),
			outgoingTransfers: Number(outgoing?.n ?? 0),
		}
		if (caller.cost) {
			let value = 0
			let currency: string | undefined
			for (const entry of stock) {
				value += stockValueMinor(entry.onHand, entry.cost) ?? 0
				currency ??= entry.cost?.currency
			}
			row.stockValueMinor = value
			row.wasteWeekMinor = waste.valueMinor ?? 0
			const food = await computeFoodCost(db, {
				locationId,
				targetBp: settings.targetFoodCostBp,
			})
			row.foodCost = {
				state: food.state,
				bp: food.bp ?? null,
				targetBp: food.targetBp,
			}
			currency ??= waste.currency
			if (currency) row.currency = currency
		}
		rows.push(row)
	}
	return { date, rows }
}
