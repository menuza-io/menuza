import { describe, expect, it } from 'vitest'
import {
	CUISINES,
	cuisineLabel,
	formatPriceRange,
	parsePriceRange,
	parseStoredCuisines,
	resolveCuisineAndPrice,
	servesCuisine,
	validateCuisines,
} from './cuisines.ts'

describe('cuisines', () => {
	it('every cuisine has a unique key and both labels', () => {
		const keys = new Set(CUISINES.map((cuisine) => cuisine.key))
		expect(keys.size).toBe(CUISINES.length)
		for (const cuisine of CUISINES) {
			expect(cuisine.en).toBeTruthy()
			expect(cuisine.ar).toMatch(/[؀-ۿ]/)
		}
	})

	it('accepts up to three known keys and refuses free text', () => {
		expect(validateCuisines(['lebanese', 'shawarma'])).toEqual({
			ok: true,
			keys: ['lebanese', 'shawarma'],
		})
		expect(validateCuisines(['lebanese', 'lebanese'])).toEqual({
			ok: true,
			keys: ['lebanese'],
		})
		expect(validateCuisines(['other'])).toEqual({
			ok: false,
			error: 'unknown_cuisine',
		})
		expect(validateCuisines(['pizza', 'sushi', 'coffee', 'thai'])).toEqual({
			ok: false,
			error: 'too_many_cuisines',
		})
	})

	it('reads stored JSON and drops unknown keys', () => {
		expect(parseStoredCuisines('["pizza","retired"]')).toEqual(['pizza'])
		expect(parseStoredCuisines(null)).toBeNull()
		expect(parseStoredCuisines('not json')).toBeNull()
	})

	it('labels in Arabic and English', () => {
		expect(cuisineLabel('lebanese', 'ar')).toBe('لبناني')
		expect(cuisineLabel('lebanese', 'en')).toBe('Lebanese')
		expect(servesCuisine(['lebanese', 'nope', 'pizza'])).toEqual([
			'Lebanese',
			'Pizza',
		])
	})

	it('shows the price range in the local currency symbol', () => {
		expect(formatPriceRange(2, 'USD')).toBe('$$')
		expect(formatPriceRange(3, 'SAR')).toBe('﷼﷼﷼')
		expect(formatPriceRange(null, 'USD')).toBe('')
		expect(parsePriceRange('4')).toBe(4)
		expect(parsePriceRange(5)).toBeNull()
	})

	it('uses the location override, else the organization', () => {
		const org = { cuisines: '["pizza"]', priceRange: 2 }
		expect(resolveCuisineAndPrice(org, null)).toEqual({
			cuisines: ['pizza'],
			priceRange: 2,
		})
		expect(
			resolveCuisineAndPrice(org, { cuisines: '["sushi"]', priceRange: 4 }),
		).toEqual({ cuisines: ['sushi'], priceRange: 4 })
		expect(
			resolveCuisineAndPrice(org, { cuisines: '[]', priceRange: null }),
		).toEqual({ cuisines: ['pizza'], priceRange: 2 })
	})
})
