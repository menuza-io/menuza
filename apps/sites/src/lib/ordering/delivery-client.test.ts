import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tenantFetch = vi.fn()
vi.mock('~/lib/client-auth', () => ({
	getOrgBinding: () => ({ slug: 'test-org' }),
	tenantFetch: (...args: unknown[]) => tenantFetch(...args),
}))

import {
	DeliveryRequestError,
	requestDeliveryLocations,
	requestDeliveryQuote,
	type PlacesSearchState,
	createPlacesSearch,
	parseLocationsResult,
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

describe('fee tables in a quote (#244, #421)', () => {
	const quote = (extra: Record<string, unknown> = {}) => ({
		token: 't',
		expiresAt: '2026-10-08T19:00:00Z',
		address,
		zoneId: 'z1',
		zoneName: 'Loop',
		deliveryFee: 5,
		minimumOrder: 10,
		eta: { min: 25, max: 40 },
		...extra,
	})

	it('keeps the pricing the node sent', () => {
		const pricing = {
			baseFee: 5,
			steps: [
				{ from: 10, fee: 5 },
				{ from: 40, fee: 0 },
			],
			byDistance: true,
		}
		const result = parseQuoteResult({
			status: 'deliverable',
			quote: quote({ pricing }),
		})
		expect(result).toMatchObject({ quote: { pricing } })
	})

	it('reads a quote from an older node that sends no pricing', () => {
		const result = parseQuoteResult({ status: 'deliverable', quote: quote() })
		expect(
			result.status === 'deliverable' && result.quote.pricing,
		).toBeUndefined()
	})

	it('drops malformed pricing instead of trusting it', () => {
		for (const pricing of [
			{ baseFee: -1, steps: [] },
			{ baseFee: 5, steps: [{ from: 'x', fee: 1 }] },
			{ baseFee: 5 },
			'nope',
		]) {
			const result = parseQuoteResult({
				status: 'deliverable',
				quote: quote({ pricing }),
			})
			expect(
				result.status === 'deliverable' && result.quote.pricing,
			).toBeUndefined()
		}
	})
})

describe('parseLocationsResult (#161)', () => {
	const entry = (id: string, withQuote = true) => ({
		locationId: id,
		name: `Store ${id}`,
		formattedAddress: '1 Main St',
		distanceMeters: 1200,
		open: true,
		etaMinutes: { min: 40, max: 60 },
		quote: withQuote
			? {
					token: `t-${id}`,
					expiresAt: '2026-10-08T19:00:00Z',
					address,
					zoneId: 'z',
					zoneName: 'Zone',
					deliveryFee: 3,
					minimumOrder: 0,
					eta: { min: 25, max: 40 },
				}
			: null,
	})

	it('parses the ranked stores with their quotes', () => {
		const result = parseLocationsResult({
			status: 'ok',
			locations: [entry('a'), entry('b', false)],
		})
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		expect(result.locations.map((l) => l.locationId)).toEqual(['a', 'b'])
		expect(result.locations[0]).toMatchObject({
			name: 'Store a',
			distanceMeters: 1200,
			open: true,
			etaMinutes: { min: 40, max: 60 },
			quote: { token: 't-a' },
		})
		expect(result.locations[1]!.quote).toBeNull()
	})

	it('parses an empty list, not found and unavailable', () => {
		expect(parseLocationsResult({ status: 'ok', locations: [] })).toEqual({
			status: 'ok',
			locations: [],
		})
		expect(parseLocationsResult({ status: 'not_found' })).toEqual({
			status: 'not_found',
		})
		expect(
			parseLocationsResult({
				status: 'unavailable',
				reason: 'geocoding_unavailable',
			}),
		).toEqual({
			status: 'unavailable',
			reason: 'geocoding_unavailable',
		})
	})

	it('rejects a malformed answer', () => {
		expect(() => parseLocationsResult(null)).toThrow()
		expect(() =>
			parseLocationsResult({ status: 'ok', locations: [{ name: 'x' }] }),
		).toThrow()
		expect(() => parseLocationsResult({ status: 'weird' })).toThrow()
	})
})

describe('a saved address is quoted by id with the guest session (#113)', () => {
	beforeEach(() => {
		tenantFetch.mockReset()
		vi.stubGlobal('document', {
			documentElement: { dataset: { tenantApiUrl: 'https://region.test' } },
		})
	})
	afterEach(() => vi.unstubAllGlobals())

	const deliverable = {
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
		savedAddress: { id: 'a1', label: 'Home', notes: 'Gate 4411' },
	}

	it('goes through the session-aware fetch and keeps the saved address in the answer', async () => {
		tenantFetch.mockResolvedValue({
			session: 'ok',
			response: new Response(JSON.stringify(deliverable), { status: 200 }),
		})
		const result = await requestDeliveryQuote({
			locationId: 'loc-1',
			addressId: 'a1',
			locale: 'en',
		})
		expect(result).toMatchObject({
			status: 'deliverable',
			savedAddress: { id: 'a1', label: 'Home', notes: 'Gate 4411' },
		})
		const [path, init] = tenantFetch.mock.calls[0] as [string, { body: string }]
		expect(path).toBe('/delivery/quote')
		expect(JSON.parse(init.body)).toMatchObject({
			locationId: 'loc-1',
			addressId: 'a1',
			slug: 'test-org',
		})
	})

	it('does not use a typed address when the session ended', async () => {
		tenantFetch.mockResolvedValue({
			session: 'signed_out',
			response: new Response('{}', { status: 401 }),
		})
		await expect(
			requestDeliveryQuote({
				locationId: 'loc-1',
				addressId: 'a1',
				locale: 'en',
			}),
		).rejects.toMatchObject({ code: 'signed_out' })
	})

	it('raises the region code when the address is gone', async () => {
		tenantFetch.mockResolvedValue({
			session: 'ok',
			response: new Response(JSON.stringify({ error: 'address_not_found' }), {
				status: 404,
			}),
		})
		const failure = await requestDeliveryQuote({
			locationId: 'loc-1',
			addressId: 'gone',
			locale: 'en',
		}).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(DeliveryRequestError)
		expect(failure).toMatchObject({ code: 'address_not_found', status: 404 })
	})

	it('picks the store for a saved address on a brand with several', async () => {
		tenantFetch.mockResolvedValue({
			session: 'ok',
			response: new Response(JSON.stringify({ status: 'ok', locations: [] }), {
				status: 200,
			}),
		})
		await requestDeliveryLocations({
			purpose: 'delivery',
			addressId: 'a1',
			locale: 'en',
		})
		expect(tenantFetch.mock.calls[0]![0]).toBe('/delivery/locations')
	})
})
