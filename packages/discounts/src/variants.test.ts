import { describe, expect, it } from 'vitest'
import {
	discountVariantFiltersSchema,
	variantChoicesOf,
	variantFiltersMatch,
	variantNameKeys,
} from './variants.ts'

describe('variantNameKeys', () => {
	it('lower-cases a plain name', () => {
		expect(variantNameKeys(' Large ')).toEqual(['large'])
	})
	it('reads every language of a JSON language map', () => {
		expect(variantNameKeys('{"en":"Large","ar":"كبير"}')).toEqual([
			'large',
			'كبير',
		])
	})
	it('ignores Arabic diacritics and tatweel, and Unicode forms', () => {
		expect(variantNameKeys('كَبِير')).toEqual(variantNameKeys('كبير'))
		expect(variantNameKeys('كبـــير')).toEqual(variantNameKeys('كبير'))
		expect(variantNameKeys('Cafe\u0301')).toEqual(variantNameKeys('Café'))
		expect(variantNameKeys('Extra   large')).toEqual(['extra large'])
	})
	it('keeps a name that only looks like JSON', () => {
		expect(variantNameKeys('{Large')).toEqual(['{large'])
	})
	it('is empty for nothing', () => {
		expect(variantNameKeys('')).toEqual([])
		expect(variantNameKeys(null)).toEqual([])
	})
})

describe('variant filters', () => {
	it('stores keys lower-cased and refuses a group twice', () => {
		expect(
			discountVariantFiltersSchema.parse([
				{ group: 'Size', values: [' Large'] },
			]),
		).toEqual([{ group: 'size', values: ['large'] }])
		expect(
			discountVariantFiltersSchema.safeParse([
				{ group: 'size', values: ['large'] },
				{ group: 'Size', values: ['small'] },
			]).success,
		).toBe(false)
	})

	it('matches with no filter and refuses a line with no variant', () => {
		expect(variantFiltersMatch(undefined, undefined)).toBe(true)
		expect(
			variantFiltersMatch([{ group: 'size', values: ['large'] }], []),
		).toBe(false)
	})

	it('builds choices from an item variant', () => {
		expect(
			variantChoicesOf(
				[
					{
						name: 'Size',
						values: [
							{ id: 's', name: 'Small' },
							{ id: 'l', name: 'Large' },
						],
					},
					{ name: 'Crust', values: [{ id: 't', name: 'Thin' }] },
				],
				['l', 't'],
			),
		).toEqual([
			{ group: 'Size', value: 'Large' },
			{ group: 'Crust', value: 'Thin' },
		])
	})
})
