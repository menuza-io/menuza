import { describe, expect, it } from 'vitest'
import { makeDiscount } from '../../../../../packages/discounts/src/test-fixtures.ts'
import { publicPromotionFor } from './public-promotion.ts'

const target = (overrides = {}) => ({
	scope: 'items' as const,
	itemIds: ['pizza'],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
	...overrides,
})

describe('publicPromotionFor', () => {
	it('shows a plain percentage as a value badge on its items', () => {
		const promotion = publicPromotionFor(
			makeDiscount({ id: 'd1', target: target() }),
		)
		expect(promotion).toMatchObject({
			id: 'd1',
			valueType: 'percent',
			percentBp: 1000,
			scope: 'items',
			itemIds: ['pizza'],
			showName: false,
		})
	})

	it('marks only a plain percent or per-item amount as priceable', () => {
		const plain = publicPromotionFor(makeDiscount({ target: target() }))
		expect(plain?.itemPrice).toBe(true)
		const fixed = publicPromotionFor(
			makeDiscount({
				valueType: 'fixed',
				percentBp: null,
				amountMinor: 200,
				currency: 'USD',
				target: target(),
			}),
		)
		expect(fixed?.itemPrice).toBe(true)
		const orderFixed = publicPromotionFor(
			makeDiscount({
				valueType: 'fixed',
				percentBp: null,
				amountMinor: 200,
				currency: 'USD',
				target: target({ scope: 'order', itemIds: [] }),
			}),
		)
		expect(orderFixed?.itemPrice).toBe(false)
		const capped = publicPromotionFor(
			makeDiscount({ maxDiscountMinor: 500, target: target() }),
		)
		expect(capped?.itemPrice).toBe(false)
		const minimum = publicPromotionFor(
			makeDiscount({ minSubtotalMinor: 3000, target: target() }),
		)
		expect(minimum?.itemPrice).toBe(false)
	})

	it('keeps an order-wide discount on every item', () => {
		const promotion = publicPromotionFor(
			makeDiscount({ target: target({ scope: 'order', itemIds: [] }) }),
		)
		expect(promotion?.scope).toBe('order')
	})

	it('shows a set price by its name', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				name: 'Large pizza $10',
				valueType: 'fixed_price',
				percentBp: null,
				amountMinor: 1000,
				currency: 'USD',
				target: target(),
			}),
		)
		expect(promotion).toMatchObject({
			valueType: 'fixed_price',
			amountMinor: 1000,
			showName: true,
		})
	})

	it('badges the items a deal names, not every item', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				name: 'Burger and fries',
				percentBp: 10_000,
				quantityRule: {
					kind: 'buy_get',
					buy: { quantity: 1, itemIds: ['burger'], categoryIds: [] },
					get: { quantity: 1, itemIds: ['fries'], categoryIds: ['sides'] },
				},
			}),
		)
		expect(promotion).toMatchObject({
			scope: 'items',
			itemIds: ['burger', 'fries'],
			categoryIds: ['sides'],
			showName: true,
		})
	})

	it('merges a meal deal groups without repeating an item', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				quantityRule: {
					kind: 'bundle',
					slots: [
						{ quantity: 1, itemIds: ['pizza'], categoryIds: [] },
						{ quantity: 1, itemIds: ['pizza', 'cola'], categoryIds: [] },
					],
				},
			}),
		)
		expect(promotion?.itemIds).toEqual(['pizza', 'cola'])
	})

	it('puts a modifier discount in the banner and on its items only', () => {
		const everyItem = publicPromotionFor(
			makeDiscount({
				target: {
					scope: 'modifiers' as const,
					itemIds: [],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
					modifierGroupIds: ['toppings'],
				},
			}),
		)
		expect(everyItem).toMatchObject({
			scope: 'items',
			itemIds: [],
			categoryIds: [],
			showName: true,
		})
		const pizzasOnly = publicPromotionFor(
			makeDiscount({
				target: {
					scope: 'modifiers' as const,
					itemIds: [],
					categoryIds: ['pizzas'],
					excludeItemIds: [],
					excludeCategoryIds: [],
					modifierGroupIds: ['toppings'],
				},
			}),
		)
		expect(pizzasOnly?.categoryIds).toEqual(['pizzas'])
	})

	it('shows a ladder by its name, with no single value', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				percentBp: null,
				currency: 'USD',
				target: target({ scope: 'order', itemIds: [] }),
				tiers: {
					basis: 'spend',
					steps: [{ at: 3000, percentBp: 500, amountMinor: null }],
				},
			}),
		)
		expect(promotion).toMatchObject({
			percentBp: null,
			amountMinor: null,
			showName: true,
		})
	})

	it('shows a size-limited discount by its name', () => {
		const promotion = publicPromotionFor(
			makeDiscount({ target: target({ variantNames: ['Large'] }) }),
		)
		expect(promotion?.showName).toBe(true)
	})

	describe('what is not a plain value shows the name', () => {
		const name = (overrides: Parameters<typeof makeDiscount>[0]) =>
			publicPromotionFor(makeDiscount({ target: target(), ...overrides }))

		it.each([
			[
				'a buy one get one',
				{
					quantityRule: {
						kind: 'bogo' as const,
						buyQuantity: 1,
						getQuantity: 1,
					},
					percentBp: 10_000,
				},
			],
			[
				'an exact quantity',
				{ quantityRule: { kind: 'exact' as const, quantity: 2 } },
			],
			[
				'a minimum quantity',
				{ quantityRule: { kind: 'minimum' as const, quantity: 3 } },
			],
			['a minimum spend', { minSubtotalMinor: 3000 }],
			['a schedule', { schedule: [{ day: 1, start: '16:00', end: '18:00' }] }],
			['a signed-in audience', { eligibility: 'signed_in' as const }],
			['a new-customer audience', { eligibility: 'new_customer' as const }],
			['a code', { application: 'code' as const }],
			[
				'a requirement',
				{ requirement: { quantity: 1, itemIds: ['cola'], categoryIds: [] } },
			],
			['a unit limit', { maxDiscountedUnits: 2 }],
		])('for %s', (_label, overrides) => {
			expect(name(overrides as never)?.showName).toBe(true)
		})

		it('keeps a plain unconditional value as a value badge', () => {
			expect(name({})?.showName).toBe(false)
		})

		it('names a percentage with a cap', () => {
			expect(name({ maxDiscountMinor: 500 })?.showName).toBe(true)
		})
	})

	it('puts no item badge on free delivery, banner only', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				valueType: 'free_delivery',
				percentBp: null,
				fulfillments: ['delivery'],
				target: target({ scope: 'order', itemIds: [] }),
			}),
		)
		expect(promotion).toMatchObject({ showName: true, itemBadges: false })
	})

	it('puts no item badge on an offer limited to some order types', () => {
		const promotion = publicPromotionFor(
			makeDiscount({ fulfillments: ['pickup'], target: target() }),
		)
		expect(promotion).toMatchObject({
			itemBadges: false,
			fulfillments: ['pickup'],
		})
		expect(
			publicPromotionFor(makeDiscount({ target: target() }))?.itemBadges,
		).toBe(true)
	})

	it('puts no item badge on a conditional order-wide offer', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				minSubtotalMinor: 3000,
				target: target({ scope: 'order', itemIds: [] }),
			}),
		)
		expect(promotion).toMatchObject({ showName: true, itemBadges: false })
	})

	it('badges an item-scoped capped percentage by name, an order-wide one by banner', () => {
		expect(
			publicPromotionFor(
				makeDiscount({ maxDiscountMinor: 500, target: target() }),
			),
		).toMatchObject({ showName: true, itemBadges: true })
		expect(
			publicPromotionFor(
				makeDiscount({
					maxDiscountMinor: 500,
					target: target({ scope: 'order', itemIds: [] }),
				}),
			),
		).toMatchObject({ showName: true, itemBadges: false })
	})

	it('puts no item badge on an unconditional order-wide amount off', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				valueType: 'fixed',
				percentBp: null,
				amountMinor: 500,
				currency: 'USD',
				target: target({ scope: 'order', itemIds: [] }),
			}),
		)
		expect(promotion?.itemBadges).toBe(false)
		// The same amount on chosen items is taken from each of them.
		expect(
			publicPromotionFor(
				makeDiscount({
					valueType: 'fixed',
					percentBp: null,
					amountMinor: 500,
					currency: 'USD',
					target: target(),
				}),
			)?.itemBadges,
		).toBe(true)
	})

	it('sends where and when the offer applies', () => {
		const promotion = publicPromotionFor(
			makeDiscount({
				locationIds: ['loc_1'],
				startsAt: '2026-11-01T09:00',
				endsAt: '2026-11-30T23:00',
				target: target(),
			}),
		)
		expect(promotion).toMatchObject({
			locationIds: ['loc_1'],
			fulfillments: ['pickup', 'delivery', 'dine_in'],
			startsAt: '2026-11-01T09:00',
			endsAt: '2026-11-30T23:00',
		})
	})

	it('sends a code only for a code discount, when one is given', () => {
		const codeDiscount = makeDiscount({
			application: 'code',
			target: target(),
		})
		expect(publicPromotionFor(codeDiscount, { code: 'SAVE10' })?.code).toBe(
			'SAVE10',
		)
		expect(publicPromotionFor(codeDiscount)?.code).toBeNull()
		// An automatic discount never carries a code, even if one is passed.
		expect(
			publicPromotionFor(makeDiscount({ target: target() }), {
				code: 'SAVE10',
			})?.code,
		).toBeNull()
	})

	it('leaves out what is keyed in at the till', () => {
		expect(
			publicPromotionFor(
				makeDiscount({
					application: 'manual',
					valueType: 'variable_percent',
					percentBp: null,
				}),
			),
		).toBeNull()
	})
})
