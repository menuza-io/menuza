import { describe, expect, it } from 'vitest'
import {
	BULK_EDIT_MAX_ROWS,
	planBulkEditItem,
	planBulkEditOption,
} from './bulk-edit.ts'

const baseItem = {
	id: 'item1',
	updatedAt: new Date('2025-01-01'),
	displayName: 'Burger',
	price: 12.4,
	availabilityStatus: 'available' as const,
	unavailableUntil: null,
	applySalesTax: true,
	isVegetarian: false,
	isGlutenFree: false,
	isAlcohol: false,
	dietaryTags: [] as Array<'vegetarian' | 'gluten_free' | 'vegan' | 'halal'>,
	isPopular: false,
	isUpsell: false,
	categoryIds: ['cat1'],
	modifierGroupIds: [],
}

describe('planBulkEditItem', () => {
	it('applies 7% increase with .99 ending rounded up', () => {
		const [plan] = planBulkEditItem({
			rows: [baseItem],
			currencyExponent: 2,
			operation: {
				type: 'price',
				change: { kind: 'percent', value: 7 },
				ending: { to: '99', direction: 'up' },
			},
		})
		expect(plan?.after.price).toBe(13.99)
	})

	it('floors price at zero and marks row skipped', () => {
		const [plan] = planBulkEditItem({
			rows: [{ ...baseItem, price: 1 }],
			currencyExponent: 2,
			operation: { type: 'price', change: { kind: 'amount', value: -5 } },
		})
		expect(plan?.skipped).toBe('price_below_zero')
	})

	it('refuses more than 500 rows', () => {
		const rows = Array.from({ length: BULK_EDIT_MAX_ROWS + 1 }, (_, i) => ({
			...baseItem,
			id: `item${i}`,
		}))
		expect(() =>
			planBulkEditItem({
				rows,
				currencyExponent: 2,
				operation: { type: 'price', change: { kind: 'set', value: 9 } },
			}),
		).toThrow('too_many_rows')
	})
})

describe('planBulkEditOption', () => {
	it('rounds to whole units when currency has no decimals', () => {
		const [plan] = planBulkEditOption({
			rows: [
				{
					id: 'opt1',
					updatedAt: new Date(),
					displayName: 'Sauce',
					price: 4.2,
					availabilityStatus: 'available',
					unavailableUntil: null,
					isVegetarian: true,
					isGlutenFree: false,
					isAlcohol: false,
					dietaryTags: ['vegetarian'],
				},
			],
			currencyExponent: 0,
			operation: { type: 'price', change: { kind: 'percent', value: 10 } },
		})
		expect(plan?.after.price).toBe(5)
	})
})

describe('dietary tags in bulk edit (#335)', () => {
	it('adds a new tag and keeps the others and the flags in sync', () => {
		const [plan] = planBulkEditItem({
			rows: [{ ...baseItem, isVegetarian: true, dietaryTags: ['vegetarian'] }],
			currencyExponent: 2,
			operation: { type: 'dietary', flag: 'vegan', enabled: true },
		})
		expect(plan?.after.dietaryTags).toEqual(['vegan', 'vegetarian'])
		expect(plan?.after.isVegetarian).toBe(true)
	})

	it('removes vegetarian and clears the old flag', () => {
		const [plan] = planBulkEditItem({
			rows: [
				{
					...baseItem,
					isVegetarian: true,
					dietaryTags: ['halal', 'vegetarian'],
				},
			],
			currencyExponent: 2,
			operation: { type: 'dietary', flag: 'vegetarian', enabled: false },
		})
		expect(plan?.after.dietaryTags).toEqual(['halal'])
		expect(plan?.after.isVegetarian).toBe(false)
	})

	it('keeps alcohol as its own flag', () => {
		const [plan] = planBulkEditOption({
			rows: [
				{
					id: 'opt1',
					updatedAt: new Date(),
					displayName: 'Wine',
					price: 4,
					availabilityStatus: 'available',
					unavailableUntil: null,
					isVegetarian: false,
					isGlutenFree: true,
					isAlcohol: false,
					dietaryTags: ['gluten_free'],
				},
			],
			currencyExponent: 2,
			operation: { type: 'dietary', flag: 'alcohol', enabled: true },
		})
		expect(plan?.after).toMatchObject({
			isAlcohol: true,
			dietaryTags: ['gluten_free'],
			isGlutenFree: true,
		})
	})
})
