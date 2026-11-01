import { buildPurchaseSnapshot } from '@repo/loyalty'
import { type PosOrderRow } from '@repo/tenant-db'
import { describe, expect, it } from 'vitest'
import {
	tillFlagEarns,
	tillLoyaltyCart,
	tillPurchaseDiscounts,
	tillSnapshotLines,
} from './pos-loyalty-source.ts'

const line = (id: string, baseCents: number, quantity = 1) => ({
	id,
	itemId: `item-${id}`,
	name: id,
	variantId: null,
	variantLabel: null,
	quantity,
	baseCents,
	instructions: '',
	options: [],
})

const sale = (
	lines: ReturnType<typeof line>[],
	adjustments: unknown[],
): PosOrderRow =>
	({ currency: 'USD', lines, adjustments }) as unknown as PosOrderRow

const discount = (
	amountCents: number,
	lineAmounts?: Record<string, number>,
) => ({
	id: 'auto:d1',
	kind: 'discount',
	label: 'Happy hour',
	amountCents,
	...(lineAmounts ? { lineAmounts } : {}),
})

const discounted = (cart: ReturnType<typeof tillLoyaltyCart>) =>
	cart.lines.map((l) => l.discountedMinor)

describe('the till loyalty cart', () => {
	const lines = [line('a', 1000), line('b', 1000)]

	it('spreads a discount with no line amounts over the whole sale', () => {
		const cart = tillLoyaltyCart(sale(lines, [discount(1000)]), new Map())
		expect(discounted(cart)).toEqual([500, 500])
	})

	it('uses the line each discount says it took', () => {
		const cart = tillLoyaltyCart(
			sale(lines, [discount(1000, { a: 1000 })]),
			new Map(),
		)
		expect(discounted(cart)).toEqual([1000, 0])
	})

	it('spreads only what the line amounts do not cover, over what is left', () => {
		const cart = tillLoyaltyCart(
			sale(lines, [
				discount(1000, { a: 1000 }),
				{ id: 'manual:m1', kind: 'discount', label: 'Staff', amountCents: 500 },
			]),
			new Map(),
		)
		// The rest (500) lands on the line that still has value.
		expect(discounted(cart)).toEqual([1000, 500])
	})

	it('never takes more off a line than it cost, and ignores lines the sale lacks', () => {
		const cart = tillLoyaltyCart(
			sale(lines, [discount(1200, { a: 2500, ghost: 500 })]),
			new Map(),
		)
		// Line a is worth 1000; the rest of the discount lands on b.
		expect(discounted(cart)).toEqual([1000, 200])
	})
})

describe('the till purchase snapshot', () => {
	const lines = [line('food', 1000), line('drink', 1000)]
	const categories = new Map([
		['food', ['cat-food']],
		['drink', ['cat-drinks']],
	])
	const snapshotOf = (adjustments: unknown[]) => {
		const row = sale(lines, adjustments)
		const source = tillSnapshotLines(lines, categories)
		const discounts = tillPurchaseDiscounts(row, source)
		return buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 1500,
			taxMinor: 0,
			taxInclusive: false,
			lines: source,
			lineDiscounts: discounts.lineDiscounts,
			otherDiscountMinor: discounts.unattributedMinor,
		})
	}
	const net = (snapshot: ReturnType<typeof snapshotOf>) =>
		Object.fromEntries(snapshot.lines.map((l) => [l.lineId, l.netMinor]))

	it('takes a line discount off that line only, as the web path does', () => {
		const till = snapshotOf([discount(500, { drink: 500 })])
		const web = buildPurchaseSnapshot({
			currency: 'USD',
			totalPaidMinor: 1500,
			taxMinor: 0,
			taxInclusive: false,
			lines: tillSnapshotLines(lines, categories),
			lineDiscounts: [{ lineId: 'drink', discountMinor: 500 }],
		})
		expect(net(till)).toEqual({ food: 1000, drink: 500 })
		expect(net(till)).toEqual(net(web))
	})

	it('spreads only the part no line claims', () => {
		const till = snapshotOf([
			discount(500, { drink: 500 }),
			{ id: 'manual:m1', kind: 'discount', label: 'Staff', amountCents: 300 },
		])
		// 300 over what is left (1000 food, 500 drink): 200 and 100.
		expect(net(till)).toEqual({ food: 800, drink: 400 })
	})
})

describe('till sales flagged for their discounts', () => {
	it('still earn points: the charge is in doubt, not the people or the clock', () => {
		for (const reason of [
			'unknown_discount',
			'discount_approval_missing',
			'discount_stale',
			'discount_unexplained',
			'discount_amount_mismatch',
		])
			expect(tillFlagEarns(reason)).toBe(true)
		expect(tillFlagEarns('approver_not_manager')).toBe(false)
	})
})
