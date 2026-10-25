import { waitlistListingSchema } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import {
	arrivals,
	availabilitySchema,
	bestFit,
	dayFeedSchema,
	fitVerdict,
	freeUntil,
	isDrawn,
	minutesLate,
	openSlotAt,
	missedArrivals,
	placeTables,
	recentNoShows,
	rooms,
	shortName,
	tableState,
	takesParty,
	type DayFeed,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import availability from './fixtures/availability.json'
import dayFeed from './fixtures/day-feed.json'
import waitlist from './fixtures/waitlist.json'
import { at, day, rsv } from './testing.ts'

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
	it('lists those inside the undo window, latest first, undoable or not', () => {
		const mine = marked({ id: 'mine', noShowAt: NOW - 10 * MIN })
		const auto = marked({ id: 'auto', canUndo: true, noShowAt: NOW - 2 * MIN })
		const old = marked({ id: 'old', noShowAt: NOW - 31 * MIN })
		// Someone else's change stays visible, so a guest who turns up is found.
		const others = marked({ id: 'others', canUndo: false })
		const shown = recentNoShows(
			{ reservations: [mine, auto, old, others] },
			NOW,
		)
		expect(shown.map((r) => r.id)).toEqual(['auto', 'others', 'mine'])
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

describe('why a table does not take the party', () => {
	const table = { maxCovers: 4 }
	const now = Date.UTC(2026, 0, 16, 18, 0)
	const next = booking({ id: 'next', startAt: now + 60 * MIN })
	const party = { partySize: 2, durationMin: 90 }
	it('says taken for a seated or blocked table, before anything else', () => {
		const seated: TableState = {
			kind: 'seated',
			party: booking({}),
			next: null,
		}
		expect(fitVerdict(table, seated, { ...party, partySize: 9 }, now)).toEqual({
			fits: false,
			why: 'taken',
		})
		expect(
			fitVerdict(
				table,
				{ kind: 'blocked', reason: null, next: null },
				party,
				now,
			),
		).toEqual({ fits: false, why: 'taken' })
	})
	it('says too small, then booked (with when)', () => {
		expect(
			fitVerdict(
				table,
				{ kind: 'open', next: null },
				{ ...party, partySize: 6 },
				now,
			),
		).toEqual({ fits: false, why: 'small' })
		expect(fitVerdict(table, { kind: 'open', next }, party, now)).toEqual({
			fits: false,
			why: 'booked',
			at: next.startAt,
		})
		expect(fitVerdict(table, { kind: 'open', next: null }, party, now)).toEqual(
			{
				fits: true,
			},
		)
	})
})

describe('the best table for a party', () => {
	const now = Date.UTC(2026, 0, 16, 18, 0)
	const make = (id: string, label: string, maxCovers: number): DayTable => ({
		...feed.tables[0]!,
		id,
		label,
		maxCovers,
		minCovers: 1,
	})
	const open: TableState = { kind: 'open', next: null }
	const party = { partySize: 2, durationMin: 90 }
	it('is the smallest free table that fits, the lowest number on a tie', () => {
		const candidates = [
			{ table: make('a', '10', 6), state: open },
			{ table: make('b', '12', 2), state: open },
			{ table: make('c', '3', 2), state: open },
			{ table: make('d', '1', 1), state: open },
		]
		expect(bestFit(candidates, party, now)).toBe('c')
	})
	it('skips a table that is taken or booked too soon', () => {
		const next = booking({ id: 'n', startAt: now + 30 * MIN })
		const candidates = [
			{ table: make('a', '1', 2), state: { kind: 'open', next } as TableState },
			{
				table: make('b', '2', 2),
				state: { kind: 'blocked', reason: null, next: null } as TableState,
			},
			{ table: make('c', '3', 8), state: open },
		]
		expect(bestFit(candidates, party, now)).toBe('c')
	})
	it('is none when nothing takes the party', () => {
		expect(
			bestFit([{ table: make('a', '1', 1), state: open }], party, now),
		).toBeNull()
		expect(bestFit([], party, now)).toBeNull()
	})
})

describe('free until', () => {
	const now = Date.UTC(2026, 0, 16, 18, 0)
	it('names the next booking when it is within three hours', () => {
		const next = booking({ id: 'n', startAt: now + 2 * 60 * MIN })
		expect(freeUntil({ kind: 'open', next }, now)).toEqual({
			until: next.startAt,
			next,
		})
	})
	it('is nothing for a table open the long run, or not open', () => {
		const far = booking({ id: 'f', startAt: now + 4 * 60 * MIN })
		expect(freeUntil({ kind: 'open', next: far }, now)).toBeNull()
		expect(freeUntil({ kind: 'open', next: null }, now)).toBeNull()
		expect(
			freeUntil({ kind: 'blocked', reason: null, next: far }, now),
		).toBeNull()
	})
})

describe('the slot a booking starts at', () => {
	const slot = (localStartMin: number, available = true) => ({
		localStartMin,
		time: `${String(Math.floor(localStartMin / 60) % 24).padStart(2, '0')}:${String(localStartMin % 60).padStart(2, '0')}`,
		available,
		suggestedTableIds: [],
	})
	it('is found by its minute, so 01:30 after midnight is not 01:30 in the morning', () => {
		const slots = [slot(90), slot(25 * 60 + 30)]
		// Both read "01:30"; the minute tells them apart.
		expect(slots[0]!.time).toBe(slots[1]!.time)
		expect(openSlotAt(slots, 25 * 60 + 30)).toBe(slots[1])
		expect(openSlotAt(slots, 90)).toBe(slots[0])
	})
	it('is nothing when the slot is full, missing, or no time was asked for', () => {
		const slots = [slot(19 * 60, false)]
		expect(openSlotAt(slots, 19 * 60)).toBeUndefined()
		expect(openSlotAt(slots, 20 * 60)).toBeUndefined()
		expect(openSlotAt(slots, null)).toBeUndefined()
	})
})

describe('a table kept through its reset buffer', () => {
	const NOW_AT = at(13 * 60)
	const reset = (minutes: number) => ({
		id: 'tr',
		areaId: 'a1',
		resetBufferMin: minutes,
	})
	const feedOf = (
		reservations: ReturnType<typeof rsv>[],
		extra: Partial<Record<string, unknown>> = {},
	) => day(reservations, extra)
	const left = (minutesAgo: number) =>
		rsv({
			start: 11 * 60,
			status: 'finished',
			tableIds: ['tr'],
			seatedAt: NOW_AT - 90 * MIN,
			finishedAt: NOW_AT - minutesAgo * MIN,
		})

	it('is resetting for the buffer after a party is cleared, then open', () => {
		const feed = feedOf([left(4)])
		const state = tableState(reset(10), feed, NOW_AT)
		expect(state).toMatchObject({ kind: 'resetting' })
		expect(state.kind === 'resetting' && state.readyAt).toBe(NOW_AT + 6 * MIN)
		// The minute it is over, the table is open again.
		expect(tableState(reset(10), feed, NOW_AT + 6 * MIN - 1).kind).toBe(
			'resetting',
		)
		expect(tableState(reset(10), feed, NOW_AT + 6 * MIN).kind).toBe('open')
	})
	it('is never resetting for a table with no buffer, or a party cleared long ago', () => {
		expect(tableState(reset(0), feedOf([left(1)]), NOW_AT).kind).toBe('open')
		expect(tableState(reset(10), feedOf([left(11)]), NOW_AT).kind).toBe('open')
		expect(
			tableState({ id: 'tr', areaId: 'a1' }, feedOf([left(1)]), NOW_AT).kind,
		).toBe('open')
	})
	it('is only for a party that finished (a no-show or a cancel leaves no mess)', () => {
		for (const status of ['no_show', 'cancelled'])
			expect(
				tableState(
					reset(10),
					feedOf([
						rsv({
							start: 11 * 60,
							status,
							tableIds: ['tr'],
							finishedAt: NOW_AT - MIN,
						}),
					]),
					NOW_AT,
				).kind,
			).toBe('open')
	})
	it('uses the latest party when two left in a row', () => {
		const state = tableState(reset(10), feedOf([left(8), left(2)]), NOW_AT)
		expect(state.kind === 'resetting' && state.readyAt).toBe(NOW_AT + 8 * MIN)
	})
	it('gives way to someone seated or a block, and keeps the next booking', () => {
		const sitting = rsv({
			start: 13 * 60,
			status: 'seated',
			tableIds: ['tr'],
			seatedAt: NOW_AT,
		})
		expect(tableState(reset(10), feedOf([left(2), sitting]), NOW_AT).kind).toBe(
			'seated',
		)
		const taped = feedOf([left(2)], {
			blocks: [
				{ id: 'b', tableId: 'tr', startAt: NOW_AT - MIN, endAt: NOW_AT + MIN },
			],
		})
		expect(tableState(reset(10), taped, NOW_AT).kind).toBe('blocked')
		const due = rsv({
			start: 13 * 60 + 20,
			tableIds: ['tr'],
			status: 'confirmed',
		})
		const state = tableState(reset(10), feedOf([left(2), due]), NOW_AT)
		expect(state).toMatchObject({ kind: 'resetting', next: { id: due.id } })
	})
	it('counts as taken for the party in hand, with when it is ready', () => {
		const state = tableState(reset(10), feedOf([left(4)]), NOW_AT)
		expect(
			fitVerdict(
				{ maxCovers: 4, resetBufferMin: 10 },
				state,
				{ partySize: 2, durationMin: 90 },
				NOW_AT,
			),
		).toEqual({ fits: false, why: 'resetting', until: NOW_AT + 6 * MIN })
		expect(
			takesParty(
				{ maxCovers: 4 },
				state,
				{ partySize: 2, durationMin: 90 },
				NOW_AT,
			),
		).toBe(false)
	})
	it('is not the best table for a party, however well it fits', () => {
		const feed = feedOf([left(4)])
		const table = {
			...feed.tables[1]!,
			id: 'tr',
			resetBufferMin: 10,
		}
		const resetting = tableState(table, feed, NOW_AT)
		expect(resetting.kind).toBe('resetting')
		expect(
			bestFit(
				[{ table, state: resetting }],
				{ partySize: 2, durationMin: 90 },
				NOW_AT,
			),
		).toBeNull()
	})
	it('keeps the buffer in the party’s window, as the server does', () => {
		// A booking 100 minutes out: a 90 minute stay fits with no buffer, not with 15.
		const next = rsv({ start: 14 * 60 + 40, status: 'booked', tableIds: ['x'] })
		const open: TableState = { kind: 'soon', next }
		const party = { partySize: 2, durationMin: 90 }
		expect(
			fitVerdict({ maxCovers: 4, resetBufferMin: 0 }, open, party, NOW_AT),
		).toEqual({ fits: true })
		expect(
			fitVerdict({ maxCovers: 4, resetBufferMin: 10 }, open, party, NOW_AT),
		).toEqual({ fits: true })
		expect(
			fitVerdict({ maxCovers: 4, resetBufferMin: 15 }, open, party, NOW_AT),
		).toEqual({ fits: false, why: 'booked', at: next.startAt })
		// Exactly the stay and the buffer is still a fit; a minute less is not.
		const edge: TableState = {
			kind: 'soon',
			next: rsv({ start: 14 * 60 + 45, status: 'booked' }),
		}
		expect(
			fitVerdict({ maxCovers: 4, resetBufferMin: 15 }, edge, party, NOW_AT)
				.fits,
		).toBe(true)
		expect(
			fitVerdict({ maxCovers: 4, resetBufferMin: 16 }, edge, party, NOW_AT)
				.fits,
		).toBe(false)
	})
	it('reads the buffer from the feed, and counts none for an older server', () => {
		const withReset = feedOf([], {
			tables: [
				{
					id: 'tr',
					areaId: 'a1',
					label: 'R',
					minCovers: 1,
					maxCovers: 2,
					resetBufferMin: 12,
				},
				{ id: 'tn', areaId: 'a1', label: 'N', minCovers: 1, maxCovers: 2 },
				{
					id: 'tz',
					areaId: 'a1',
					label: 'Z',
					minCovers: 1,
					maxCovers: 2,
					resetBufferMin: null,
				},
			],
		})
		expect(withReset.tables.map((t) => t.resetBufferMin)).toEqual([12, 0, 0])
	})
})
