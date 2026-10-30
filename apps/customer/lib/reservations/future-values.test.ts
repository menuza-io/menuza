import { describe, expect, it } from '@jest/globals'
import { reservationHoldSchema } from './models'
import {
	decodeFixture,
	fixtureJson,
	FUTURE_FIXTURE_NAMES,
	futureFixtureText,
} from '@/test/reservations/fixtures'
import { makeReservationsClient } from '@/test/reservations/session'
import { StubTransport } from '@/test/stub-transport'

// What an older app does with values a newer region may send: a new day
// status is kept as a plain string, and a new closure source decodes to
// 'unknown' instead of failing the search.

async function clientFor(...names: string[]) {
	const transport = new StubTransport(
		names.map((name) => ({ raw: futureFixtureText(name) })),
	)
	return makeReservationsClient(transport.send)
}

const SEARCH = {
	locationId: 'loc_pub_main',
	date: '2030-06-24',
	partySize: 2,
}

describe('future values from the region', () => {
	it('covers every future-values fixture', () => {
		expect([...FUTURE_FIXTURE_NAMES].sort()).toEqual([
			'availability-closed',
			'availability-new-status',
			'calendar',
		])
	})

	it('decodes a closed day whose source is new', async () => {
		const client = await clientFor('availability-closed')
		const result = await client.availability(SEARCH)
		expect(result.status).toBe('closed')
		expect(result.closed?.source).toBe('unknown')
		expect(result.closed?.name).toBe('Founders day')
	})

	it('keeps a new day status as sent', async () => {
		const client = await clientFor('availability-new-status')
		const result = await client.availability(SEARCH)
		expect(result.status).toBe('paused')
		expect(result.slots).toEqual([])
	})

	it('decodes a calendar with a new day status and closure source', async () => {
		const client = await clientFor('calendar')
		const calendar = await client.calendar({
			locationId: 'loc_pub_main',
			partySize: 2,
			from: '2030-06-24',
			to: '2030-06-27',
		})
		expect(
			calendar.days.map((day) => [day.date, day.status, day.closedSource]),
		).toEqual([
			['2030-06-24', 'available', undefined],
			['2030-06-25', 'paused', undefined],
			['2030-06-26', 'closed', 'unknown'],
			['2030-06-27', 'closed', 'location_hours'],
		])
	})
})

describe('currency codes', () => {
	it('refuses a payment policy whose currency is not an ISO code', () => {
		for (const currency of ['usd', 'US', 'USD$', '']) {
			const body = fixtureJson('hold-requires-payment')
			body.policy.currency = currency
			expect(() => decodeFixture(reservationHoldSchema, body)).toThrow()
		}
		expect(
			decodeFixture(reservationHoldSchema, 'hold-requires-payment').policy
				?.currency,
		).toBe('USD')
	})
})
