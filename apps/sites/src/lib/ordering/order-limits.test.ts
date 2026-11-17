import { describe, expect, it } from 'vitest'
import { countedDishUnits, orderLimitMetaFromMenus } from './order-limits.ts'

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

describe('orderLimitMetaFromMenus', () => {
	const meta = orderLimitMetaFromMenus(menus)

	it('keeps ids only: each dish with its categories, and the exempt dishes and categories', () => {
		expect(meta.itemCategoryIds).toEqual({
			cola: ['drinks'],
			pizza: ['food'],
			bread: ['food'],
			penne: ['pasta'],
		})
		expect(meta.exemptItemIds).toEqual(['bread'])
		expect(meta.exemptCategoryIds).toEqual(['drinks'])
		expect(JSON.stringify(meta)).not.toMatch(/displayName|price/)
	})

	it('survives the trip through JSON the page makes', () => {
		expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
	})
})

describe('countedDishUnits', () => {
	const meta = orderLimitMetaFromMenus(menus)

	it('leaves out an exempt dish and every dish of an exempt category', () => {
		expect(
			countedDishUnits(
				[
					{ itemId: 'cola', quantity: 6 },
					{ itemId: 'bread', quantity: 4 },
					{ itemId: 'pizza', quantity: 8 },
					{ itemId: 'penne', quantity: 2 },
				],
				meta,
			),
		).toBe(10)
	})

	it('counts a dish the menu does not know (it may have just left the menu)', () => {
		expect(countedDishUnits([{ itemId: 'ghost', quantity: 3 }], meta)).toBe(3)
	})

	it('counts every unit without the catalog, as the page did before', () => {
		const cart = [
			{ itemId: 'cola', quantity: 6 },
			{ itemId: 'pizza', quantity: 8 },
		]
		expect(countedDishUnits(cart, null)).toBe(14)
		expect(countedDishUnits(cart, undefined)).toBe(14)
	})
})
