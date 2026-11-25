import { describe, expect, it } from 'vitest'
import { compareStoreMenu, normalizeMenuName } from '../../src/pos/compare.ts'
import { readFields, type RemoteItem } from '../../src/pos/types.ts'

function item(overrides: Partial<RemoteItem> = {}): RemoteItem {
	return {
		id: 'item-1',
		name: 'Margherita Pizza',
		description: 'Tomato, basil, mozzarella',
		category: 'Pizza',
		price: 1299,
		imageUrl: null,
		available: true,
		modifierGroups: [],
		variations: [],
		menus: ['All Day'],
		allergens: [],
		alcohol: false,
		taxRate: null,
		version: 1,
		...overrides,
	}
}

describe('compareStoreMenu (#144)', () => {
	it('matches items case- and whitespace-insensitively and reports matching catalogs with 0 diffs', () => {
		const local = [item({ id: 'l1', name: '  Margherita   Pizza ' })]
		const remote = [item({ id: 'r1', name: 'margherita pizza' })]

		expect(normalizeMenuName('  Margherita   Pizza ')).toBe('margherita pizza')
		const result = compareStoreMenu(local, remote, readFields.ubereats)
		expect(result).toEqual({
			diffs: [],
			errorDiffCount: 0,
			posChangedCount: 0,
			totalDiffCount: 0,
		})
	})

	it('detects missing dishes, extra dishes, minor-unit price diffs, and availability diffs', () => {
		const local = [
			item({
				id: 'l1',
				name: 'Margherita Pizza',
				price: 1299,
				available: true,
			}),
			item({ id: 'l2', name: 'Garlic Bread', price: 499, available: true }),
			item({ id: 'l3', name: 'Tiramisu', price: 799, available: true }),
		]
		const remote = [
			item({
				id: 'r1',
				name: 'margherita pizza',
				price: 1399,
				available: false,
			}),
			item({ id: 'r2', name: 'Garlic Bread', price: 499, available: true }),
			item({ id: 'r4', name: 'Mystery Soda', price: 299, available: true }),
		]

		const result = compareStoreMenu(local, remote, readFields.doordash)
		expect(result.errorDiffCount).toBe(4)
		expect(result.posChangedCount).toBe(0)
		expect(result.totalDiffCount).toBe(4)
		expect(result.diffs).toEqual([
			{
				kind: 'price',
				dishName: 'Margherita Pizza',
				localItemId: 'l1',
				remoteItemId: 'r1',
				localPrice: 1299,
				remotePrice: 1399,
				changedInPos: false,
			},
			{
				kind: 'available',
				dishName: 'Margherita Pizza',
				localItemId: 'l1',
				remoteItemId: 'r1',
				localAvailable: true,
				remoteAvailable: false,
				changedInPos: false,
			},
			{
				kind: 'missing',
				dishName: 'Tiramisu',
				localItemId: 'l3',
				changedInPos: false,
			},
			{
				kind: 'extra',
				dishName: 'Mystery Soda',
				remoteItemId: 'r4',
				changedInPos: false,
			},
		])
	})

	it('detects modifier group and option diffs (missing/extra group, missing/extra option, option price, option availability)', () => {
		const local = [
			item({
				id: 'l1',
				name: 'Custom Bowl',
				modifierGroups: [
					{
						name: 'Proteins',
						min: 1,
						max: 1,
						options: [
							{ name: 'Chicken', price: 200, available: true },
							{ name: 'Tofu', price: 150, available: true },
							{ name: 'Steak', price: 400, available: true },
						],
					},
					{
						name: 'Sauces',
						min: 0,
						max: 2,
						options: [{ name: 'Tahini', price: 50, available: true }],
					},
				],
			}),
		]
		const remote = [
			item({
				id: 'r1',
				name: 'custom bowl',
				modifierGroups: [
					{
						name: 'proteins',
						min: 1,
						max: 1,
						options: [
							{ name: 'chicken', price: 250, available: true },
							{ name: 'Tofu', price: 150, available: false },
							{ name: 'Shrimp', price: 450, available: true },
						],
					},
					{
						name: 'Sides',
						min: 0,
						max: 1,
						options: [{ name: 'Pita', price: 100, available: true }],
					},
				],
			}),
		]

		const result = compareStoreMenu(local, remote, readFields.ubereats)
		expect(result.errorDiffCount).toBe(6)
		expect(result.totalDiffCount).toBe(6)
		expect(
			result.diffs.map((d) => [d.kind, d.groupName, d.optionName]),
		).toEqual([
			['modifiers', 'Proteins', 'Chicken'],
			['modifiers', 'Proteins', 'Tofu'],
			['modifiers', 'Proteins', 'Steak'],
			['modifiers', 'Proteins', 'Shrimp'],
			['modifiers', 'Sauces', undefined],
			['modifiers', 'Sides', undefined],
		])
		expect(result.diffs[0]).toMatchObject({
			localPrice: 200,
			remotePrice: 250,
			changedInPos: false,
		})
		expect(result.diffs[1]).toMatchObject({
			localAvailable: true,
			remoteAvailable: false,
			changedInPos: false,
		})
	})

	it('compares ONLY fields listed in providerReadFields', () => {
		const local = [
			item({
				id: 'l1',
				name: 'Burger',
				price: 1000,
				available: true,
				modifierGroups: [
					{
						name: 'Add-ons',
						min: 0,
						max: 1,
						options: [{ name: 'Cheese', price: 100, available: true }],
					},
				],
			}),
			item({ id: 'l2', name: 'Local Only' }),
		]
		const remote = [
			item({
				id: 'r1',
				name: 'Burger',
				price: 1500,
				available: false,
				modifierGroups: [],
			}),
			item({ id: 'r2', name: 'Remote Only' }),
		]

		const priceOnly = compareStoreMenu(local, remote, ['price'])
		expect(priceOnly.diffs).toHaveLength(1)
		expect(priceOnly.diffs[0]?.kind).toBe('price')

		const availableOnly = compareStoreMenu(local, remote, ['available'])
		expect(availableOnly.diffs).toHaveLength(1)
		expect(availableOnly.diffs[0]?.kind).toBe('available')
	})

	it('marks POS-owned non-overridden diffs as changedInPos: true and keeps overridden or Menuza-owned diffs as errors', () => {
		const local = [
			item({ id: 'l-pos', name: 'POS Dish', price: 1200, available: true }),
			item({
				id: 'l-overridden',
				name: 'Overridden Dish',
				price: 1200,
				available: true,
			}),
			item({
				id: 'l-menuza',
				name: 'Menuza Dish',
				price: 1200,
				available: true,
			}),
		]
		const remote = [
			item({ id: 'r-pos', name: 'POS Dish', price: 1400, available: false }),
			item({
				id: 'r-overridden',
				name: 'Overridden Dish',
				price: 1400,
				available: false,
			}),
			item({
				id: 'r-menuza',
				name: 'Menuza Dish',
				price: 1400,
				available: true,
			}),
		]

		const result = compareStoreMenu(local, remote, readFields.ubereats, {
			ownedFields: ['price', 'available'],
			itemsById: {
				'l-pos': { posLinked: true, overriddenFields: [] },
				'l-overridden': { posLinked: true, overriddenFields: ['price'] },
			},
		})

		expect(result.posChangedCount).toBe(3) // l-pos price + available, l-overridden available
		expect(result.errorDiffCount).toBe(2) // l-overridden price (overridden -> Menuza), l-menuza price
		expect(result.totalDiffCount).toBe(5)
		expect(
			result.diffs.find((d) => d.localItemId === 'l-pos' && d.kind === 'price')
				?.changedInPos,
		).toBe(true)
		expect(
			result.diffs.find(
				(d) => d.localItemId === 'l-overridden' && d.kind === 'price',
			)?.changedInPos,
		).toBe(false)
		expect(
			result.diffs.find(
				(d) => d.localItemId === 'l-overridden' && d.kind === 'available',
			)?.changedInPos,
		).toBe(true)
		expect(
			result.diffs.find(
				(d) => d.localItemId === 'l-menuza' && d.kind === 'price',
			)?.changedInPos,
		).toBe(false)
	})

	it('caps stored diffs cleanly while preserving totalDiffCount', () => {
		const local = Array.from({ length: 120 }, (_, i) =>
			item({ id: `l-${i}`, name: `Dish ${i}`, price: 1000 }),
		)
		const remote = Array.from({ length: 120 }, (_, i) =>
			item({ id: `r-${i}`, name: `Dish ${i}`, price: 1100 }),
		)

		const result = compareStoreMenu(local, remote, readFields.ubereats)
		expect(result.diffs).toHaveLength(100)
		expect(result.totalDiffCount).toBe(120)
		expect(result.errorDiffCount).toBe(120)
	})
})
