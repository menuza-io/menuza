import { describe, expect, it, vi } from 'vitest'
import { createReservationsApi, ReservationsApiError } from './api.ts'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function setup(responses: Response[] = [jsonResponse({})]) {
	const queue = [...responses]
	const fetchImpl = vi.fn(
		async (_url: string, _init: RequestInit) =>
			queue.shift() ?? jsonResponse({}),
	)
	const api = createReservationsApi({
		baseUrl: 'http://localhost:3007/',
		fetchImpl: fetchImpl as unknown as typeof fetch,
		newKey: () => 'key-1',
	})
	return { api, fetchImpl }
}

function lastCall(fetchImpl: ReturnType<typeof setup>['fetchImpl']) {
	const [url, init] = fetchImpl.mock.calls.at(-1)!
	return { url, init, headers: new Headers(init.headers) }
}

describe('reservations api', () => {
	it('marks every call as the web client and never names an organization', async () => {
		const { api, fetchImpl } = setup()
		await api.config('ar')
		const { url, headers } = lastCall(fetchImpl)
		expect(url).toBe('http://localhost:3007/reservations/config?locale=ar')
		expect(headers.get('X-Client')).toBe('web')
		expect(url).not.toMatch(/slug|org/i)
	})

	it('books with an Idempotency-Key and a JSON body', async () => {
		const { api, fetchImpl } = setup()
		await api.book({ holdToken: 'h' })
		const { url, init, headers } = lastCall(fetchImpl)
		expect(url).toBe('http://localhost:3007/reservations')
		expect(init.method).toBe('POST')
		expect(headers.get('Idempotency-Key')).toBe('key-1')
		expect(headers.get('Content-Type')).toBe('application/json')
		expect(JSON.parse(init.body as string)).toEqual({ holdToken: 'h' })
	})

	it('sends the same key again when the caller retries with it', async () => {
		const { api, fetchImpl } = setup([jsonResponse({}), jsonResponse({})])
		await api.book({ a: 1 }, 'retry-key')
		await api.book({ a: 1 }, 'retry-key')
		const keys = fetchImpl.mock.calls.map(([, init]) =>
			new Headers(init.headers).get('Idempotency-Key'),
		)
		expect(keys).toEqual(['retry-key', 'retry-key'])
	})

	it('sends manage tokens in X-Reservation-Token, never in the URL', async () => {
		const { api, fetchImpl } = setup()
		await api.manage.view('secret-token')
		const { url, headers } = lastCall(fetchImpl)
		expect(headers.get('X-Reservation-Token')).toBe('secret-token')
		expect(url).toBe('http://localhost:3007/reservations/manage')
		expect(url).not.toContain('secret-token')
	})

	it('resumes a voice-agent hold with the token header', async () => {
		const { api, fetchImpl } = setup()
		await api.currentHold('hold-token')
		const { url, headers } = lastCall(fetchImpl)
		expect(url).toBe('http://localhost:3007/reservations/holds/current')
		expect(headers.get('X-Reservation-Token')).toBe('hold-token')
	})

	it('uses POST for every mutation and GET for reads', async () => {
		const { api, fetchImpl } = setup(
			Array.from({ length: 12 }, () => jsonResponse({})),
		)
		await api.availability({
			locationId: 'l',
			date: '2030-01-01',
			partySize: 2,
		})
		await api.calendar({ locationId: 'l', partySize: 2, from: 'a', to: 'b' })
		await api.manage.view('t')
		await api.manage.availability('t', { date: '2030-01-01' })
		await api.mine()
		const reads = fetchImpl.mock.calls.map(([, init]) => init.method)
		expect(new Set(reads)).toEqual(new Set(['GET']))

		fetchImpl.mockClear()
		await api.createHold({
			locationId: 'l',
			slot: { date: '2030-01-01', localMin: 1140, partySize: 2 },
		})
		await api.releaseHold('h')
		await api.requestLargeParty({})
		await api.manage.modify('t', { localMin: 1200 })
		await api.manage.cancel('t')
		await api.manage.confirm('t')
		await api.manage.runningLate('t', 10)
		const writes = fetchImpl.mock.calls.map(([, init]) => init.method)
		expect(new Set(writes)).toEqual(new Set(['POST']))
	})

	it('throws a typed error carrying the server code', async () => {
		const { api } = setup([
			jsonResponse({ error: 'slot_unavailable', alternatives: [] }, 409),
		])
		await expect(
			api.createHold({
				locationId: 'l',
				slot: { date: '2030-01-01', localMin: 1140, partySize: 2 },
			}),
		).rejects.toMatchObject({
			name: 'ReservationsApiError',
			status: 409,
			code: 'slot_unavailable',
		})
		expect(new ReservationsApiError(500, 'x', {})).toBeInstanceOf(Error)
	})

	it('attaches the customer token when signed in and retries anonymously when it is refused', async () => {
		const authedFetch = vi.fn(async (_path: string, _init: RequestInit) =>
			jsonResponse({ error: 'unauthorized' }, 401),
		)
		const clearSession = vi.fn()
		const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
			jsonResponse({ reservation: {} }, 201),
		)
		const api = createReservationsApi({
			baseUrl: 'http://localhost:3007',
			fetchImpl: fetchImpl as unknown as typeof fetch,
			authedFetch,
			isSignedIn: () => true,
			clearSession,
			newKey: () => 'k',
		})
		await api.book({ holdToken: 'h' })
		expect(authedFetch).toHaveBeenCalledTimes(1)
		expect(clearSession).toHaveBeenCalledTimes(1)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it('keeps a refusal that is not about the customer token', async () => {
		const authedFetch = vi.fn(async (_path: string, _init: RequestInit) =>
			jsonResponse({ error: 'verification_failed' }, 403),
		)
		const fetchImpl = vi.fn()
		const api = createReservationsApi({
			baseUrl: 'http://localhost:3007',
			fetchImpl: fetchImpl as unknown as typeof fetch,
			authedFetch,
			isSignedIn: () => true,
		})
		await expect(api.book({})).rejects.toMatchObject({
			code: 'verification_failed',
		})
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})
