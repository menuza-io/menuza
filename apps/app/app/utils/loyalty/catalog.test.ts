import { describe, expect, it } from 'vitest'
import {
	buildLoyaltyCatalog,
	catalogLabelsFor,
	joinCatalogIds,
	splitCatalogIds,
} from './catalog.ts'

describe('buildLoyaltyCatalog', () => {
	it('names items in the website language and keeps menu order', () => {
		const catalog = buildLoyaltyCatalog({
			locale: 'ar',
			items: [
				{
					id: 'item_latte',
					displayName: JSON.stringify({ en: 'Latte', ar: 'لاتيه' }),
					internalName: 'LAT-01',
				},
				{ id: 'item_tea', displayName: 'Tea', internalName: 'Tea' },
				{ id: 'item_blank', displayName: '', internalName: 'Back room' },
				{ id: 'bad id!', displayName: 'Skipped', internalName: null },
			],
			categories: [],
		})
		expect(catalog.items).toEqual([
			{ id: 'item_latte', name: 'لاتيه', detail: 'LAT-01' },
			{ id: 'item_tea', name: 'Tea', detail: null },
			{ id: 'item_blank', name: 'Back room', detail: null },
		])
	})

	it('lists categories under their parents with the parent path', () => {
		const catalog = buildLoyaltyCatalog({
			locale: 'en',
			items: [],
			categories: [
				{
					id: 'cat_hot',
					displayName: 'Hot',
					internalName: null,
					parentId: 'cat_drinks',
				},
				{
					id: 'cat_food',
					displayName: 'Food',
					internalName: null,
					parentId: null,
				},
				{
					id: 'cat_drinks',
					displayName: 'Drinks',
					internalName: null,
					parentId: null,
				},
				{
					id: 'cat_tea',
					displayName: 'Tea',
					internalName: null,
					parentId: 'cat_hot',
				},
				{
					id: 'cat_orphan',
					displayName: 'Orphan',
					internalName: null,
					parentId: 'gone',
				},
			],
		})
		expect(catalog.categories).toEqual([
			{ id: 'cat_food', name: 'Food', detail: null },
			{ id: 'cat_drinks', name: 'Drinks', detail: null },
			{ id: 'cat_hot', name: 'Hot', detail: 'Drinks' },
			{ id: 'cat_tea', name: 'Tea', detail: 'Drinks › Hot' },
			{ id: 'cat_orphan', name: 'Orphan', detail: null },
		])
	})

	it('still lists categories caught in a parent cycle', () => {
		const catalog = buildLoyaltyCatalog({
			locale: 'en',
			items: [],
			categories: [
				{
					id: 'cat_a',
					displayName: 'A',
					internalName: null,
					parentId: 'cat_b',
				},
				{
					id: 'cat_b',
					displayName: 'B',
					internalName: null,
					parentId: 'cat_a',
				},
			],
		})
		expect(catalog.categories.map((option) => option.id).sort()).toEqual([
			'cat_a',
			'cat_b',
		])
	})
})

describe('catalogLabelsFor', () => {
	const options = [
		{ id: 'item_latte', name: 'Latte', detail: null },
		{ id: 'item_long', name: `${'x'.repeat(119)}😀`, detail: null },
	]

	it('uses the current menu name, then the saved one, and skips unknown ids', () => {
		expect(
			catalogLabelsFor(['item_latte', 'item_gone', 'item_unknown'], options, {
				item_latte: 'Old latte',
				item_gone: 'Mocha',
			}),
		).toEqual({ item_latte: 'Latte', item_gone: 'Mocha' })
	})

	it('clips long names without splitting a character', () => {
		const labels = catalogLabelsFor(['item_long'], options)
		expect(labels.item_long).toBe('x'.repeat(119))
	})

	it('ignores inherited object keys', () => {
		expect(catalogLabelsFor(['constructor'], [], {})).toEqual({})
	})
})

describe('catalog id form values', () => {
	it('round-trips ids and drops blanks and repeats', () => {
		expect(joinCatalogIds(['a', 'b'])).toBe('a,b')
		expect(splitCatalogIds(' a, b,,a ')).toEqual(['a', 'b'])
		expect(splitCatalogIds('')).toEqual([])
		expect(splitCatalogIds(undefined)).toEqual([])
	})
})
