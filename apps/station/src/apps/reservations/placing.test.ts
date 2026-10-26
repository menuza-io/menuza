import { describe, expect, it } from 'vitest'
import { DEFAULT_TURN_MIN, fitVerdict, tableState } from './feed.ts'
import {
	partyToPlace,
	reservationPlacing,
	placingKey,
	placingSize,
	type Placing,
} from './placing.ts'
import { at, day, entry, MIN, rsv } from './testing.ts'

const NOW = at(18 * 60)

describe('the party in hand', () => {
	const booking = rsv({ start: 18 * 60 + 25, partySize: 6, durationMin: 120 })
	it('is a booking seated against its own booked window', () => {
		const placing: Placing = { kind: 'reservation', reservation: booking }
		expect(partyToPlace(placing, NOW)).toEqual({
			partySize: 6,
			durationMin: 120,
			reservationId: booking.id,
			startAt: booking.startAt,
			endAt: booking.endAt,
		})
	})
	it('seats only the ones here when some are, and says so in its size', () => {
		const placing: Placing = {
			kind: 'reservation',
			reservation: booking,
			covers: 3,
		}
		expect(placingSize(placing)).toBe(3)
		expect(partyToPlace(placing, NOW).partySize).toBe(3)
		// The whole booking's window is still what it holds.
		expect(partyToPlace(placing, NOW).endAt).toBe(booking.endAt)
		expect(placingKey(placing)).toBe(`r:${booking.id}`)
	})
	it('is a party moved with the rest of its stay left, and no window of its own start', () => {
		const sitting = rsv({
			start: 17 * 60,
			status: 'seated',
			seatedAt: at(17 * 60),
			durationMin: 120,
			partySize: 4,
		})
		const placing: Placing = { kind: 'move', reservation: sitting }
		expect(partyToPlace(placing, NOW)).toEqual({
			partySize: 4,
			// Until 19:00 from 18:00.
			durationMin: 60,
			reservationId: sitting.id,
		})
		// Past their end, still a quarter hour at least.
		expect(partyToPlace(placing, NOW + 3 * 60 * MIN).durationMin).toBe(15)
	})
	it('is a turn from now for a walk-in or a waitlist party', () => {
		expect(
			partyToPlace(
				{
					kind: 'walk_in',
					partySize: 9,
					guestName: '',
					key: 'a',
					overbookKey: 'b',
				},
				NOW,
			),
		).toEqual({ partySize: 9, durationMin: DEFAULT_TURN_MIN })
		expect(
			partyToPlace({ kind: 'waitlist', entry: entry({ partySize: 3 }) }, NOW),
		).toEqual({ partySize: 3, durationMin: DEFAULT_TURN_MIN })
	})
})

describe('a booking picked up from the book', () => {
	it('is the whole party, unless only some are at the stand', () => {
		const whole = rsv({ start: 18 * 60, partySize: 5, status: 'arrived' })
		expect(reservationPlacing(whole)).toEqual({
			kind: 'reservation',
			reservation: whole,
		})
		const partly = rsv({
			start: 18 * 60,
			partySize: 5,
			status: 'arrived',
			arrivedCovers: 3,
		})
		const placing = reservationPlacing(partly)
		expect(placing).toEqual({
			kind: 'reservation',
			reservation: partly,
			covers: 3,
		})
		expect(placingSize(placing)).toBe(3)
	})
})

describe('a booking picked up to be given a table', () => {
	const booking = rsv({ start: 19 * 60, partySize: 4, durationMin: 90 })
	it('is judged by its own window, and a table taken now may be free by then', () => {
		const placing: Placing = { kind: 'assign', reservation: booking }
		expect(placingSize(placing)).toBe(4)
		expect(placingKey(placing)).toBe(`a:${booking.id}`)
		expect(partyToPlace(placing, NOW)).toEqual({
			partySize: 4,
			durationMin: 90,
			reservationId: booking.id,
			startAt: booking.startAt,
			endAt: booking.endAt,
			future: true,
		})
	})
	it('is not a party seated now: a seated table is "taken" for one, free by the window for the other', () => {
		const seatedUntil1830 = rsv({
			start: 17 * 60,
			status: 'seated',
			tableIds: ['t2'],
			durationMin: 90,
		})
		const feed = day([seatedUntil1830, booking])
		const table = feed.tables.find((t) => t.id === 't2')!
		const state = tableState(table, feed, NOW)
		expect(state.kind).toBe('seated')
		expect(
			fitVerdict(
				table,
				state,
				partyToPlace({ kind: 'reservation', reservation: booking }, NOW),
				NOW,
				feed,
			),
		).toEqual({ fits: false, why: 'taken' })
		expect(
			fitVerdict(
				table,
				state,
				partyToPlace({ kind: 'assign', reservation: booking }, NOW),
				NOW,
				feed,
			),
		).toEqual({ fits: true })
	})
	it('counts a party seated late until they are expected to clear, not their booked end', () => {
		// Booked 17:00 to 18:30, sat at 17:50: their 90 minutes run to 19:20.
		const seatedLate = rsv({
			start: 17 * 60,
			status: 'seated',
			seatedAt: at(17 * 60 + 50),
			tableIds: ['t2'],
			durationMin: 90,
		})
		const feed = day([seatedLate, booking])
		const table = feed.tables.find((t) => t.id === 't2')!
		const placing: Placing = { kind: 'assign', reservation: booking }
		expect(
			fitVerdict(
				table,
				tableState(table, feed, NOW),
				partyToPlace(placing, NOW),
				NOW,
				feed,
			),
		).toEqual({ fits: false, why: 'taken' })
		// A booking after they clear still fits.
		const later = rsv({ start: 19 * 60 + 30, partySize: 4, durationMin: 90 })
		const laterFeed = day([seatedLate, later])
		expect(
			fitVerdict(
				table,
				tableState(table, laterFeed, NOW),
				partyToPlace({ kind: 'assign', reservation: later }, NOW),
				NOW,
				laterFeed,
			),
		).toEqual({ fits: true })
	})
	it('counts a party over their time as still there now, not gone at their booked end', () => {
		// Booked 16:30 to 18:00 and still sitting at 18:10.
		const over = rsv({
			start: 16 * 60 + 30,
			status: 'seated',
			seatedAt: at(16 * 60 + 30),
			tableIds: ['t2'],
			durationMin: 90,
		})
		const later = NOW + 10 * MIN
		const table = day([]).tables.find((t) => t.id === 't2')!
		const verdictFor = (start: number) => {
			const booking = rsv({ start, partySize: 4, durationMin: 90 })
			const feed = day([over, booking])
			return fitVerdict(
				table,
				tableState(table, feed, later),
				partyToPlace({ kind: 'assign', reservation: booking }, later),
				later,
				feed,
			)
		}
		// A booking due at 18:05 (not here yet) cannot have the table they are still at.
		expect(verdictFor(18 * 60 + 5)).toEqual({ fits: false, why: 'taken' })
		// One later on can: they are expected to leave any minute.
		expect(verdictFor(18 * 60 + 30)).toEqual({ fits: true })
	})
})
