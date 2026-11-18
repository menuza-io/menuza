import { describe, expect, it } from 'vitest'
import {
	expandRuleCategories,
	previewPricingRule,
	publishPricingRules,
	roundingOf,
	secondsUntilNextRuleChange,
	type MenuStructure,
	type PricingRuleRow,
} from './pricing-rules.ts'

const structure: MenuStructure = {
	menuCategoryIds: new Map([['lunch', ['mains', 'drinks']]]),
	childCategoryIds: new Map([['mains', ['grill']]]),
}

const row = (over: Partial<PricingRuleRow> = {}): PricingRuleRow => ({
	id: 'r1',
	name: 'Plus ten',
	percentBp: 1000,
	menuIds: '[]',
	categoryIds: '["mains"]',
	locationIds: '[]',
	roundingMode: 'decimals',
	roundingValue: 0,
	excludeMinPrice: null,
	excludeMaxPrice: null,
	startsAt: null,
	endedAt: null,
	createdAt: new Date('2026-11-01T00:00:00Z'),
	...over,
})

const NOW = new Date('2026-11-18T12:00:00Z')

describe('pricing rules (#388)', () => {
	it('expands menus and subcategories so later dishes are covered', () => {
		expect(expandRuleCategories(['lunch'], [], structure)).toEqual([
			'drinks',
			'grill',
			'mains',
		])
		expect(expandRuleCategories([], ['mains'], structure)).toEqual([
			'grill',
			'mains',
		])
	})

	it('publishes live rules, most specific first, and drops ended ones', () => {
		const rules = publishPricingRules(
			[
				row({
					id: 'all',
					categoryIds: '[]',
					createdAt: new Date('2026-11-10T00:00:00Z'),
				}),
				row({ id: 'menu', categoryIds: '[]', menuIds: '["lunch"]' }),
				row({ id: 'cat' }),
				row({ id: 'gone', endedAt: new Date('2026-11-17T00:00:00Z') }),
			],
			structure,
			NOW,
		)
		expect(rules.map((rule) => rule.id)).toEqual(['cat', 'menu', 'all'])
		expect(rules[2]).toMatchObject({ allDishes: true, categoryIds: [] })
		expect(rules[0]).toMatchObject({
			categoryIds: ['grill', 'mains'],
			rounding: { mode: 'decimals', decimals: 0 },
		})
	})

	it('reads rounding defensively', () => {
		expect(roundingOf({ roundingMode: 'amount', roundingValue: 25 })).toEqual({
			mode: 'amount',
			amountMinor: 25,
		})
		expect(roundingOf({ roundingMode: 'amount', roundingValue: 0 })).toEqual({
			mode: 'none',
		})
		expect(roundingOf({ roundingMode: 'decimals', roundingValue: 1 })).toEqual({
			mode: 'decimals',
			decimals: 1,
		})
	})

	it('previews +10% with round-up, leaving fixed prices and the excluded range alone', () => {
		const rows = previewPricingRule(
			{
				percentBp: 1000,
				menuIds: [],
				categoryIds: ['mains'],
				locationIds: [],
				rounding: { mode: 'decimals', decimals: 0 },
				excludeMinPrice: null,
				excludeMaxPrice: 2,
			},
			{
				dishes: [
					{ id: 'steak', name: 'Steak', price: 18.5, categoryIds: ['grill'] },
					{ id: 'salad', name: 'Salad', price: 9.99, categoryIds: ['mains'] },
					{ id: 'bread', name: 'Bread', price: 1.5, categoryIds: ['mains'] },
					{ id: 'cola', name: 'Cola', price: 3, categoryIds: ['drinks'] },
				],
				locationIds: ['a', 'b'],
				structure,
				overrides: new Map([['b', new Map([['steak', 17]])]]),
			},
		)
		expect(rows).toEqual([
			{
				itemId: 'steak',
				name: 'Steak',
				locationId: 'a',
				before: 18.5,
				after: 21,
			},
			{
				itemId: 'salad',
				name: 'Salad',
				locationId: 'a',
				before: 9.99,
				after: 11,
			},
			{
				itemId: 'bread',
				name: 'Bread',
				locationId: 'a',
				before: 1.5,
				after: 1.5,
				unchanged: 'excluded_range',
			},
			{
				itemId: 'steak',
				name: 'Steak',
				locationId: 'b',
				before: 17,
				after: 17,
				unchanged: 'fixed_price',
			},
			{
				itemId: 'salad',
				name: 'Salad',
				locationId: 'b',
				before: 9.99,
				after: 11,
			},
			{
				itemId: 'bread',
				name: 'Bread',
				locationId: 'b',
				before: 1.5,
				after: 1.5,
				unchanged: 'excluded_range',
			},
		])
	})

	it('shortens caches until a scheduled start or end', () => {
		const [rule] = publishPricingRules(
			[row({ endedAt: new Date('2026-11-18T12:10:00Z') })],
			structure,
			NOW,
		)
		expect(secondsUntilNextRuleChange([rule!], NOW)).toBe(600)
	})
})
