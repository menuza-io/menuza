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

describe('quoteWaitlistMin rechecks future occupancies during the simulation', () => {
	const nowMs = Date.parse('2026-06-12T19:00:00.000Z')
	const at = (hhmm: string) => Date.parse(`2026-06-12T${hhmm}:00.000Z`)
	const oneTable = [
		{ id: 't1', areaId: 'a1', minSeats: 2, maxSeats: 4, active: true },
	]

	it('does not seat a 90-minute turn on a table reserved 20:00-21:00', () => {
		const quote = quoteWaitlistMin({
			partySize: 2,
			nowMs,
			tables: oneTable,
			occupancies: [
				{
					id: 'seated',
					tableIds: ['t1'],
					startAt: at('18:00'),
					endAt: at('19:45'),
					status: 'seated',
				},
				{
					id: 'future',
					tableIds: ['t1'],
					startAt: at('20:00'),
					endAt: at('21:00'),
					status: 'booked',
				},
			],
			defaultTurnMin: 90,
			bufferMin: 0,
		})
		expect(nowMs + quote.quotedWaitMin! * 60_000).toBe(at('21:00'))
	})

	it('uses a gap before the future reservation when the turn fits', () => {
		const quote = quoteWaitlistMin({
			partySize: 2,
			nowMs,
			tables: oneTable,
			occupancies: [
				{
					id: 'future',
					tableIds: ['t1'],
					startAt: at('20:45'),
					endAt: at('21:30'),
					status: 'booked',
				},
			],
			defaultTurnMin: 60,
			bufferMin: 15,
		})
		expect(quote.quotedWaitMin).toBe(0)
	})

	it('rechecks reservations after parties ahead advance table availability', () => {
		const quote = quoteWaitlistMin({
			partySize: 2,
			nowMs,
			tables: oneTable,
			occupancies: [
				{
					id: 'future',
					tableIds: ['t1'],
					startAt: at('20:30'),
					endAt: at('21:30'),
					status: 'booked',
				},
			],
			entriesAhead: [
				{
					id: 'wl_1',
					partySize: 2,
					status: 'waiting',
					createdAt: 1,
					turnMin: 45,
				},
			],
			defaultTurnMin: 60,
			bufferMin: 0,
		})
		// Party ahead sits 19:00-19:45; our 60 minutes would hit 20:30, so we wait for 21:30.
		expect(nowMs + quote.quotedWaitMin! * 60_000).toBe(at('21:30'))
	})

	it('property: a quoted seating never overlaps a future occupancy', () => {
		let seed = 12345
		const rnd = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff
			return seed % n
		}
		for (let i = 0; i < 300; i++) {
			const turnMin = 30 + rnd(4) * 30
			const bufferMin = rnd(3) * 10
			const occupancies = Array.from({ length: rnd(5) }, (_, k) => {
				const start = nowMs + (rnd(300) - 30) * 60_000
				return {
					id: `o${k}`,
					tableIds: ['t1'],
					startAt: start,
					endAt: start + (30 + rnd(120)) * 60_000,
					status: 'booked',
				}
			})
			const quote = quoteWaitlistMin({
				partySize: 2,
				nowMs,
				tables: oneTable,
				occupancies,
				entriesAhead: Array.from({ length: rnd(3) }, (_, k) => ({
					id: `w${k}`,
					partySize: 2,
					status: 'waiting',
					createdAt: k,
				})),
				defaultTurnMin: turnMin,
				bufferMin,
			})
			const start = nowMs + quote.quotedWaitMin! * 60_000
			const end = start + (turnMin + bufferMin) * 60_000
			{
				for (const o of occupancies) {
					if (o.endAt <= nowMs) continue
					expect(o.startAt < end && start < o.endAt).toBe(false)
				}
			}
		}
	})
})
