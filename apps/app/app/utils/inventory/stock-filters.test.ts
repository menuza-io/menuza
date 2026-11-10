import { describe, expect, it } from 'vitest'
import {
	applyStockFilterPatch,
	clearStockFilters,
	hasActiveStockFilters,
	parseStockFilters,
	STOCK_MAX_LIMIT,
	stockListPath,
} from './stock-filters.ts'

describe('stock filters', () => {
	it('reads the URL, with defaults', () => {
		expect(parseStockFilters(new URLSearchParams(''))).toEqual({
			q: '',
			category: 'all',
			areaId: 'all',
			lowOnly: false,
			limit: 50,
		})
		expect(
			parseStockFilters(
				new URLSearchParams('q=chick&category=meat&area=a1&low=1&limit=100'),
			),
		).toEqual({
			q: 'chick',
			category: 'meat',
			areaId: 'a1',
			lowOnly: true,
			limit: 100,
		})
	})

	it('caps and floors the limit', () => {
		expect(parseStockFilters(new URLSearchParams('limit=9999')).limit).toBe(
			STOCK_MAX_LIMIT,
		)
		expect(parseStockFilters(new URLSearchParams('limit=3')).limit).toBe(50)
		expect(parseStockFilters(new URLSearchParams('limit=abc')).limit).toBe(50)
	})

	it('builds the list request from the filters', () => {
		const path = stockListPath(
			{
				q: ' chick ',
				category: 'meat',
				areaId: 'a1',
				lowOnly: true,
				limit: 100,
			},
			'main',
		)
		const params = new URLSearchParams(path.split('?')[1])
		expect(path.startsWith('/items?')).toBe(true)
		expect(Object.fromEntries(params)).toEqual({
			locationId: 'main',
			q: 'chick',
			category: 'meat',
			areaId: 'a1',
			status: 'attention',
			limit: '100',
		})
		const plain = new URLSearchParams(
			stockListPath(parseStockFilters(new URLSearchParams()), 'main').split(
				'?',
			)[1],
		)
		expect(Object.fromEntries(plain)).toEqual({
			locationId: 'main',
			limit: '50',
		})
	})

	it('goes back to the first page when a filter changes', () => {
		const current = new URLSearchParams('locationId=l2&limit=150')
		const next = applyStockFilterPatch(current, { category: 'meat' })
		expect(next.get('category')).toBe('meat')
		expect(next.get('locationId')).toBe('l2')
		expect(next.has('limit')).toBe(false)
	})

	it('keeps going when "Show more" raises the limit', () => {
		const next = applyStockFilterPatch(new URLSearchParams('q=a'), {
			limit: 100,
		})
		expect(next.get('limit')).toBe('100')
		expect(next.get('q')).toBe('a')
		expect(
			applyStockFilterPatch(new URLSearchParams('limit=100'), {
				limit: 50,
			}).has('limit'),
		).toBe(false)
	})

	it('removes a filter set back to its default', () => {
		const current = new URLSearchParams('q=a&category=meat&area=a1&low=1')
		const next = applyStockFilterPatch(current, {
			q: '',
			category: 'all',
			areaId: 'all',
			lowOnly: false,
		})
		expect(next.toString()).toBe('')
	})

	it('tells whether anything is filtered and clears it all but the location', () => {
		expect(
			hasActiveStockFilters(parseStockFilters(new URLSearchParams())),
		).toBe(false)
		expect(
			hasActiveStockFilters(parseStockFilters(new URLSearchParams('low=1'))),
		).toBe(true)
		expect(
			clearStockFilters(
				new URLSearchParams('locationId=l2&q=a&category=meat&low=1&limit=100'),
			).toString(),
		).toBe('locationId=l2')
	})
})
