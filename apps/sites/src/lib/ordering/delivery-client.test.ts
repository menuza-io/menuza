import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type PlacesSearchState,
	createPlacesSearch,
	parsePredictions,
	parseQuoteResult,
} from './delivery-client.ts'

const address = {
	formatted: '123 Demo Street, Chicago, IL 60601',
	line1: '123 Demo Street',
	city: 'Chicago',
	postalCode: '60601',
	lat: 41.88,
	lng: -87.62,
}

describe('parseQuoteResult', () => {
	it('parses every status', () => {
		expect(
			parseQuoteResult({
				status: 'deliverable',
				quote: {
					token: 't',
					expiresAt: '2026-10-08T19:00:00Z',
					address,
					zoneId: 'z1',
					zoneName: 'Loop',
					deliveryFee: 3,
					minimumOrder: 15,
					eta: { min: 25, max: 40 },
				},
			}),
		).toMatchObject({
			status: 'deliverable',
			quote: { token: 't', deliveryFee: 3 },
		})
		expect(parseQuoteResult({ status: 'out_of_range', address })).toEqual({
			status: 'out_of_range',
			address,
		})
		expect(parseQuoteResult({ status: 'not_found' })).toEqual({
			status: 'not_found',
		})
		expect(
			parseQuoteResult({ status: 'unavailable', reason: 'no_zones' }),
		).toEqual({ status: 'unavailable', reason: 'no_zones' })
	})

	it('throws on malformed responses', () => {
		expect(() =>
			parseQuoteResult({ status: 'deliverable', quote: {} }),
		).toThrow()
		expect(() => parseQuoteResult({ status: 'nope' })).toThrow()
		expect(() => parseQuoteResult(null)).toThrow()
	})
})

describe('parsePredictions', () => {
	it('keeps only well-formed predictions', () => {
		expect(
			parsePredictions({
				predictions: [
					{ placeId: 'a', mainText: '123 Demo St', secondaryText: 'Chicago' },
					{ placeId: '', mainText: 'x' },
					{ mainText: 'y' },
					{ placeId: 'b', mainText: 'Evanston' },
				],
			}),
		).toEqual([
			{ placeId: 'a', mainText: '123 Demo St', secondaryText: 'Chicago' },
			{ placeId: 'b', mainText: 'Evanston', secondaryText: '' },
		])
		expect(parsePredictions({})).toEqual([])
	})
})

describe('createPlacesSearch', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('debounces keystrokes and ignores short queries', async () => {
		const fetchPredictions = vi.fn(async (q: string) => [
			{ placeId: q, mainText: q, secondaryText: '' },
		])
		const states: PlacesSearchState[] = []
		const search = createPlacesSearch({
			fetchPredictions,
			onState: (s) => states.push(s),
		})
		search.search('12')
		expect(states.at(-1)).toEqual({ status: 'idle', query: '12' })
		search.search('123')
		search.search('123 D')
		await vi.advanceTimersByTimeAsync(249)
		expect(fetchPredictions).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchPredictions).toHaveBeenCalledTimes(1)
		expect(fetchPredictions.mock.calls[0]?.[0]).toBe('123 D')
		expect(states.at(-1)).toMatchObject({ status: 'ready', query: '123 D' })
	})

	it('drops stale answers and reports errors', async () => {
		let resolveFirst: (v: never[]) => void = () => {}
		const fetchPredictions = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise((resolve) => (resolveFirst = resolve)),
			)
			.mockRejectedValueOnce(new Error('boom'))
		const states: PlacesSearchState[] = []
		const search = createPlacesSearch({
			fetchPredictions,
			onState: (s) => states.push(s),
		})
		search.retry('first')
		search.retry('second')
		resolveFirst([])
		await vi.runAllTimersAsync()
		expect(states.some((s) => s.status === 'ready')).toBe(false)
		expect(states.at(-1)).toMatchObject({ status: 'error', query: 'second' })
	})
})
