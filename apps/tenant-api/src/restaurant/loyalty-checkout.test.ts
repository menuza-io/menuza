import {
	type PricedOrderLine,
	type PricedRestaurantOrder,
} from '@repo/common/restaurant-orders'
import {
	computeRewardDiscount,
	loyaltyCartSchema,
	LoyaltyDomainError,
	type LoyaltyRewardDefinition,
} from '@repo/loyalty'
import { type RestaurantOrder } from '@repo/tenant-db'
import { describe, expect, it } from 'vitest'
import {
	applyLoyaltyDiscountToTotals,
	discountedTabTotals,
	loyaltyCartForPricedOrder,
} from './loyalty-checkout.ts'
import {
	expandTabAllocation,
	LOYALTY_CART_MAX_LINES,
	tabCartLines,
	tabLoyaltyCart,
} from './loyalty-sources.ts'

function line(overrides: Partial<PricedOrderLine> = {}): PricedOrderLine {
	const merged = {
		itemId: 'item_1',
		itemName: 'Item',
		variantId: null,
		quantity: 1,
		unitPriceCents: 1000,
		taxableUnitCents: 1000,
		instructions: null,
		options: [] as PricedOrderLine['options'],
		baseUnitCents: 1000,
		categoryIds: [] as string[],
		...overrides,
	}
	return {
		...merged,
		totalCents: overrides.totalCents ?? merged.unitPriceCents * merged.quantity,
		taxableCents:
			overrides.taxableCents ?? merged.taxableUnitCents * merged.quantity,
	}
}

function priced(
	overrides: Partial<PricedRestaurantOrder> = {},
): PricedRestaurantOrder {
	const lines = overrides.lines ?? [line()]
	const subtotalCents =
		overrides.subtotalCents ?? lines.reduce((sum, l) => sum + l.totalCents, 0)
	const taxRatePercent = overrides.taxRatePercent ?? 10
	const taxInclusive = overrides.taxInclusive ?? false
	const taxable = lines.reduce((sum, l) => sum + l.taxableCents, 0)
	const taxCents =
		overrides.taxCents ??
		(taxInclusive
			? Math.round((taxable * taxRatePercent) / (100 + taxRatePercent))
			: Math.round((taxable * taxRatePercent) / 100))
	const tipCents = overrides.tipCents ?? 0
	const deliveryFeeCents = overrides.deliveryFeeCents ?? 0
	return {
		currency: 'USD',
		lines,
		subtotalCents,
		taxCents,
		taxInclusive,
		taxRatePercent,
		tipCents,
		tipPercent: 0,
		deliveryFeeCents,
		totalCents:
			subtotalCents +
			(taxInclusive ? 0 : taxCents) +
			tipCents +
			deliveryFeeCents,
		location: { id: 'loc_1', name: 'Main', timezone: 'UTC' },
		pickup: null,
		drop: null,
		delivery: null,
		scheduledFor: null,
		holdMinutes: 15,
		capacity: null,
		...overrides,
	}
}

describe('applyLoyaltyDiscountToTotals', () => {
	it('tax-exclusive: a discount on taxable lines lowers tax and total', () => {
		const order = priced({
			lines: [
				line({ unitPriceCents: 1000, taxableUnitCents: 1000 }),
				line({ itemId: 'item_2', unitPriceCents: 500, taxableUnitCents: 500 }),
			],
		})
		// subtotal 1500, tax 150, total 1650
		const result = applyLoyaltyDiscountToTotals(
			order,
			[{ lineId: '0', discountMinor: 400 }],
			400,
		)
		expect(result).toEqual({
			loyaltyDiscountCents: 400,
			taxCents: 110, // (600 + 500) * 10%
			totalCents: 1210, // 1500 - 400 + 110
		})
	})

	it('a discount on a non-taxable line lowers the total but not the tax', () => {
		const order = priced({
			lines: [
				line({ unitPriceCents: 500, taxableUnitCents: 0, taxableCents: 0 }),
				line({
					itemId: 'item_2',
					unitPriceCents: 1000,
					taxableUnitCents: 1000,
				}),
			],
		})
		const result = applyLoyaltyDiscountToTotals(
			order,
			[{ lineId: '0', discountMinor: 400 }],
			400,
		)
		expect(result).toEqual({
			loyaltyDiscountCents: 400,
			taxCents: 100, // still 1000 * 10%
			totalCents: 1200, // 1500 - 400 + 100
		})
	})

	it('tax-inclusive: total is subtotal - discount + tip + fee, reported tax shrinks', () => {
		const order = priced({
			lines: [line({ unitPriceCents: 1100, taxableUnitCents: 1100 })],
			taxInclusive: true,
			tipCents: 100,
			deliveryFeeCents: 50,
		})
		// subtotal 1100, reported tax 100, total 1250
		expect(order.taxCents).toBe(100)
		expect(order.totalCents).toBe(1250)
		const result = applyLoyaltyDiscountToTotals(
			order,
			[{ lineId: '0', discountMinor: 200 }],
			200,
		)
		expect(result).toEqual({
			loyaltyDiscountCents: 200,
			taxCents: 82, // 900 * 10 / 110
			totalCents: 1050, // 1100 - 200 + 100 + 50
		})
	})

	it('a full discount zeroes tax and total (tip and fee still apply)', () => {
		const order = priced({
			lines: [line({ unitPriceCents: 1000, taxableUnitCents: 1000 })],
		})
		const result = applyLoyaltyDiscountToTotals(
			order,
			[{ lineId: '0', discountMinor: 1000 }],
			1000,
		)
		expect(result).toEqual({
			loyaltyDiscountCents: 1000,
			taxCents: 0,
			totalCents: 0,
		})
	})

	it('never lets the discount exceed the subtotal', () => {
		const order = priced({
			lines: [line({ unitPriceCents: 1000, taxableUnitCents: 1000 })],
		})
		const result = applyLoyaltyDiscountToTotals(
			order,
			[{ lineId: '0', discountMinor: 1000 }],
			5000,
		)
		expect(result.loyaltyDiscountCents).toBe(1000)
		expect(result.totalCents).toBe(0)
	})

	it('throws cart_changed for an allocation line the order does not have', () => {
		const order = priced()
		try {
			applyLoyaltyDiscountToTotals(
				order,
				[{ lineId: '9', discountMinor: 100 }],
				100,
			)
			expect.unreachable()
		} catch (error) {
			expect(error).toBeInstanceOf(LoyaltyDomainError)
			expect((error as LoyaltyDomainError).code).toBe('cart_changed')
		}
	})

	it('percent reward with a cap: computeRewardDiscount allocation drives the totals', () => {
		const order = priced({
			lines: [line({ unitPriceCents: 2000, taxableUnitCents: 2000 })],
		})
		const definition: LoyaltyRewardDefinition = {
			kind: 'order',
			name: 'Half off, capped',
			description: null,
			pointsCost: 10,
			discount: { type: 'percent', percentBp: 5000, maxDiscountMinor: 400 },
			labels: { items: {}, categories: {} },
		}
		const cart = loyaltyCartForPricedOrder(order)
		const result = computeRewardDiscount({ currency: 'USD', definition }, cart)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.discountMinor).toBe(400) // 50% of 2000 capped at 400
		expect(result.lines).toEqual([
			{ lineId: '0', discountMinor: 400, rewardUnits: 0 },
		])
		const totals = applyLoyaltyDiscountToTotals(
			order,
			result.lines,
			result.discountMinor,
		)
		expect(totals).toEqual({
			loyaltyDiscountCents: 400,
			taxCents: 160, // 1600 * 10%
			totalCents: 1760, // 2000 - 400 + 160
		})
	})
})

describe('loyaltyCartForPricedOrder', () => {
	it('builds the neutral cart with positional line ids and no other discounts', () => {
		const order = priced({
			lines: [
				line({
					quantity: 2,
					unitPriceCents: 1000,
					baseUnitCents: 800,
					categoryIds: ['cat_a'],
				}),
				line({
					itemId: 'item_2',
					variantId: 'var_1',
					unitPriceCents: 500,
					baseUnitCents: 500,
				}),
			],
		})
		const cart = loyaltyCartForPricedOrder(order)
		expect(cart.currency).toBe('USD')
		expect(cart.otherDiscountMinor).toBe(0)
		expect(cart.lines).toEqual([
			{
				lineId: '0',
				itemId: 'item_1',
				variantId: null,
				categoryIds: ['cat_a'],
				quantity: 2,
				unitBaseMinor: 800,
				unitMinor: 1000,
			},
			{
				lineId: '1',
				itemId: 'item_2',
				variantId: 'var_1',
				categoryIds: [],
				quantity: 1,
				unitBaseMinor: 500,
				unitMinor: 500,
			},
		])
	})
})

describe('a tab with more lines than a cart holds', () => {
	/** A stored round of identical 10.00 lines (the cart's own cap is 200). */
	function round(id: string, count: number, quantity = 1): RestaurantOrder {
		const lines = Array.from({ length: count }, () =>
			line({ quantity, unitPriceCents: 1000, taxableUnitCents: 1000 }),
		)
		const subtotalCents = lines.reduce((sum, l) => sum + l.totalCents, 0)
		return {
			id,
			status: 'confirmed',
			lines,
			subtotalCents,
			taxCents: Math.round(subtotalCents * 0.1),
			tipCents: 0,
			deliveryFeeCents: 0,
			totalCents: subtotalCents + Math.round(subtotalCents * 0.1),
		} as unknown as RestaurantOrder
	}

	const rounds = [round('r1', 150), round('r2', 150), round('r3', 50)]

	it('quotes as one cart: same lines merge and quantities add', () => {
		const cart = tabLoyaltyCart({ currency: 'USD' }, rounds)
		expect(cart.lines.length).toBeLessThanOrEqual(LOYALTY_CART_MAX_LINES)
		expect(loyaltyCartSchema.safeParse(cart).success).toBe(true)
		expect(cart.lines.reduce((sum, l) => sum + l.quantity, 0)).toBe(350)
		expect(cart.lines[0]).toMatchObject({ lineId: 'r1:0', quantity: 350 })
	})

	it('splits a merged group that would pass the per-line quantity cap', () => {
		const heavy = [round('h1', 150, 5), round('h2', 150, 5)]
		const cart = tabLoyaltyCart({ currency: 'USD' }, heavy)
		expect(loyaltyCartSchema.safeParse(cart).success).toBe(true)
		expect(cart.lines.reduce((sum, l) => sum + l.quantity, 0)).toBe(1500)
		expect(Math.max(...cart.lines.map((l) => l.quantity))).toBeLessThanOrEqual(
			1000,
		)
	})

	it('keeps a tab within the cap exactly as it was, one line each', () => {
		const small = [round('s1', 3)]
		expect(tabCartLines(small).map((l) => l.lineId)).toEqual([
			's1:0',
			's1:1',
			's1:2',
		])
		const allocation = [{ lineId: 's1:1', discountMinor: 500, rewardUnits: 0 }]
		expect(expandTabAllocation(small, allocation)).toEqual(allocation)
	})

	it('totals the reward over the tab lines, spread over the merged group', () => {
		const cart = tabLoyaltyCart({ currency: 'USD' }, rounds)
		const definition: LoyaltyRewardDefinition = {
			kind: 'order',
			name: 'Thirty percent',
			description: null,
			pointsCost: 10,
			discount: { type: 'percent', percentBp: 3000, maxDiscountMinor: 200_000 },
			labels: { items: {}, categories: {} },
		}
		const result = computeRewardDiscount({ currency: 'USD', definition }, cart)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		// 30% of 350 x 10.00, under its cap.
		expect(result.discountMinor).toBe(105_000)
		const totals = discountedTabTotals(rounds, result.lines)
		expect(totals).not.toBeNull()
		expect(totals!.loyaltyDiscountCents).toBe(105_000)
		// Every stored line is named: the spread adds back to the discount.
		const spread = expandTabAllocation(rounds, result.lines)
		expect(spread.reduce((sum, share) => sum + share.discountMinor, 0)).toBe(
			105_000,
		)
		expect(spread.length).toBeGreaterThan(result.lines.length)
		for (const share of spread) {
			expect(share.discountMinor).toBeLessThanOrEqual(1000)
		}
	})

	it('spreads free units over the merged lines, one line at most its quantity', () => {
		const spread = expandTabAllocation(rounds, [
			{ lineId: 'r1:0', discountMinor: 2500, rewardUnits: 2 },
		])
		expect(spread).toEqual([
			{ lineId: 'r1:0', discountMinor: 1000, rewardUnits: 1 },
			{ lineId: 'r1:1', discountMinor: 1000, rewardUnits: 1 },
			{ lineId: 'r1:2', discountMinor: 500, rewardUnits: 0 },
		])
	})
})
