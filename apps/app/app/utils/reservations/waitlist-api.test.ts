import { describe, expect, it, vi } from 'vitest'
import { type ReservationsScopedClient } from './reservations-client.ts'
import {
	addWaitlistEntry,
	fetchWaitlist,
	fetchWaitlistQuote,
	fetchWaitlistSettings,
	notifyWaitlistEntry,
	reorderWaitlist,
	saveWaitlistSettings,
	seatWaitlistEntry,
	setWaitlistEntryStatus,
	updateWaitlistEntry,
	waitlistListingSignature,
} from './waitlist-api.ts'
import { makeWaitlistEntry, makeWaitlistListing } from './waitlist-fixtures.ts'

function createClient(
	request: (path: string, opts?: any) => Promise<any> = async () => ({}),
	conditional: (path: string, opts?: any) => Promise<any> = async () => ({
		status: 200,
		data: {},
		etag: null,
	}),
) {
	const client = {
		scope: 'book',
		request: vi.fn(request),
		requestConditional: vi.fn(conditional),
		getToken: vi.fn(),
		invalidate: vi.fn(),
	}
	return client as unknown as ReservationsScopedClient & {
		request: ReturnType<typeof vi.fn>
		requestConditional: ReturnType<typeof vi.fn>
	}
}

describe('waitlist-api', () => {
	it('lists the queue with location and date', async () => {
		const listing = makeWaitlistListing([makeWaitlistEntry({ id: 'w1' })])
		const client = createClient(undefined, async () => ({
			status: 200,
			data: listing,
			etag: '"a"',
		}))
		const res = await fetchWaitlist(client, {
			locationId: 'loc_1',
			date: '2026-04-20',
		})
		expect(res.status).toBe(200)
		expect(client.requestConditional).toHaveBeenCalledWith(
			'/operator/reservations/book/waitlist',
			expect.objectContaining({
				query: { locationId: 'loc_1', date: '2026-04-20' },
			}),
		)
		if (res.status === 200) {
			expect(res.data.entries[0]?.displayName).toBe('Guest w1')
		}
	})

	it('passes a 304 through untouched', async () => {
		const client = createClient(undefined, async () => ({
			status: 304,
			etag: '"a"',
		}))
		const res = await fetchWaitlist(client, { locationId: 'loc_1' }, '"a"')
		expect(res.status).toBe(304)
	})

	it('rejects a malformed listing instead of rendering it', async () => {
		const client = createClient(undefined, async () => ({
			status: 200,
			data: { entries: [{ id: 1 }] },
			etag: null,
		}))
		await expect(
			fetchWaitlist(client, { locationId: 'loc_1' }),
		).rejects.toThrow()
	})

	it('asks for a quote with party size and optional area', async () => {
		const client = createClient(async () => ({
			locationId: 'loc_1',
			businessDate: '2026-04-20',
			partySize: 4,
			quotedMin: 25,
			quotedReadyAt: 1,
			position: 3,
			now: 1,
		}))
		const quote = await fetchWaitlistQuote(client, {
			locationId: 'loc_1',
			partySize: 4,
			areaId: 'area_1',
		})
		expect(quote.quotedMin).toBe(25)
		expect(client.request).toHaveBeenCalledWith(
			'/operator/reservations/book/waitlist/quote',
			expect.objectContaining({
				query: { locationId: 'loc_1', partySize: 4, areaId: 'area_1' },
			}),
		)
	})

	it('adds a party with an Idempotency-Key header and drops opt-in without a phone', async () => {
		const client = createClient(async () => ({
			entry: makeWaitlistEntry({ id: 'w1' }),
		}))
		await addWaitlistEntry(
			client,
			{
				locationId: 'loc_1',
				displayName: 'Rana',
				partySize: 3,
				phone: '',
				smsOptIn: true,
			},
			'key-1',
		)
		const [path, options] = client.request.mock.calls[0]!
		expect(path).toBe('/operator/reservations/book/waitlist')
		expect(options.method).toBe('POST')
		expect(options.headers).toEqual({ 'Idempotency-Key': 'key-1' })
		expect(options.body).toMatchObject({
			locationId: 'loc_1',
			displayName: 'Rana',
			partySize: 3,
			phone: null,
			smsOptIn: false,
		})
	})

	it('generates an idempotency key when none is given', async () => {
		const client = createClient(async () => ({
			entry: makeWaitlistEntry({ id: 'w1' }),
		}))
		await addWaitlistEntry(client, {
			locationId: 'loc_1',
			displayName: 'Rana',
			partySize: 2,
		})
		const options = client.request.mock.calls[0]![1]
		expect(options.headers['Idempotency-Key']).toBeTruthy()
	})

	it('sends expectedVersion on every mutation', async () => {
		const entry = makeWaitlistEntry({ id: 'w1', version: 7 })
		const client = createClient(async () => ({ entry, changed: true }))
		await updateWaitlistEntry(client, 'w1', {
			expectedVersion: 7,
			partySize: 5,
		})
		await notifyWaitlistEntry(client, 'w1', 7)
		await setWaitlistEntryStatus(client, 'w1', 'on_the_way', 7)
		const calls = client.request.mock.calls
		expect(calls[0]![0]).toBe('/operator/reservations/book/waitlist/w1')
		expect(calls[0]![1]).toMatchObject({
			method: 'PATCH',
			body: { expectedVersion: 7, partySize: 5 },
		})
		expect(calls[1]![0]).toBe('/operator/reservations/book/waitlist/w1/notify')
		expect(calls[1]![1].body).toEqual({ expectedVersion: 7 })
		expect(calls[2]![0]).toBe('/operator/reservations/book/waitlist/w1/status')
		expect(calls[2]![1].body).toEqual({
			status: 'on_the_way',
			expectedVersion: 7,
		})
	})

	it('reports whether a repeated notify changed anything', async () => {
		const entry = makeWaitlistEntry({ id: 'w1', status: 'notified' })
		const client = createClient(async () => ({ entry, changed: false }))
		const result = await notifyWaitlistEntry(client, 'w1', 2)
		expect(result.changed).toBe(false)
	})

	it('seats with table ids, a version and an Idempotency-Key', async () => {
		const client = createClient(async () => ({
			entry: makeWaitlistEntry({ id: 'w1', status: 'seated' }),
			reservation: null,
			moves: [],
		}))
		const result = await seatWaitlistEntry(
			client,
			'w1',
			{ tableIds: ['t1', 't2'], expectedVersion: 3 },
			'seat-key',
		)
		expect(result.entry.status).toBe('seated')
		expect(result.reservation).toBeNull()
		const [path, options] = client.request.mock.calls[0]!
		expect(path).toBe('/operator/reservations/book/waitlist/w1/seat')
		expect(options.headers).toEqual({ 'Idempotency-Key': 'seat-key' })
		expect(options.body).toEqual({ tableIds: ['t1', 't2'], expectedVersion: 3 })
	})

	it('omits tableIds for auto-assign and always names a reason when overbooking', async () => {
		const client = createClient(async () => ({
			entry: makeWaitlistEntry({ id: 'w1', status: 'seated' }),
		}))
		await seatWaitlistEntry(client, 'w1', {})
		expect(client.request.mock.calls[0]![1].body).toEqual({})
		await seatWaitlistEntry(client, 'w1', {
			tableIds: ['t1'],
			overbook: true,
			overbookReason: '  ',
		})
		const body = client.request.mock.calls[1]![1].body
		expect(body.overbook).toBe(true)
		expect(body.overbookReason).toBeTruthy()
	})

	it('posts the complete new order to reorder', async () => {
		const listing = makeWaitlistListing([makeWaitlistEntry({ id: 'w1' })])
		const client = createClient(async () => listing)
		await reorderWaitlist(client, { locationId: 'loc_1', ids: ['w2', 'w1'] })
		expect(client.request).toHaveBeenCalledWith(
			'/operator/reservations/book/waitlist/reorder',
			{
				method: 'POST',
				body: { locationId: 'loc_1', ids: ['w2', 'w1'] },
			},
		)
	})

	it('reads and saves waitlist settings through the setup path', async () => {
		const settings = {
			locationId: 'loc_1',
			version: 4,
			waitlistEnabled: true,
			waitlistOnline: false,
			notifyMeEnabled: true,
			waitlistResponseMin: 15,
			waitlistMaxParties: null,
		}
		const client = createClient(async () => settings)
		await expect(fetchWaitlistSettings(client, 'loc_1')).resolves.toMatchObject(
			{ version: 4 },
		)
		await saveWaitlistSettings(client, 'loc_1', {
			expectedVersion: 4,
			waitlistResponseMin: 20,
			waitlistMaxParties: 30,
		})
		expect(client.request).toHaveBeenLastCalledWith(
			'/operator/reservations/setup/locations/loc_1/waitlist',
			{
				method: 'PUT',
				body: {
					expectedVersion: 4,
					waitlistResponseMin: 20,
					waitlistMaxParties: 30,
				},
			},
		)
	})

	it('ignores the server clock when comparing listings', () => {
		const entries = [makeWaitlistEntry({ id: 'w1' })]
		const a = makeWaitlistListing(entries, { now: 1 })
		const b = makeWaitlistListing(entries, { now: 99_999 })
		expect(waitlistListingSignature(a)).toBe(waitlistListingSignature(b))
		const changed = makeWaitlistListing([
			makeWaitlistEntry({ id: 'w1', version: 2 }),
		])
		expect(waitlistListingSignature(changed)).not.toBe(
			waitlistListingSignature(a),
		)
	})
})
