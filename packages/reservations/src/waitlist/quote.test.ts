import { describe, expect, it } from 'vitest'
import { quoteWaitlistMin } from './quote.ts'

describe('quoteWaitlistMin waitlist wait-time estimation', () => {
	const nowMs = Date.parse('2026-06-12T22:00:00.000Z')

	const tables = [
		{ id: 't1', areaId: 'a1', minSeats: 2, maxSeats: 2, active: true },
		{ id: 't2', areaId: 'a1', minSeats: 2, maxSeats: 4, active: true },
	]

	it('quotes 0 minutes when a fitting table is immediately free and no fitting parties are ahead', () => {
		const quote = quoteWaitlistMin({
			partySize: 2,
			nowMs,
			tables,
			combinations: [],
			occupancies: [],
			entriesAhead: [],
			defaultTurnMin: 60,
			bufferMin: 15,
		})
		expect(quote.quotedWaitMin).toBe(0)
		expect(quote.positionInLine).toBe(1)
		expect(quote.fittingPartiesAhead).toBe(0)
	})

	it('simulates table release times across seated occupancies and queued parties ahead in FIFO order', () => {
		// Both t1 and t2 are currently occupied:
		// t1 frees in 20 minutes; t2 frees in 35 minutes.
		// One 2-top is already waiting ahead in line -> takes t1 at +20m, so new 2-top gets t2 at +35m!
		const quote = quoteWaitlistMin({
			partySize: 2,
			nowMs,
			tables,
			combinations: [],
			occupancies: [
				{
					id: 'occ_1',
					tableIds: ['t1'],
					startAt: nowMs - 40 * 60_000,
					endAt: nowMs + 20 * 60_000,
					status: 'seated',
				},
				{
					id: 'occ_2',
					tableIds: ['t2'],
					startAt: nowMs - 25 * 60_000,
					endAt: nowMs + 35 * 60_000,
					status: 'seated',
				},
			],
			entriesAhead: [
				{
					id: 'wl_1',
					partySize: 2,
					status: 'waiting',
					createdAt: nowMs - 10 * 60_000,
				},
			],
			defaultTurnMin: 60,
			bufferMin: 15,
		})

		expect(quote.positionInLine).toBe(2)
		expect(quote.fittingPartiesAhead).toBe(1)
		expect(quote.quotedWaitMin).toBe(35)
	})

	it('counts a party that is on the way as still ahead in line', () => {
		const quote = quoteWaitlistMin({
			partySize: 2,
			nowMs,
			tables,
			combinations: [],
			occupancies: [],
			entriesAhead: [
				{
					id: 'wl_1',
					partySize: 2,
					status: 'on_the_way',
					createdAt: nowMs - 10 * 60_000,
				},
			],
			defaultTurnMin: 60,
			bufferMin: 15,
		})
		expect(quote.positionInLine).toBe(2)
		expect(quote.fittingPartiesAhead).toBe(1)
	})
})
