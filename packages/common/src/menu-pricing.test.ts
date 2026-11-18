import { describe, expect, it } from 'vitest'
import {
	applyPercentWithRounding,
	applyPricingRule,
	menuOrderTypeFor,
	parseMenuPricingRules,
	parseOrderTypePrices,
	pickPricingRule,
	resolveMenuItemPrice,
	resolveMenuOptionPrice,
	serializeOrderTypePrices,
	type MenuPricingRule,
} from './menu-pricing.ts'

const rule = (over: Partial<MenuPricingRule> = {}): MenuPricingRule => ({
	id: 'r1',
	percentBp: 1000,
	allDishes: false,
	categoryIds: ['mains'],
	locationIds: [],
	rounding: { mode: 'none' },
	...over,
})

describe('order type prices (#412)', () => {
	it('maps every channel word to a pricing order type', () => {
		expect(menuOrderTypeFor('dine_in')).toBe('dine_in')
		expect(menuOrderTypeFor('delivery')).toBe('delivery')
		expect(menuOrderTypeFor('pickup')).toBe('pickup')
		// Station takeaway and drive-through (#404) price as pickup.
		expect(menuOrderTypeFor('takeaway')).toBe('pickup')
		expect(menuOrderTypeFor('drive_through')).toBe('pickup')
		expect(menuOrderTypeFor(undefined)).toBe('pickup')
	})

	it('reads stored prices defensively', () => {
		expect(parseOrderTypePrices('{"delivery":12,"bogus":3}')).toEqual({
			delivery: 12,
		})
		expect(parseOrderTypePrices('{"delivery":-1}')).toBeNull()
		expect(parseOrderTypePrices('nope')).toBeNull()
		expect(parseOrderTypePrices(null)).toBeNull()
		expect(serializeOrderTypePrices({})).toBeNull()
		expect(serializeOrderTypePrices({ pickup: 9.5 })).toBe('{"pickup":9.5}')
	})

	it('shows a delivery price only for delivery orders', () => {
		const item = { price: 10, orderTypePrices: { delivery: 12 } }
		expect(resolveMenuItemPrice(item, { orderType: 'delivery' })).toBe(12)
		expect(resolveMenuItemPrice(item, { orderType: 'pickup' })).toBe(10)
		expect(resolveMenuItemPrice(item, { orderType: 'dine_in' })).toBe(10)
	})

	it('falls back to the base price when fields are empty', () => {
		expect(
			resolveMenuItemPrice(
				{ price: 10, orderTypePrices: null },
				{ orderType: 'delivery' },
			),
		).toBe(10)
		expect(
			resolveMenuItemPrice(
				{ price: 10, orderTypePrices: '{}' },
				{ orderType: 'dine_in' },
			),
		).toBe(10)
		expect(
			resolveMenuOptionPrice({ price: 2 }, { orderType: 'delivery' }),
		).toBe(2)
	})

	it('lets a fixed location override win', () => {
		const item = { price: 10, orderTypePrices: { delivery: 12 } }
		expect(
			resolveMenuItemPrice(
				item,
				{ orderType: 'delivery' },
				{ overridePrice: 11 },
			),
		).toBe(11)
		// A zero override is not a fixed price (as today).
		expect(
			resolveMenuItemPrice(
				item,
				{ orderType: 'delivery' },
				{ overridePrice: 0 },
			),
		).toBe(12)
		expect(
			resolveMenuOptionPrice(
				{ price: 2, orderTypePrices: { delivery: 3 } },
				{ orderType: 'delivery' },
				{ overridePrice: 2.5 },
			),
		).toBe(2.5)
	})

	it('prices a variation from its own price', () => {
		const item = { price: 10, orderTypePrices: { delivery: 12 } }
		expect(
			resolveMenuItemPrice(
				item,
				{ orderType: 'delivery' },
				{ variantPrice: 14 },
			),
		).toBe(14)
	})
})

describe('pricing rules (#388)', () => {
	it('rounds up exactly in minor units', () => {
		// 9.99 + 10% = 10.989 -> up to whole units = 11.00
		expect(
			applyPercentWithRounding(999, 1000, { mode: 'decimals', decimals: 0 }),
		).toBe(1100)
		// -> up to tenths = 11.00 (10.989 -> 11.0)
		expect(
			applyPercentWithRounding(999, 1000, { mode: 'decimals', decimals: 1 }),
		).toBe(1100)
		// 12.00 + 10% = 13.20 -> tenths keeps 13.20
		expect(
			applyPercentWithRounding(1200, 1000, { mode: 'decimals', decimals: 1 }),
		).toBe(1320)
		// 12.00 + 10% = 13.20 -> up to 0.25 = 13.25
		expect(
			applyPercentWithRounding(1200, 1000, { mode: 'amount', amountMinor: 25 }),
		).toBe(1325)
		// exact multiples stay put
		expect(
			applyPercentWithRounding(1000, 1000, {
				mode: 'amount',
				amountMinor: 100,
			}),
		).toBe(1100)
		// none rounds half up to the cent: 0.05 + 10% = 0.055 -> 0.06
		expect(applyPercentWithRounding(5, 1000, { mode: 'none' })).toBe(6)
		// never below zero
		expect(applyPercentWithRounding(500, -9000, { mode: 'none' })).toBe(50)
		expect(
			applyPercentWithRounding(0, 1000, { mode: 'amount', amountMinor: 50 }),
		).toBe(0)
	})

	it('applies +10% with round-up to a covered dish', () => {
		const r = rule({ rounding: { mode: 'decimals', decimals: 0 } })
		expect(
			resolveMenuItemPrice(
				{ price: 9.99, categoryIds: ['mains'] },
				{ orderType: 'pickup', rules: [r] },
			),
		).toBe(11)
		expect(
			resolveMenuItemPrice(
				{ price: 9.99, categoryIds: ['drinks'] },
				{ orderType: 'pickup', rules: [r] },
			),
		).toBe(9.99)
	})

	it('covers any dish in the category, including one added later', () => {
		const r = rule()
		// The rule names the category, not dishes: a new dish there is covered.
		expect(
			resolveMenuItemPrice(
				{ price: 20, categoryIds: ['mains'] },
				{ orderType: 'pickup', rules: [r] },
			),
		).toBe(22)
	})

	it('leaves dishes with a fixed override unchanged', () => {
		const r = rule()
		expect(
			resolveMenuItemPrice(
				{ price: 20, categoryIds: ['mains'] },
				{ orderType: 'pickup', rules: [r] },
				{ overridePrice: 18 },
			),
		).toBe(18)
		expect(
			resolveMenuItemPrice(
				{ price: 20, categoryIds: ['mains'] },
				{ orderType: 'pickup', rules: [r] },
				{ variantPrice: 25, overridePrice: 18 },
			),
		).toBe(25)
	})

	it('applies on the order-type price', () => {
		const r = rule()
		expect(
			resolveMenuItemPrice(
				{
					price: 10,
					orderTypePrices: { delivery: 20 },
					categoryIds: ['mains'],
				},
				{ orderType: 'delivery', rules: [r] },
			),
		).toBe(22)
	})

	it('respects locations, windows, the excluded range and ending', () => {
		const now = new Date('2026-11-18T12:00:00Z')
		const scope = { categoryIds: ['mains'], now }
		expect(
			pickPricingRule([rule({ locationIds: ['a'] })], {
				...scope,
				locationId: 'b',
			}),
		).toBeNull()
		expect(
			pickPricingRule([rule({ locationIds: ['a'] })], {
				...scope,
				locationId: 'a',
			})?.id,
		).toBe('r1')
		expect(
			pickPricingRule([rule({ startsAt: '2026-11-19T00:00:00Z' })], scope),
		).toBeNull()
		// Ended: prices return to base.
		expect(
			pickPricingRule([rule({ endsAt: '2026-11-18T11:00:00Z' })], scope),
		).toBeNull()
		expect(
			applyPricingRule(5, rule({ excludeMinPrice: 0, excludeMaxPrice: 5 })),
		).toBe(5)
		expect(
			applyPricingRule(6, rule({ excludeMinPrice: 0, excludeMaxPrice: 5 })),
		).toBeCloseTo(6.6)
		expect(applyPricingRule(50, rule({ excludeMinPrice: 40 }))).toBe(50)
	})

	it('uses the first covering rule, never stacking', () => {
		const first = rule({ id: 'cat', percentBp: 500 })
		const all = rule({
			id: 'all',
			allDishes: true,
			categoryIds: [],
			percentBp: 2000,
		})
		expect(
			resolveMenuItemPrice(
				{ price: 10, categoryIds: ['mains'] },
				{ orderType: 'pickup', rules: [first, all] },
			),
		).toBe(10.5)
		expect(
			resolveMenuItemPrice(
				{ price: 10, categoryIds: ['sides'] },
				{ orderType: 'pickup', rules: [first, all] },
			),
		).toBe(12)
	})

	it('drops malformed published rules', () => {
		expect(parseMenuPricingRules([rule(), { id: 'bad' }, 'x'])).toHaveLength(1)
		expect(parseMenuPricingRules('nope')).toEqual([])
	})

	it('does not apply rules to options', () => {
		expect(resolveMenuOptionPrice({ price: 2 }, { orderType: 'pickup' })).toBe(
			2,
		)
	})
})
