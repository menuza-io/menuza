import { desiredUsage, parseSaleLines } from '@repo/inventory'
import { restaurantOrders } from '@repo/tenant-db'
import { and, eq, gte, lt, sql } from 'drizzle-orm'

import { type InventoryReader } from '../lib/inventory-write.ts'
import { locationBusinessDate } from './inventory-common.ts'
import { buildRecipeStore } from './inventory-recipe-store.ts'
import { ownersOf } from './inventory-sales-service.ts'

/**
 * What confirmed catering orders will take out of stock (#513). The need is
 * worked out from the order's own lines and the recipes in force at the event
 * time, with the same expansion a sale uses (`desiredUsage`), so a tray of
 * sandwiches becomes its servings and ingredients exactly as it will when it is
 * sold. Nothing is stored: every read recomputes it from the orders that are
 * confirmed right now, so a cancelled order (or one that was never paid) adds
 * nothing and its need is gone the moment it is cancelled.
 *
 * A line with no recipe is not counted and is listed as "no recipe", so the
 * kitchen knows that part of the order is not in the figures.
 */

export type CateringNeed = {
	orderId: string
	eventAt: number
	/** The location's business date of the event. */
	date: string
	/** Base thousandths of each stock item this order will use. */
	usage: Map<string, number>
	/** Dish names with no recipe, so not counted. */
	noRecipe: string[]
}

/** Confirmed catering orders of a location whose event falls in `[fromMs, toMs)`. */
export async function cateringNeeds(
	db: InventoryReader,
	input: { locationId: string; fromMs: number; toMs: number },
): Promise<CateringNeed[]> {
	const orders = await db
		.select({
			id: restaurantOrders.id,
			lines: restaurantOrders.lines,
			eventAt: restaurantOrders.cateringEventAt,
		})
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.isCatering, true),
				eq(restaurantOrders.locationId, input.locationId),
				// Confirmed: the deposit (or the whole total) cleared and it still stands.
				eq(restaurantOrders.paymentStatus, 'paid'),
				sql`${restaurantOrders.status} not in ('cancelled', 'expired', 'payment_review')`,
				gte(restaurantOrders.cateringEventAt, new Date(input.fromMs)),
				lt(restaurantOrders.cateringEventAt, new Date(input.toMs)),
			),
		)
	const needs: CateringNeed[] = []
	for (const order of orders) {
		if (!order.eventAt) continue
		const at = order.eventAt.getTime()
		const lines = parseSaleLines(order.lines, 'restaurant')
		const rawNames = (Array.isArray(order.lines) ? order.lines : []).map(
			(line) =>
				typeof (line as { itemName?: unknown }).itemName === 'string'
					? (line as { itemName: string }).itemName
					: '',
		)
		const { store } = await buildRecipeStore(db, {
			at,
			owners: ownersOf(lines, []),
		})
		const usage = desiredUsage({
			store,
			locationId: input.locationId,
			at,
			source: { kind: 'restaurant_order', state: 'counted', lines },
		})
		const byItem = new Map<string, number>()
		for (const entry of usage.sale) {
			byItem.set(entry.itemId, (byItem.get(entry.itemId) ?? 0) + entry.quantity)
		}
		needs.push({
			orderId: order.id,
			eventAt: at,
			date: await locationBusinessDate(db, input.locationId, at),
			usage: byItem,
			noRecipe: usage.unrecipedLines
				.map((line) => rawNames[line.index] ?? '')
				.filter(Boolean),
		})
	}
	return needs
}

/** What catering needs of each item on one business date (prep adds it on the right day). */
export async function cateringCommittedForDate(
	db: InventoryReader,
	locationId: string,
	date: string,
): Promise<Map<string, number>> {
	// Any location timezone offset is within ±1 day of UTC midnight for `date`,
	// so two days before through three days after covers the whole local day.
	const dayMs = Date.parse(`${date}T00:00:00Z`)
	const needs = await cateringNeeds(db, {
		locationId,
		fromMs: dayMs - 2 * 86_400_000,
		toMs: dayMs + 3 * 86_400_000,
	})
	const out = new Map<string, number>()
	for (const need of needs) {
		if (need.date !== date) continue
		for (const [itemId, quantity] of need.usage) {
			out.set(itemId, (out.get(itemId) ?? 0) + quantity)
		}
	}
	return out
}

/** Days ahead suggested orders look for catering (an order placed now arrives within it). */
export const CATERING_ORDER_HORIZON_DAYS = 14

/** What upcoming catering will use of each item, for suggested orders. */
export async function cateringNeedByItem(
	db: InventoryReader,
	locationId: string,
	now: number,
): Promise<Map<string, number>> {
	const needs = await cateringNeeds(db, {
		locationId,
		fromMs: now,
		toMs: now + CATERING_ORDER_HORIZON_DAYS * 86_400_000,
	})
	const out = new Map<string, number>()
	for (const need of needs) {
		for (const [itemId, quantity] of need.usage) {
			out.set(itemId, (out.get(itemId) ?? 0) + quantity)
		}
	}
	return out
}

/** Merges two item-to-quantity maps. */
export function addDemand(
	a: ReadonlyMap<string, number>,
	b: ReadonlyMap<string, number>,
): Map<string, number> {
	const out = new Map(a)
	for (const [itemId, quantity] of b) {
		out.set(itemId, (out.get(itemId) ?? 0) + quantity)
	}
	return out
}
