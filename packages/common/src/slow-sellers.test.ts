import { describe, expect, it } from 'vitest'
import {
	mergeIntervals,
	menuRosterSchema,
	rankSlowSellers,
	type RosterDish,
	type SlowSellerSales,
} from './slow-sellers.ts'

const DAY = 86_400_000
const TO = Date.UTC(2026, 10, 25)
const FROM = TO - 30 * DAY

function dish(id: string, over: Partial<RosterDish> = {}): RosterDish {
	return {
		id,
		name: id,
		createdAt: FROM - 100 * DAY,
		availabilityStatus: 'available',
		unavailableUntil: null,
		categoryId: 'c1',
		categoryName: 'Mains',
		menuId: 'm1',
		menuName: 'Main',
		price: 10,
		hiddenLocationIds: [],
		...over,
	}
}

function sale(
	itemId: string,
	quantity: number,
	over: Partial<SlowSellerSales> = {},
): [string, SlowSellerSales] {
	return [
		itemId,
		{
			itemId,
			quantity,
			salesMinor: quantity * 1000,
			orders: quantity,
			lastSoldMs: TO - 2 * DAY,
			...over,
		},
	]
}

function rank(
	dishes: RosterDish[],
	sales: Array<[string, SlowSellerSales]>,
	extra: Partial<Parameters<typeof rankSlowSellers>[0]> = {},
) {
	return rankSlowSellers({
		dishes,
		sales: new Map(sales),
		totalOrders: 100,
		window: { fromMs: FROM, toMs: TO },
		unavailable: new Map(),
		currency: 'USD',
		now: TO,
		...extra,
	})
}

describe('rankSlowSellers (#261)', () => {
	it('lists dishes with no sales first, then the fewest sold', () => {
		const rows = rank(
			[dish('hot'), dish('slow'), dish('never'), dish('mid')],
			[sale('hot', 90), sale('slow', 2), sale('mid', 20)],
		)
		expect(rows.map((row) => row.itemId)).toEqual(['never', 'slow', 'mid', 'hot'])
		expect(rows[0]).toMatchObject({ quantity: 0, salesMinor: 0, status: 'ranked' })
	})

	it('marks a dish added during the period New and lists it after the ranked ones', () => {
		const rows = rank(
			[dish('old-hit'), dish('fresh', { createdAt: TO - 5 * DAY })],
			[sale('old-hit', 50), sale('fresh', 1)],
		)
		expect(rows.map((row) => [row.itemId, row.status])).toEqual([
			['old-hit', 'ranked'],
			['fresh', 'new'],
		])
		// New is not "available the whole period", and its days run from when it was added.
		expect(rows[1]!.availableWholePeriod).toBe(false)
	})

	it('shows the share of orders that had the dish', () => {
		const rows = rank([dish('a')], [sale('a', 25, { orders: 20 })], {
			totalOrders: 80,
		})
		expect(rows[0]!.shareOfOrders).toBe(25)
	})

	it('leaves sold-out days out of the days since last sold', () => {
		// Sold 10 days ago, sold out for 4 of the 10 days since.
		const soldOut = [{ startMs: TO - 8 * DAY, endMs: TO - 4 * DAY }]
		const rows = rank(
			[dish('a')],
			[sale('a', 5, { lastSoldMs: TO - 10 * DAY })],
			{ unavailable: new Map([['a', soldOut]]) },
		)
		expect(rows[0]!.daysSinceLastSold).toBe(6)
		expect(rows[0]!.availableWholePeriod).toBe(false)
		expect(rows[0]!.status).toBe('limited')
	})

	it('ranks a dish that was sold out part of the period on its sales per available day', () => {
		// 10 sold in 15 available days equals 20 over the 30-day period: it must not
		// rank below a dish that sold 15 all month.
		const soldOut = [{ startMs: FROM, endMs: FROM + 15 * DAY }]
		const rows = rank(
			[dish('limited'), dish('steady')],
			[sale('limited', 10), sale('steady', 15)],
			{ unavailable: new Map([['limited', soldOut]]) },
		)
		expect(rows.map((row) => row.itemId)).toEqual(['steady', 'limited'])
		expect(rows[1]!.sortKey).toBe(20)
	})

	it('counts a dish hidden or sold out now as not available the whole period', () => {
		const rows = rank(
			[
				dish('hidden-here', { hiddenLocationIds: ['loc-1'] }),
				dish('off', { availabilityStatus: 'unavailable' }),
				dish('back-by-now', {
					availabilityStatus: 'unavailable',
					unavailableUntil: TO - DAY,
				}),
			],
			[],
			{ locationId: 'loc-1' },
		)
		const by = Object.fromEntries(rows.map((row) => [row.itemId, row]))
		expect(by['hidden-here']!.availableWholePeriod).toBe(false)
		expect(by.off!.availableWholePeriod).toBe(false)
		// A timed "unavailable until" that has passed no longer counts.
		expect(by['back-by-now']!.availableWholePeriod).toBe(true)
	})

	it('merges and clips overlapping intervals', () => {
		expect(
			mergeIntervals(
				[
					{ startMs: 0, endMs: 10 },
					{ startMs: 5, endMs: 20 },
					{ startMs: 30, endMs: null },
				],
				2,
				40,
			),
		).toEqual([
			[2, 20],
			[30, 40],
		])
	})

	it('parses a roster defensively and bounds its size', () => {
		const parsed = menuRosterSchema.parse({
			orgId: 'org_1',
			dishes: [
				{
					id: 'd1',
					name: 'Soup',
					createdAt: 1,
					availabilityStatus: 'available',
				},
			],
		})
		expect(parsed.dishes[0]).toMatchObject({
			unavailableUntil: null,
			hiddenLocationIds: [],
			price: 0,
		})
		expect(menuRosterSchema.safeParse({ orgId: '', dishes: [] }).success).toBe(false)
	})
})
