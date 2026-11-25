import { describe, expect, it } from 'vitest'
import {
	buildItemPlacementIndex,
	lineCatalogFor,
	lineCatalogHasAlcohol,
	parseLineCatalog,
	readStampedPlacement,
} from './item-placement.ts'

const menus = [
	{
		id: 'm1',
		displayName: 'Lunch',
		menuType: 'regular',
		categories: [
			{
				id: 'c1',
				displayName: 'Starters',
				items: [{ id: 'soup' }, { id: 'burger' }],
				subcategories: [
					{ id: 'c1a', displayName: 'Cold', items: [{ id: 'salad' }] },
				],
			},
			{ id: 'c2', displayName: 'Popular', items: [{ id: 'burger' }] },
		],
	},
	{
		id: 'drop1',
		displayName: 'Friday drop',
		menuType: 'drop',
		categories: [{ id: 'c9', displayName: 'Drop', items: [{ id: 'special' }] }],
	},
]

describe('item placement', () => {
	it('puts a dish in the first category that lists it, not the last', () => {
		const index = buildItemPlacementIndex(menus)
		expect(index.get('burger')).toEqual({
			categoryId: 'c1',
			categoryName: 'Starters',
			menuId: 'm1',
			menuName: 'Lunch',
		})
		expect(index.get('salad')?.categoryId).toBe('c1a')
	})

	it('leaves drop menus out unless asked', () => {
		expect(buildItemPlacementIndex(menus).has('special')).toBe(false)
		expect(
			buildItemPlacementIndex(menus, { includeDrops: true }).get('special')
				?.menuId,
		).toBe('drop1')
	})

	it('builds a catalog for just the dishes on a sale and reads it back defensively', () => {
		const index = buildItemPlacementIndex(menus)
		const catalog = lineCatalogFor(index, ['soup', 'unknown'])
		expect(Object.keys(catalog ?? {})).toEqual(['soup'])
		expect(lineCatalogFor(index, ['unknown'])).toBeNull()
		expect(parseLineCatalog(JSON.stringify(catalog))).toEqual(catalog)
		expect(parseLineCatalog('not json')).toEqual({})
		expect(parseLineCatalog([1, 2])).toEqual({})
		expect(parseLineCatalog({ soup: 'bad', ok: { categoryName: 'X' } })).toEqual({
			ok: { categoryId: '', categoryName: 'X', menuId: '', menuName: '' },
		})
	})

	it('reads nothing from a line without a stamp', () => {
		expect(readStampedPlacement({ itemId: 'a' })).toBeNull()
		expect(readStampedPlacement(null)).toBeNull()
		expect(readStampedPlacement({ categoryName: 'Mains' })?.categoryName).toBe(
			'Mains',
		)
	})
})

describe('alcohol on the stamp (#167)', () => {
	const menus = [
		{
			id: 'm',
			displayName: 'Main',
			categories: [
				{
					id: 'bar',
					displayName: 'Bar',
					items: [
						{ id: 'wine', isAlcohol: true },
						{ id: 'water' },
					],
				},
			],
		},
	]

	it('stamps a flagged dish and leaves an ordinary one exactly as before', () => {
		const index = buildItemPlacementIndex(menus)
		expect(index.get('wine')).toMatchObject({ alcohol: true })
		expect(index.get('water')).not.toHaveProperty('alcohol')
		const catalog = lineCatalogFor(index, ['wine', 'water'])!
		expect(lineCatalogHasAlcohol(catalog)).toBe(true)
		expect(lineCatalogHasAlcohol(lineCatalogFor(index, ['water']))).toBe(false)
		expect(lineCatalogHasAlcohol(null)).toBe(false)
	})

	it('survives a round trip through storage', () => {
		const index = buildItemPlacementIndex(menus)
		const stored = JSON.stringify(lineCatalogFor(index, ['wine']))
		expect(lineCatalogHasAlcohol(parseLineCatalog(stored))).toBe(true)
	})
})
