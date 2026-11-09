import { i18n } from '@lingui/core'
import { bulkCreateItemsSchema } from '@repo/inventory'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	BULK_MAX_ROWS,
	parseBulkText,
	parseUnitText,
	resolveCategoryText,
	reviewBulkDrafts,
	toBulkItems,
} from './bulk-import.ts'
import {
	RESTAURANT_TYPES,
	starterBulkItems,
	starterItemsFor,
} from './starter-lists.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('units and categories', () => {
	it('reads the units people type', () => {
		expect(parseUnitText('Kg')).toBe('kg')
		expect(parseUnitText('litres')).toBe('l')
		expect(parseUnitText('pcs.')).toBe('piece')
		expect(parseUnitText('fl oz')).toBe('fl_oz')
		expect(parseUnitText('كجم')).toBe('kg')
		expect(parseUnitText('bags')).toBeNull()
		expect(parseUnitText('constructor')).toBeNull()
		expect(parseUnitText('')).toBeNull()
	})

	it('reads categories by key, by label, or as the typed text', () => {
		expect(resolveCategoryText('Meat', i18n)).toBe('meat')
		expect(resolveCategoryText('dry goods', i18n)).toBe('dry_goods')
		expect(resolveCategoryText('Dry-goods', i18n)).toBe('dry_goods')
		expect(resolveCategoryText('', i18n)).toBe('other')
		expect(resolveCategoryText(' Spices ', i18n)).toBe('custom:Spices')
	})
})

describe('parseBulkText', () => {
	it('reads name, category, unit and price in order without a header', () => {
		const { drafts, truncated } = parseBulkText(
			'Chicken thighs, Meat, kg, 28\nGarlic sauce, Sauces, L, 14.5',
			i18n,
		)
		expect(truncated).toBe(false)
		expect(drafts).toEqual([
			{
				id: 0,
				name: 'Chicken thighs',
				category: 'meat',
				unit: 'kg',
				price: '28',
			},
			{
				id: 1,
				name: 'Garlic sauce',
				category: 'sauces',
				unit: 'l',
				price: '14.5',
			},
		])
	})

	it('follows a header row in any order', () => {
		const { drafts } = parseBulkText(
			'Price per unit;Name;Unit\n3;Pita;pcs',
			i18n,
		)
		expect(drafts).toEqual([
			{ id: 0, name: 'Pita', category: 'other', unit: 'piece', price: '3' },
		])
	})

	it('counts pieces without a unit and flags a unit it cannot read', () => {
		const { drafts } = parseBulkText('Eggs\nSalt, Dry goods, sack', i18n)
		expect(drafts[0]?.unit).toBe('piece')
		expect(drafts[1]?.unit).toBe('')
	})

	it('stops at the row limit and says so', () => {
		const text = Array.from(
			{ length: BULK_MAX_ROWS + 5 },
			(_, index) => `Item ${index}`,
		).join('\n')
		const { drafts, truncated } = parseBulkText(text, i18n)
		expect(drafts).toHaveLength(BULK_MAX_ROWS)
		expect(truncated).toBe(true)
	})

	it('reads nothing from empty text', () => {
		expect(parseBulkText('  \n ', i18n).drafts).toEqual([])
	})
})

describe('reviewBulkDrafts and toBulkItems', () => {
	const base = { id: 0, category: 'meat', price: '' }

	it('marks problems and leaves good rows alone', () => {
		const rows = reviewBulkDrafts(
			[
				{ ...base, id: 0, name: 'Chicken', unit: 'kg' },
				{ ...base, id: 1, name: ' ', unit: 'kg' },
				{ ...base, id: 2, name: 'chicken', unit: 'kg' },
				{ ...base, id: 3, name: 'Beef', unit: '' },
				{ ...base, id: 4, name: 'Lamb', unit: 'kg', price: 'cheap' },
				{ ...base, id: 5, name: 'x'.repeat(81), unit: 'kg' },
			],
			{ currency: 'SAR' },
		)
		expect(rows.map((row) => row.problems)).toEqual([
			[],
			['name_required'],
			['duplicate'],
			['unit_required'],
			['bad_price'],
			['name_too_long'],
		])
		expect(rows.map((row) => row.row)).toEqual([1, 2, 3, 4, 5, 6])
	})

	it('builds valid bulk items, with a cost per base unit from a price per unit', () => {
		const rows = reviewBulkDrafts(
			[
				{ ...base, id: 0, name: ' Chicken thighs ', unit: 'kg', price: '28' },
				{
					...base,
					id: 1,
					name: 'Eggs',
					category: 'dairy',
					unit: 'piece',
					price: '',
				},
				{ ...base, id: 2, name: '', unit: 'kg' },
			],
			{ currency: 'SAR' },
		)
		const items = toBulkItems(rows, { currency: 'SAR' })
		expect(items).toEqual([
			{
				name: 'Chicken thighs',
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
				countUnit: 'kg',
				// SAR 28 per kg = 2800 halalas / 1000 g = 2.8 halalas = 2_800_000 micro per g
				costMicro: 2_800_000,
				currency: 'SAR',
			},
			{
				name: 'Eggs',
				category: 'dairy',
				kind: 'bought',
				baseUnit: 'piece',
				countUnit: 'piece',
			},
		])
		expect(
			bulkCreateItemsSchema.safeParse({
				clientId: 'b-12345678',
				locationId: 'main',
				items,
			}).success,
		).toBe(true)
	})
})

describe('starter lists', () => {
	it('has a list for every restaurant type, with unique valid names', () => {
		for (const type of RESTAURANT_TYPES) {
			const items = starterBulkItems(starterItemsFor(type), {
				i18n,
				system: 'metric',
			})
			expect(items.length).toBeGreaterThanOrEqual(8)
			const names = items.map((item) => item.name.toLowerCase())
			expect(new Set(names).size).toBe(names.length)
			expect(
				bulkCreateItemsSchema.safeParse({
					clientId: 'b-12345678',
					locationId: 'main',
					items,
				}).success,
			).toBe(true)
		}
	})

	it('names items in the current language, as plain text, with US units for the US', () => {
		const metric = starterBulkItems(starterItemsFor('burger'), {
			i18n,
			system: 'metric',
		})
		const us = starterBulkItems(starterItemsFor('burger'), {
			i18n,
			system: 'us',
		})
		const patties = metric.find((item) => item.name === 'Beef patties')
		expect(patties).toMatchObject({
			baseUnit: 'piece',
			countUnit: 'piece',
			areaName: 'Freezer',
		})
		expect(metric.find((item) => item.name === 'Tomatoes')?.countUnit).toBe(
			'kg',
		)
		expect(us.find((item) => item.name === 'Tomatoes')?.countUnit).toBe('lb')
	})
})
