/**
 * Slow sellers (#261): menu dishes ranked from the fewest sold. Pure: no I/O.
 *
 * The menu (control plane) says which dishes exist; sales (region) say how
 * many sold. Joining them is what lets a dish that sold nothing appear at all
 * (it is in no sales row). Only ids, names, counts and money are used: no
 * guest data.
 *
 * Rules
 * - Dishes that sold nothing come first, then the fewest sold.
 * - A dish added during the period is `new`: it is listed after the ranked
 *   dishes, not against a full month.
 * - A dish counts only for the days it was available. Sold-out and hidden
 *   time is left out of "days since last sold", and a dish that was not
 *   available the whole period is ranked on its sales per available day
 *   (scaled to the period), so being sold out does not push a dish down.
 */

import { z } from 'zod'

/** Most dishes a roster carries (a bound, not a business rule). */
export const MENU_ROSTER_MAX_DISHES = 5_000

export const menuRosterSchema = z.object({
	orgId: z.string().min(1).max(64),
	dishes: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				/** As the menu stores it: a plain name or a JSON language map. */
				name: z.string().max(500),
				/** Epoch ms the dish was created. */
				createdAt: z.number(),
				/** `available` or not (sold out, hidden by the menu). */
				availabilityStatus: z.string().max(40),
				/** Epoch ms a timed "unavailable until" ends, when set. */
				unavailableUntil: z.number().nullable().default(null),
				categoryId: z.string().max(100).default(''),
				categoryName: z.string().max(500).default(''),
				menuId: z.string().max(100).default(''),
				menuName: z.string().max(500).default(''),
				/** Menu price in major units, for a food cost percentage. */
				price: z.number().min(0).default(0),
				/** Locations where an override hides or disables the dish now. */
				hiddenLocationIds: z.array(z.string().max(100)).max(500).default([]),
			}),
		)
		.max(MENU_ROSTER_MAX_DISHES),
	locations: z
		.array(z.object({ id: z.string().max(100), name: z.string().max(300) }))
		.max(500)
		.default([]),
})
export type MenuRoster = z.infer<typeof menuRosterSchema>
export type RosterDish = MenuRoster['dishes'][number]

export type SlowSellerStatus = 'ranked' | 'new' | 'limited'

export type SlowSellerRow = {
	itemId: string
	name: string
	categoryId: string
	categoryName: string
	currency: string
	quantity: number
	salesMinor: number
	/** 0 to 100: the share of the period's orders that had this dish. */
	shareOfOrders: number
	/** Available days since last sold (see the module note). */
	daysSinceLastSold: number
	availableWholePeriod: boolean
	status: SlowSellerStatus
	/** The order of the list: lowest first, new dishes after the ranked ones. */
	sortKey: number
	foodCostPercent: number | null
}

export type SlowSellerSales = {
	itemId: string
	quantity: number
	salesMinor: number
	/** Orders (sales) that had the dish. */
	orders: number
	/** Epoch ms of the latest sale of the dish. */
	lastSoldMs: number
}

export type Interval = { startMs: number; endMs: number | null }

export type SlowSellerInput = {
	dishes: readonly RosterDish[]
	/** Sales by dish for one currency, already narrowed to the location and channel. */
	sales: ReadonlyMap<string, SlowSellerSales>
	/** Orders in the period for that currency, with the same narrowing. */
	totalOrders: number
	window: { fromMs: number; toMs: number }
	/** Sold-out windows by dish (the sold-out history), epoch ms. */
	unavailable: ReadonlyMap<string, readonly Interval[]>
	currency: string
	/** Food cost percent by dish, when the cost grant and recipes allow it. */
	foodCostPercent?: ReadonlyMap<string, number>
	/** The location filter, when one is set: a dish hidden there counts as hidden. */
	locationId?: string | null
	now: number
}

const DAY_MS = 86_400_000

/** Epoch ms ranges merged and clipped to `[from, to]`. */
export function mergeIntervals(
	intervals: readonly Interval[],
	from: number,
	to: number,
): Array<[number, number]> {
	const clipped = intervals
		.map((interval): [number, number] => [
			Math.max(from, interval.startMs),
			Math.min(to, interval.endMs ?? to),
		])
		.filter(([start, end]) => end > start)
		.sort((a, b) => a[0] - b[0])
	const merged: Array<[number, number]> = []
	for (const [start, end] of clipped) {
		const last = merged[merged.length - 1]
		if (last && start <= last[1]) last[1] = Math.max(last[1], end)
		else merged.push([start, end])
	}
	return merged
}

/**
 * The time every one of `sets` is on at once (a dish counts as off in a
 * report over several locations only while it is off at all of them). An empty
 * `sets` has nothing in common.
 */
export function intersectIntervalSets(
	sets: ReadonlyArray<ReadonlyArray<[number, number]>>,
): Array<[number, number]> {
	if (sets.length === 0) return []
	let common = sets[0]!.map((pair): [number, number] => [pair[0], pair[1]])
	for (const next of sets.slice(1)) {
		const out: Array<[number, number]> = []
		for (const [aStart, aEnd] of common) {
			for (const [bStart, bEnd] of next) {
				const start = Math.max(aStart, bStart)
				const end = Math.min(aEnd, bEnd)
				if (end > start) out.push([start, end])
			}
		}
		common = out
	}
	return common
}

function unavailableMs(
	merged: ReadonlyArray<[number, number]>,
	from: number,
	to: number,
): number {
	return merged
		.map(([start, end]) => Math.max(0, Math.min(end, to) - Math.max(start, from)))
		.reduce((sum, value) => sum + value, 0)
}

function round1(value: number) {
	return Math.round(value * 10) / 10
}

/**
 * Ranks the dishes of one currency. Returns one row per dish in the list's
 * order (lowest `sortKey` first).
 */
export function rankSlowSellers(input: SlowSellerInput): SlowSellerRow[] {
	const { window } = input
	const periodMs = Math.max(1, window.toMs - window.fromMs)
	const periodDays = periodMs / DAY_MS
	const rows: SlowSellerRow[] = []
	for (const dish of input.dishes) {
		const sold = input.sales.get(dish.id)
		const quantity = sold?.quantity ?? 0
		const hiddenHere =
			input.locationId != null && dish.hiddenLocationIds.includes(input.locationId)
		const stillUnavailable =
			dish.availabilityStatus !== 'available' &&
			!(dish.unavailableUntil !== null && dish.unavailableUntil <= input.now)
		// A dish added in the period only counts from the day it was added.
		const added = dish.createdAt > window.fromMs
		const liveFrom = added ? Math.min(dish.createdAt, window.toMs) : window.fromMs
		const merged = mergeIntervals(
			input.unavailable.get(dish.id) ?? [],
			liveFrom,
			window.toMs,
		)
		// Hidden or sold out right now with no recorded start: the whole period
		// is left out (it is unknown since when, and a dish nobody can order
		// has not had a chance to sell).
		const offMs =
			hiddenHere || stillUnavailable
				? window.toMs - liveFrom
				: unavailableMs(merged, liveFrom, window.toMs)
		const liveMs = Math.max(0, window.toMs - liveFrom)
		const availableMs = Math.max(0, liveMs - offMs)
		const availableDays = availableMs / DAY_MS
		const availableWholePeriod = !added && offMs === 0

		let daysSinceLastSold: number
		if (sold && sold.lastSoldMs > 0) {
			const since = Math.max(liveFrom, Math.min(sold.lastSoldMs, window.toMs))
			const gap = mergeIntervals(
				input.unavailable.get(dish.id) ?? [],
				since,
				window.toMs,
			)
			const offSince =
				hiddenHere || stillUnavailable
					? window.toMs - since
					: unavailableMs(gap, since, window.toMs)
			daysSinceLastSold = round1(Math.max(0, window.toMs - since - offSince) / DAY_MS)
		} else {
			// Not sold in the period: it has gone at least this many available days.
			daysSinceLastSold = round1(availableDays)
		}

		const status: SlowSellerStatus = added
			? 'new'
			: availableWholePeriod
				? 'ranked'
				: 'limited'
		// A dish that was not available the whole period is judged on the days it
		// could sell, scaled to the period, so sold-out time never ranks it down.
		const scaled =
			status === 'limited' && availableDays > 0
				? quantity * (periodDays / availableDays)
				: quantity
		rows.push({
			itemId: dish.id,
			name: dish.name,
			categoryId: dish.categoryId,
			categoryName: dish.categoryName,
			currency: input.currency,
			quantity,
			salesMinor: sold?.salesMinor ?? 0,
			shareOfOrders:
				sold && input.totalOrders > 0
					? round1((sold.orders / input.totalOrders) * 100)
					: 0,
			daysSinceLastSold,
			availableWholePeriod,
			status,
			sortKey:
				status === 'new' ? 1_000_000_000 + quantity : round1(scaled),
			foodCostPercent: input.foodCostPercent?.get(dish.id) ?? null,
		})
	}
	// Ties keep the menu's own order, so the list does not shuffle between runs.
	return rows.sort((a, b) => a.sortKey - b.sortKey)
}
