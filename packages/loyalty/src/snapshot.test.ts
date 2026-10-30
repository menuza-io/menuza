import { describe, expect, it } from 'vitest'
import {
	computeEarning,
	LOYALTY_MAX_PURCHASE_LINES,
	purchaseEligibleMinor,
} from './earning.ts'
import { buildPurchaseSnapshot, snapshotCatalogId } from './snapshot.ts'

const line = (
	lineId: string,
	grossMinor: number,
	extra: Partial<{
		itemId: string
		categoryIds: string[]
		quantity: number
		taxableMinor: number
	}> = {},
) => ({
	lineId,
	itemId: extra.itemId ?? `item-${lineId}`,
	categoryIds: extra.categoryIds ?? [],
	quantity: extra.quantity ?? 1,
	grossMinor,
	taxableMinor: extra.taxableMinor ?? grossMinor,
})

describe('buildPurchaseSnapshot', () => {
	it('keeps exclusive-tax lines as priced and subtracts the loyalty split', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'usd',
			totalPaidMinor: 2_376,
			taxMinor: 176,
			taxInclusive: false,
			lines: [line('0', 1_500), line('1', 1_000)],
			allocation: [
				{ lineId: '0', discountMinor: 180, rewardUnits: 0 },
				{ lineId: '1', discountMinor: 120, rewardUnits: 0 },
			],
		})
		expect(snapshot.currency).toBe('USD')
		expect(snapshot.lines.map((entry) => entry.netMinor)).toEqual([1_320, 880])
		expect(purchaseEligibleMinor(snapshot)).toBe(2_200)
	})

	it('takes inclusive tax out of each line by its share of the sale tax', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'SAR',
			totalPaidMinor: 2_300,
			taxMinor: 300,
			taxInclusive: true,
			lines: [line('a', 1_150), line('b', 1_150)],
		})
		expect(snapshot.lines.map((entry) => entry.netMinor)).toEqual([
			1_000, 1_000,
		])
	})

	it('weights inclusive tax by the taxable part left after discounts', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'SAR',
			totalPaidMinor: 1_725,
			taxMinor: 150,
			taxInclusive: true,
			// The second line is a non-taxable modifier-only line.
			lines: [line('a', 1_150), line('b', 575, { taxableMinor: 0 })],
		})
		expect(snapshot.lines.map((entry) => entry.netMinor)).toEqual([1_000, 575])
	})

	it('spreads a sale-level discount over the lines in proportion', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 900,
			taxMinor: 0,
			taxInclusive: false,
			lines: [line('a', 600), line('b', 400)],
			otherDiscountMinor: 100,
		})
		expect(snapshot.lines.map((entry) => entry.netMinor)).toEqual([540, 360])
	})

	it('records reward units so a free item earns no item points', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 800,
			taxMinor: 0,
			taxInclusive: false,
			lines: [line('a', 1_200, { itemId: 'latte', quantity: 3 })],
			allocation: [{ lineId: 'a', discountMinor: 400, rewardUnits: 1 }],
		})
		expect(snapshot.lines[0]).toMatchObject({ netMinor: 800, rewardUnits: 1 })
		const earned = computeEarning({
			rule: { method: 'items', points: 5, itemIds: ['latte'] },
			minimumSpendMinor: 0,
			snapshot,
		})
		expect(earned.points).toBe(10)
	})

	it('never lets a discount or tax push a line below zero', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 0,
			taxMinor: 50,
			taxInclusive: true,
			lines: [line('a', 300)],
			allocation: [{ lineId: 'a', discountMinor: 900, rewardUnits: 4 }],
		})
		expect(snapshot.lines[0]).toMatchObject({ netMinor: 0, rewardUnits: 1 })
	})

	it('rewrites catalog ids the snapshot schema would refuse', () => {
		expect(snapshotCatalogId('cat 1/ä')).toBe('cat_1__')
		expect(snapshotCatalogId('')).toBe('unknown')
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 100,
			taxMinor: 0,
			taxInclusive: false,
			lines: [line('a', 100, { categoryIds: ['x y', 'x y', 'z'] })],
		})
		expect(snapshot.lines[0]!.categoryIds).toEqual(['x_y', 'z'])
	})
})

describe('a tab with many rounds', () => {
	// A tab is one purchase made of rounds of up to 50 lines each, and nothing
	// limits the rounds. The most one table can send in an hour is 120 rounds.
	const ROUNDS = 120
	const LINES_PER_ROUND = 50
	const DISTINCT_ITEMS = 40

	const tabLines = () =>
		Array.from({ length: ROUNDS * LINES_PER_ROUND }, (_, index) =>
			line(`r${Math.floor(index / LINES_PER_ROUND)}-${index}`, 1_000, {
				itemId: `item-${index % DISTINCT_ITEMS}`,
				categoryIds: [`cat-${index % 4}`],
				quantity: 2,
			}),
		)

	it('merges lines of the same item instead of failing', () => {
		const lines = tabLines()
		expect(lines.length).toBeGreaterThan(LOYALTY_MAX_PURCHASE_LINES)
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: lines.length * 1_000,
			taxMinor: 0,
			taxInclusive: false,
			lines,
		})
		expect(snapshot.lines).toHaveLength(DISTINCT_ITEMS)
		expect(purchaseEligibleMinor(snapshot)).toBe(lines.length * 1_000)
		const perItem = (ROUNDS * LINES_PER_ROUND) / DISTINCT_ITEMS
		for (const merged of snapshot.lines) {
			expect(merged.quantity).toBe(perItem * 2)
			expect(merged.netMinor).toBe(perItem * 1_000)
		}
		// Earning reads only sums, so it matches what the separate lines earn.
		const earned = computeEarning({
			rule: { method: 'items', points: 3, itemIds: ['item-0', 'item-1'] },
			minimumSpendMinor: 0,
			snapshot,
		})
		expect(earned.points).toBe(2 * perItem * 2 * 3)
	})

	it('keeps a free item apart from paid units of the same item', () => {
		const lines = tabLines()
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: lines.length * 1_000,
			taxMinor: 0,
			taxInclusive: false,
			lines,
			allocation: [
				{ lineId: lines[0]!.lineId, discountMinor: 1_000, rewardUnits: 2 },
			],
		})
		const free = snapshot.lines.filter((entry) => entry.netMinor === 0)
		expect(free).toHaveLength(1)
		expect(free[0]).toMatchObject({
			itemId: 'item-0',
			quantity: 2,
			rewardUnits: 2,
		})
		const earned = computeEarning({
			rule: { method: 'items', points: 1, itemIds: ['item-0'] },
			minimumSpendMinor: 0,
			snapshot,
		})
		// 150 lines of item-0 at 2 units, minus the one free line.
		expect(earned.points).toBe(149 * 2)
	})

	it('leaves a purchase within the bound untouched', () => {
		const snapshot = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 2_000,
			taxMinor: 0,
			taxInclusive: false,
			lines: [line('a', 1_000), line('b', 1_000, { itemId: 'item-a' })],
		})
		expect(snapshot.lines.map((entry) => entry.lineId)).toEqual(['a', 'b'])
	})
})
