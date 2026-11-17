import { describe, expect, it } from 'vitest'

import { buildOrderLimitCatalogFromMenus } from './order-limit-catalog.ts'
import { orderLimitExemptFromCatalog } from './order-limit-exempt.ts'
import {
	isLargeOrder,
	largeOrderExtraMinutes,
	largeOrderRuleFrom,
	largeOrderRuleSchema,
	readLargeOrderRule,
} from './promised-time.ts'
import { orderDishUnits } from './slot-usage.ts'

/**
 * Large-order extra time (#355): "more than 12 items or over SAR 300, add 15
 * minutes". Either threshold may be empty, both may be set (whichever is
 * reached first), and dishes left out of order limits (#256) are not counted.
 */

describe('largeOrderRuleFrom', () => {
	it('builds a rule from either threshold or both', () => {
		expect(
			largeOrderRuleFrom({
				itemThreshold: 12,
				amountThresholdMinor: null,
				extraPrepMinutes: 15,
			}),
		).toMatchObject({ itemThreshold: 12, extraPrepMinutes: 15 })
		expect(
			largeOrderRuleFrom({
				itemThreshold: null,
				amountThresholdMinor: 30_000,
				extraPrepMinutes: 15,
			}),
		).toMatchObject({ amountThresholdMinor: 30_000 })
		expect(
			largeOrderRuleFrom({
				itemThreshold: 12,
				amountThresholdMinor: 30_000,
				extraPrepMinutes: 15,
			}),
		).toMatchObject({ itemThreshold: 12, amountThresholdMinor: 30_000 })
	})

	it('is no rule without a threshold or without extra minutes', () => {
		expect(
			largeOrderRuleFrom({
				itemThreshold: null,
				amountThresholdMinor: null,
				extraPrepMinutes: 15,
			}),
		).toBeNull()
		expect(
			largeOrderRuleFrom({
				itemThreshold: 12,
				amountThresholdMinor: null,
				extraPrepMinutes: 0,
			}),
		).toBeNull()
		expect(
			largeOrderRuleFrom({
				itemThreshold: 0,
				amountThresholdMinor: -5,
				extraPrepMinutes: 15,
			}),
		).toBeNull()
	})

	it('mirrors the first threshold for a region that reads one', () => {
		const both = largeOrderRuleFrom({
			itemThreshold: 12,
			amountThresholdMinor: 30_000,
			extraPrepMinutes: 15,
		})
		expect(both).toMatchObject({ thresholdType: 'items', threshold: 12 })
		const amountOnly = largeOrderRuleFrom({
			itemThreshold: null,
			amountThresholdMinor: 30_000,
			extraPrepMinutes: 15,
		})
		expect(amountOnly).toMatchObject({
			thresholdType: 'amount',
			threshold: 300,
		})
	})
})

describe('isLargeOrder with both thresholds', () => {
	const rule = largeOrderRuleFrom({
		itemThreshold: 12,
		amountThresholdMinor: 30_000,
		extraPrepMinutes: 15,
	})

	it('applies whichever threshold is reached first, strictly over', () => {
		expect(isLargeOrder(rule, { itemCount: 13, subtotalCents: 1_000 })).toBe(
			true,
		)
		expect(isLargeOrder(rule, { itemCount: 2, subtotalCents: 30_001 })).toBe(
			true,
		)
		expect(isLargeOrder(rule, { itemCount: 12, subtotalCents: 30_000 })).toBe(
			false,
		)
		expect(isLargeOrder(rule, { itemCount: 2, subtotalCents: 1_000 })).toBe(
			false,
		)
	})

	it('adds the minutes once, however many thresholds are over', () => {
		expect(
			largeOrderExtraMinutes(rule, { itemCount: 40, subtotalCents: 90_000 }),
		).toBe(15)
		expect(
			largeOrderExtraMinutes(rule, { itemCount: 2, subtotalCents: 1_000 }),
		).toBe(0)
		expect(
			largeOrderExtraMinutes(null, { itemCount: 99, subtotalCents: 99_999 }),
		).toBe(0)
	})

	it('ignores the empty threshold', () => {
		const itemsOnly = largeOrderRuleFrom({
			itemThreshold: 12,
			amountThresholdMinor: null,
			extraPrepMinutes: 15,
		})
		expect(
			isLargeOrder(itemsOnly, { itemCount: 2, subtotalCents: 999_999 }),
		).toBe(false)
		const amountOnly = largeOrderRuleFrom({
			itemThreshold: null,
			amountThresholdMinor: 30_000,
			extraPrepMinutes: 15,
		})
		expect(
			isLargeOrder(amountOnly, { itemCount: 99, subtotalCents: 100 }),
		).toBe(false)
	})
})

describe('the rule the region already stores keeps working', () => {
	it('reads the single-threshold shape of an older App', () => {
		const legacyAmount = readLargeOrderRule(
			{
				loc: { threshold: 100, thresholdType: 'amount', extraPrepMinutes: 10 },
			},
			'loc',
		)
		expect(
			isLargeOrder(legacyAmount, { itemCount: 1, subtotalCents: 10_001 }),
		).toBe(true)
		expect(
			isLargeOrder(legacyAmount, { itemCount: 1, subtotalCents: 10_000 }),
		).toBe(false)
		const legacyItems = readLargeOrderRule(
			{ loc: { threshold: 5, thresholdType: 'items', extraPrepMinutes: 10 } },
			'loc',
		)
		expect(isLargeOrder(legacyItems, { itemCount: 6, subtotalCents: 1 })).toBe(
			true,
		)
	})

	it('still fails safe on anything malformed', () => {
		expect(readLargeOrderRule({ loc: { threshold: 'x' } }, 'loc')).toBeNull()
		expect(
			largeOrderRuleSchema.safeParse({
				threshold: 5,
				thresholdType: 'items',
				extraPrepMinutes: 10,
				itemThreshold: 2.5,
			}).success,
		).toBe(false)
	})
})

describe('the item count leaves out dishes that do not count toward order limits (#256)', () => {
	const menus = [
		{
			availabilityStatus: 'available',
			categories: [
				{
					id: 'drinks',
					availabilityStatus: 'available',
					excludeFromOrderLimits: true,
					items: [{ id: 'cola', availabilityStatus: 'available' }],
				},
				{
					id: 'food',
					availabilityStatus: 'available',
					items: [
						{ id: 'pizza', availabilityStatus: 'available' },
						{
							id: 'bread',
							availabilityStatus: 'available',
							excludeFromOrderLimits: true,
						},
					],
					subcategories: [
						{
							id: 'pasta',
							availabilityStatus: 'available',
							items: [{ id: 'penne', availabilityStatus: 'available' }],
						},
					],
				},
			],
		},
	]
	const { catalog, categoryExempt } = buildOrderLimitCatalogFromMenus(menus)
	const exempt = orderLimitExemptFromCatalog(catalog, categoryExempt)
	const lines = [
		{ itemId: 'cola', quantity: 6, categoryIds: ['drinks'] },
		{ itemId: 'bread', quantity: 4, categoryIds: ['food'] },
		{ itemId: 'pizza', quantity: 8, categoryIds: ['food'] },
		{ itemId: 'penne', quantity: 2, categoryIds: ['pasta'] },
	]

	it('counts only the dishes that count', () => {
		expect(orderDishUnits(lines, exempt)).toBe(10)
	})

	it('does not reach a 12-item threshold by counting drinks and bread', () => {
		const rule = largeOrderRuleFrom({
			itemThreshold: 12,
			amountThresholdMinor: null,
			extraPrepMinutes: 15,
		})
		const counted = orderDishUnits(lines, exempt)
		const everything = lines.reduce((sum, line) => sum + line.quantity, 0)
		expect(everything).toBe(20)
		expect(
			largeOrderExtraMinutes(rule, { itemCount: counted, subtotalCents: 100 }),
		).toBe(0)
		// What a client that counts everything would have promised: a different time.
		expect(
			largeOrderExtraMinutes(rule, {
				itemCount: everything,
				subtotalCents: 100,
			}),
		).toBe(15)
	})

	it('skips drop menus and unavailable dishes', () => {
		const out = buildOrderLimitCatalogFromMenus([
			{
				menuType: 'drop',
				availabilityStatus: 'available',
				categories: [
					{
						id: 'd',
						availabilityStatus: 'available',
						items: [{ id: 'x', availabilityStatus: 'available' }],
					},
				],
			},
			{
				availabilityStatus: 'available',
				categories: [
					{
						id: 'c',
						availabilityStatus: 'available',
						items: [{ id: 'y', availabilityStatus: 'unavailable' }],
					},
				],
			},
		])
		expect(out.catalog.size).toBe(0)
	})
})
