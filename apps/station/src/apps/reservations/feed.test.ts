import { waitlistListingSchema } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import {
	arrivals,
	availabilitySchema,
	dayFeedSchema,
	isDrawn,
	minutesLate,
	missedArrivals,
	placeTables,
	recentNoShows,
	rooms,
	shortName,
	tableState,
	takesParty,
	type DayFeed,
	type DayReservation,
} from './feed.ts'
import availability from './fixtures/availability.json'
import dayFeed from './fixtures/day-feed.json'
import waitlist from './fixtures/waitlist.json'

/** The recorded payloads are the server's real answers (see the contract test). */
const feed = dayFeedSchema.parse(dayFeed)

const MIN = 60_000

function booking(overrides: Partial<DayReservation>): DayReservation {
	return {
		...feed.reservations[0]!,
		id: `r-${Math.random()}`,
		...overrides,
	}
}

describe('the recorded host stand payloads', () => {
	it('parse with the till’s schemas', () => {
		expect(feed.reservations.map((r) => r.status)).toEqual([
			'booked',
			'seated',
			'seated',
		])
		expect(feed.tables.map((t) => t.label).sort()).toEqual(['T12', 'T2', 'T4'])
		expect(availabilitySchema.parse(availability).slots.length).toBeGreaterThan(
			0,
		)
		expect(waitlistListingSchema.parse(waitlist).entries[0]?.displayName).toBe(
			'Rana Khalid',
		)
	})

	it('carry guest details the till shows', () => {
		const maya = feed.reservations.find((r) => r.guest?.firstName === 'Maya')!
		expect(shortName(maya, 'Guest')).toBe('Maya H.')
		expect(maya.hasAllergy).toBe(true)
		expect(maya.tableLabels).toEqual(['T2'])
	})
})

describe('tableState', () => {
	const t2 = feed.tables.find((t) => t.id === 'tbl_pub_2')!
	const t4 = feed.tables.find((t) => t.id === 'tbl_pub_4')!

	it('a seated party occupies its table', () => {
		const state = tableState(t4, feed, feed.reservations[1]!.startAt)
		expect(state.kind).toBe('seated')
	})

	it('a party due within half an hour makes the table "soon", earlier it is open', () => {
		const maya = feed.reservations[0]!
		expect(tableState(t2, feed, maya.startAt - 20 * MIN).kind).toBe('soon')
		expect(tableState(t2, feed, maya.startAt - 90 * MIN)).toMatchObject({
			kind: 'open',
			next: { id: maya.id },
		})
	})

	it('a block in force wins over a booking that is not seated yet', () => {
		const now = feed.reservations[0]!.startAt
		const blocked: DayFeed = {
			...feed,
			blocks: [
				{
					id: 'b1',
					tableId: t2.id,
					areaId: null,
					startAt: now - MIN,
					endAt: now + 60 * MIN,
					reason: 'Broken chair',
				},
			],
		}
		expect(tableState(t2, blocked, now)).toMatchObject({
			kind: 'blocked',
			reason: 'Broken chair',
		})
	})
})

describe('arrivals', () => {
	it('lists parties still to seat, soonest first', () => {
		const now = Date.UTC(2026, 0, 16, 18, 0)
		const list = arrivals({
			reservations: [
				booking({ status: 'confirmed', startAt: now + 60 * MIN }),
				booking({ status: 'seated', startAt: now }),
				booking({ status: 'arrived', startAt: now + 15 * MIN }),
				booking({ status: 'cancelled', startAt: now }),
			],
		})
		expect(list.map((r) => r.status)).toEqual(['arrived', 'confirmed'])
		expect(minutesLate(list[0]!, now + 25 * MIN)).toBe(10)
		expect(minutesLate(list[1]!, now)).toBe(0)
	})
})

describe('missed arrivals', () => {
	it('a booking whose slot passed with nobody here leaves the dock for its own list', () => {
		const now = Date.UTC(2026, 0, 16, 21, 0)
		const gone = booking({
			id: 'gone',
			status: 'confirmed',
			startAt: now - 120 * MIN,
			endAt: now - 30 * MIN,
		})
		const late = booking({
			id: 'late',
			status: 'confirmed',
			startAt: now - 20 * MIN,
			endAt: now + 70 * MIN,
		})
		// Here but not seated, even past the slot: still the host's to seat.
		const waiting = booking({
			id: 'waiting',
			status: 'arrived',
			startAt: now - 120 * MIN,
			endAt: now - 30 * MIN,
		})
		const day = { reservations: [gone, late, waiting] }
		expect(arrivals(day, now).map((r) => r.id)).toEqual(['waiting', 'late'])
		expect(missedArrivals(day, now).map((r) => r.id)).toEqual(['gone'])
		// Without a time, nothing is held back.
		expect(arrivals(day)).toHaveLength(3)
	})
})

describe('recent no-shows', () => {
	const NOW = 100 * MIN
	const marked = (overrides: Partial<DayReservation>) =>
		booking({ status: 'no_show', noShowAt: NOW - 5 * MIN, ...overrides })
	it('lists those inside the undo window the till may undo, latest first', () => {
		const mine = marked({ id: 'mine', noShowAt: NOW - 10 * MIN })
		const auto = marked({ id: 'auto', canUndo: true, noShowAt: NOW - 2 * MIN })
		const old = marked({ id: 'old', noShowAt: NOW - 31 * MIN })
		// Someone else's change is a manager's to put right in the app.
		const others = marked({ id: 'others', canUndo: false })
		const shown = recentNoShows(
			{ reservations: [mine, auto, old, others] },
			NOW,
		)
		expect(shown.map((r) => r.id)).toEqual(['auto', 'mine'])
	})
})

describe('isDrawn', () => {
	const at = (x: number, y: number) => ({ x, y, archivedAt: null })
	it('a room with every table at the origin is not drawn; one placed table is', () => {
		expect(isDrawn([at(0, 0), at(0, 0)])).toBe(false)
		expect(isDrawn([at(0, 0), at(120, 0)])).toBe(true)
		expect(isDrawn([at(0, 0)])).toBe(false)
		expect(isDrawn([at(40, 80)])).toBe(true)
		expect(isDrawn([])).toBe(false)
	})
})

describe('placeTables', () => {
	it('lays out a room nobody has drawn as a grid, without overlaps', () => {
		const placed = placeTables(rooms(feed)[0]!, feed.tables)
		expect(placed).toHaveLength(3)
		for (const a of placed)
			for (const b of placed) {
				if (a === b) continue
				const apart =
					a.left + a.width <= b.left ||
					b.left + b.width <= a.left ||
					a.top + a.height <= b.top ||
					b.top + b.height <= a.top
				expect(apart).toBe(true)
			}
	})

	it('keeps a drawn room where the manager put things', () => {
		const tables = feed.tables.map((t, i) => ({ ...t, x: 100 * i, y: 50 * i }))
		const placed = placeTables({ canvasW: 1200, canvasH: 800 }, tables)
		expect(placed[1]).toMatchObject({ left: 100 / 1200, top: 50 / 800 })
	})
})

describe('takesParty', () => {
	const table = { maxCovers: 4 }
	const now = Date.UTC(2026, 0, 16, 18, 0)
	const next = booking({ id: 'next', startAt: now + 60 * MIN })

	it('wants a free table, big enough, free for the party’s whole stay', () => {
		const party = { partySize: 2, durationMin: 90 }
		expect(takesParty(table, { kind: 'open', next: null }, party, now)).toBe(
			true,
		)
		expect(takesParty(table, { kind: 'open', next }, party, now)).toBe(false)
		expect(
			takesParty(
				table,
				{ kind: 'open', next },
				{ ...party, durationMin: 45 },
				now,
			),
		).toBe(true)
		expect(
			takesParty(
				table,
				{ kind: 'open', next: null },
				{ ...party, partySize: 6 },
				now,
			),
		).toBe(false)
		expect(
			takesParty(
				table,
				{ kind: 'blocked', reason: null, next: null },
				party,
				now,
			),
		).toBe(false)
	})

	it('a party’s own booking on the table never stands in its way', () => {
		expect(
			takesParty(
				table,
				{ kind: 'soon', next },
				{ partySize: 2, durationMin: 90, reservationId: 'next' },
				now,
			),
		).toBe(true)
	})
})
