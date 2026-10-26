import { describe, expect, it } from 'vitest'
import {
	bestGroup,
	comboFor,
	fitsByRoom,
	gapBetween,
	groupSeats,
	groupVerdict,
	isLargeParty,
	joinVerdict,
	LARGE_PARTY_MIN,
	MAX_COMBINED_TABLES,
	neighbours,
	noFitOf,
	seatSummary,
} from './combine.ts'
import { tableState, type DayTable } from './feed.ts'
import { at, day, MIN, rsv } from './testing.ts'

const NOW = at(18 * 60)

/** A drawn main room: 6 and 7 side by side, 8 beside 7, 9 far across the room; a patio table. */
const tables = [
	{
		id: 't6',
		areaId: 'a1',
		label: '6',
		minCovers: 2,
		maxCovers: 6,
		x: 100,
		y: 300,
		w: 180,
		h: 100,
	},
	{
		id: 't7',
		areaId: 'a1',
		label: '7',
		minCovers: 2,
		maxCovers: 6,
		x: 330,
		y: 300,
		w: 180,
		h: 100,
	},
	{
		id: 't8',
		areaId: 'a1',
		label: '8',
		minCovers: 2,
		maxCovers: 4,
		x: 560,
		y: 300,
		w: 180,
		h: 100,
	},
	{
		id: 't9',
		areaId: 'a1',
		label: '9',
		minCovers: 2,
		maxCovers: 4,
		x: 100,
		y: 700,
		w: 100,
		h: 100,
	},
	{
		id: 'p6',
		areaId: 'a2',
		label: 'P6',
		minCovers: 2,
		maxCovers: 8,
		x: 100,
		y: 100,
		w: 200,
		h: 100,
	},
]
const combos = [
	{
		id: 'c67',
		label: '6 + 7',
		minCovers: 6,
		maxCovers: 12,
		tableIds: ['t6', 't7'],
	},
]
const withFloor = (
	reservations: ReturnType<typeof rsv>[] = [],
	extra: Record<string, unknown> = {},
) => day(reservations, { tables, combos, ...extra })

const party = (partySize: number, over = {}) => ({
	partySize,
	durationMin: 90,
	...over,
})
const of = (feed: ReturnType<typeof withFloor>, ...ids: string[]) =>
	ids.map((id) => feed.tables.find((t) => t.id === id)!) as DayTable[]

describe('a large party', () => {
	it('starts at eight', () => {
		expect(LARGE_PARTY_MIN).toBe(8)
		expect(isLargeParty(7)).toBe(false)
		expect(isLargeParty(8)).toBe(true)
		expect(isLargeParty(12)).toBe(true)
	})
})

describe('what a group of tables seats', () => {
	it('adds up the seats', () => {
		const feed = withFloor()
		expect(groupSeats(of(feed, 't6', 't7'))).toBe(12)
		expect(groupSeats([])).toBe(0)
		expect(seatSummary(of(feed, 't6', 't8'), 9)).toEqual({
			seats: 10,
			short: 0,
			ok: true,
		})
		expect(seatSummary(of(feed, 't8'), 9)).toEqual({
			seats: 4,
			short: 5,
			ok: false,
		})
	})
})

describe('a defined combination', () => {
	it('is found by its tables in any order, and only when they are exactly its tables', () => {
		const feed = withFloor()
		expect(comboFor(feed, ['t7', 't6'])?.id).toBe('c67')
		expect(comboFor(feed, ['t6', 't7'])?.id).toBe('c67')
		expect(comboFor(feed, ['t6', 't8'])).toBeNull()
		expect(comboFor(feed, ['t6', 't7', 't8'])).toBeNull()
		expect(comboFor(feed, ['t6'])).toBeNull()
	})
	it('ignores an archived one', () => {
		const feed = withFloor([], {
			combos: [{ ...combos[0], archivedAt: 1 }],
		})
		expect(comboFor(feed, ['t6', 't7'])).toBeNull()
	})
})

describe('which tables stand together', () => {
	const feed = withFloor()
	const [t6, t7, t8, t9, p6] = of(feed, 't6', 't7', 't8', 't9', 'p6') as [
		DayTable,
		DayTable,
		DayTable,
		DayTable,
		DayTable,
	]
	it('measures the gap on the plan', () => {
		expect(gapBetween(t6, t7)).toBe(50)
		// Touching or overlapping is no gap.
		expect(gapBetween(t6, { ...t6, id: 'x', x: 280 })).toBe(0)
		expect(gapBetween(t6, t9)).toBe(300)
	})
	it('joins tables side by side in the same room', () => {
		expect(neighbours(t6, t7, feed)).toBe(true)
		expect(neighbours(t7, t8, feed)).toBe(true)
		// 6 and 8 are two tables apart: the gap is wider than a table.
		expect(neighbours(t6, t8, feed)).toBe(false)
	})
	it('does not join tables far apart, in another room, or a table to itself', () => {
		expect(neighbours(t6, t9, feed)).toBe(false)
		expect(neighbours(t6, p6, feed)).toBe(false)
		expect(neighbours(t6, t6, feed)).toBe(false)
	})
	it('always joins the two halves of a defined combination, however far apart', () => {
		const far = withFloor([], {
			combos: [
				{
					id: 'cfar',
					label: '6 + 9',
					minCovers: 2,
					maxCovers: 10,
					tableIds: ['t6', 't9'],
				},
			],
		})
		const [a, b] = of(far, 't6', 't9') as [DayTable, DayTable]
		expect(neighbours(a, b, far)).toBe(true)
	})
	it('takes any two tables of a room nobody has drawn (one grid)', () => {
		const undrawn = day([], {
			tables: [
				{ id: 'u1', areaId: 'a1', label: '1', minCovers: 1, maxCovers: 4 },
				{ id: 'u2', areaId: 'a1', label: '2', minCovers: 1, maxCovers: 4 },
			],
		})
		expect(neighbours(undrawn.tables[0]!, undrawn.tables[1]!, undrawn)).toBe(
			true,
		)
	})
})

describe('whether a party can sit at a group of tables', () => {
	it('fits when every table is free and together they seat the party', () => {
		const feed = withFloor()
		expect(groupVerdict(of(feed, 't6', 't7'), feed, party(9), NOW)).toEqual({
			fits: true,
			seats: 12,
		})
		// Tables for 6 and 4 seat ten: a party of nine fits, though neither alone does.
		expect(groupVerdict(of(feed, 't7', 't8'), feed, party(9), NOW)).toEqual({
			fits: true,
			seats: 10,
		})
	})
	it('does not seat a party its tables are too small for, and says how many they seat', () => {
		const feed = withFloor()
		expect(groupVerdict(of(feed, 't8', 't9'), feed, party(9), NOW)).toEqual({
			fits: false,
			why: 'small',
			seats: 8,
		})
	})
	it('says which table is the trouble when one is taken', () => {
		const feed = withFloor([
			rsv({
				start: 17 * 60 + 30,
				status: 'seated',
				seatedAt: at(17 * 60 + 30),
				tableIds: ['t7'],
				tableLabels: ['7'],
			}),
		])
		expect(
			groupVerdict(of(feed, 't6', 't7'), feed, party(9), NOW),
		).toMatchObject({ fits: false, why: 'taken', tableId: 't7' })
	})
	it('uses the free window of every table: the smallest decides', () => {
		// Table 8 is booked at 18:45, inside a 90 minute stay.
		const feed = withFloor([
			rsv({ start: 18 * 60 + 45, tableIds: ['t8'], tableLabels: ['8'] }),
		])
		expect(groupVerdict(of(feed, 't7', 't8'), feed, party(9), NOW)).toEqual({
			fits: false,
			why: 'booked',
			tableId: 't8',
			at: at(18 * 60 + 45),
		})
		// Table 6 is free all night: the group with it is fine.
		expect(groupVerdict(of(feed, 't6', 't7'), feed, party(9), NOW).fits).toBe(
			true,
		)
		// A shorter stay finishes before that booking.
		expect(
			groupVerdict(
				of(feed, 't7', 't8'),
				feed,
				party(9, { durationMin: 40 }),
				NOW,
			).fits,
		).toBe(true)
	})
	it('reports a table taped off inside the stay', () => {
		const feed = withFloor([], {
			blocks: [
				{
					id: 'b1',
					tableId: 't6',
					startAt: at(19 * 60),
					endAt: at(23 * 60),
					reason: 'Private',
				},
			],
		})
		expect(groupVerdict(of(feed, 't6', 't7'), feed, party(9), NOW)).toEqual({
			fits: false,
			why: 'blocked',
			tableId: 't6',
			at: at(19 * 60),
		})
	})
	it('judges a booking being seated by its own window and ignores its own tables', () => {
		const mine = rsv({
			start: 18 * 60 + 25,
			partySize: 9,
			status: 'arrived',
			tableIds: ['t6', 't7'],
			tableLabels: ['6', '7'],
		})
		const feed = withFloor([mine])
		const own = {
			partySize: 9,
			durationMin: mine.durationMin,
			reservationId: mine.id,
			startAt: mine.startAt,
			endAt: mine.endAt,
		}
		expect(groupVerdict(of(feed, 't6', 't7'), feed, own, NOW).fits).toBe(true)
		// Someone else holds table 7 from 19:00: inside this booking's window.
		const clash = withFloor([
			mine,
			rsv({ start: 19 * 60, tableIds: ['t7'], tableLabels: ['7'] }),
		])
		expect(groupVerdict(of(clash, 't6', 't7'), clash, own, NOW)).toMatchObject({
			fits: false,
			why: 'booked',
			tableId: 't7',
		})
	})
})

describe('joining tables on the floor', () => {
	const feed = withFloor([
		rsv({
			start: 17 * 60 + 30,
			status: 'seated',
			seatedAt: at(17 * 60 + 30),
			tableIds: ['t8'],
			tableLabels: ['8'],
		}),
	])
	const verdictOf = (id: string, selected: string[]) => {
		const table = feed.tables.find((t) => t.id === id)!
		return joinVerdict({
			table,
			state: tableState(table, feed, NOW),
			selected: of(feed, ...selected),
			feed,
			party: party(9),
			now: NOW,
		})
	}
	it('offers any free table to start with', () => {
		expect(verdictOf('t6', [])).toEqual({ kind: 'addable' })
		expect(verdictOf('t9', [])).toEqual({ kind: 'addable' })
	})
	it('marks a table already chosen', () => {
		expect(verdictOf('t6', ['t6'])).toEqual({ kind: 'selected' })
	})
	it('offers a free neighbour of the group, and not a far table or another room', () => {
		expect(verdictOf('t7', ['t6'])).toEqual({ kind: 'addable' })
		expect(verdictOf('t9', ['t6'])).toEqual({ kind: 'far' })
		expect(verdictOf('p6', ['t6'])).toEqual({ kind: 'far' })
	})
	it('says why a table cannot join: someone is on it', () => {
		expect(verdictOf('t8', ['t7'])).toMatchObject({
			kind: 'blocked',
			verdict: { why: 'taken' },
		})
	})
	it('stops at the most a till joins', () => {
		const many = day([], {
			tables: Array.from({ length: 6 }, (_, i) => ({
				id: `n${i}`,
				areaId: 'a1',
				label: String(i + 1),
				minCovers: 1,
				maxCovers: 2,
				x: i * 110,
				y: 0,
				w: 100,
				h: 100,
			})),
		})
		const chosen = many.tables.slice(0, MAX_COMBINED_TABLES)
		const next = many.tables[MAX_COMBINED_TABLES]!
		expect(
			joinVerdict({
				table: next,
				state: tableState(next, many, NOW),
				selected: chosen,
				feed: many,
				party: party(9),
				now: NOW,
			}),
		).toEqual({ kind: 'full' })
	})
})

describe('the group to start from for a party nothing seats alone', () => {
	it('is a defined combination that is free and seats them', () => {
		const feed = withFloor()
		const group = bestGroup(feed, party(11), NOW)
		expect(group).toMatchObject({
			tableIds: ['t6', 't7'],
			seats: 12,
			comboId: 'c67',
		})
	})
	it('skips a combination with a table in use, and joins tables that stand together instead', () => {
		const feed = withFloor([
			rsv({
				start: 17 * 60 + 30,
				status: 'seated',
				seatedAt: at(17 * 60 + 30),
				tableIds: ['t6'],
				tableLabels: ['6'],
			}),
		])
		// Free: 7 (6 seats), 8 (4), 9 (4, far away), P6 (8, another room). 7 + 8 seats ten.
		const group = bestGroup(feed, party(9), NOW)
		expect(group).toMatchObject({
			tableIds: ['t7', 't8'],
			seats: 10,
			comboId: null,
		})
	})
	it('picks the fewest tables, then the least left over', () => {
		const feed = withFloor()
		// Nine: the defined 6 + 7 seats twelve; 7 + 8 seats ten with the same two tables.
		// A defined combination is preferred when it is free.
		expect(bestGroup(feed, party(9), NOW)?.comboId).toBe('c67')
		const noCombo = withFloor([], { combos: [] })
		expect(bestGroup(noCombo, party(9), NOW)).toMatchObject({
			tableIds: ['t7', 't8'],
			seats: 10,
		})
	})
	it('finds three tables in a row when the biggest neighbour of one of them leads nowhere', () => {
		// X(5) | S(1) | Y(4) | Z(6) in a row: from S the walk takes X first and needs four
		// tables; from Y it finds Y + Z + S, which seats eleven with three.
		const t = (id: string, x: number, maxCovers: number) => ({
			id,
			areaId: 'a1',
			label: id,
			minCovers: 1,
			maxCovers,
			x,
			y: 0,
			w: 1,
			h: 1,
		})
		const feed = day([], {
			tables: [t('X', 0, 5), t('S', 2, 1), t('Y', 4, 4), t('Z', 6, 6)],
			combos: [],
		})
		expect(bestGroup(feed, party(11), NOW)).toMatchObject({
			tableIds: ['S', 'Y', 'Z'],
			seats: 11,
		})
	})
	it('is null when no free group seats them', () => {
		const feed = withFloor([
			rsv({
				start: 17 * 60,
				status: 'seated',
				seatedAt: at(17 * 60 + 5),
				tableIds: ['t7'],
				tableLabels: ['7'],
			}),
		])
		expect(bestGroup(feed, party(30), NOW)).toBeNull()
	})
	it('keeps a group in one room', () => {
		const feed = withFloor([], { combos: [] })
		const group = bestGroup(feed, party(14), NOW)!
		expect(new Set(group.tables.map((t) => t.areaId)).size).toBe(1)
	})
})

describe('how many tables seat a party, room by room', () => {
	it('counts the tables that take them alone', () => {
		const feed = withFloor()
		expect(fitsByRoom(feed, party(2), NOW)).toEqual(
			new Map([
				['a1', 4],
				['a2', 1],
			]),
		)
		// Seven fits the patio's table for eight, and nothing in the main room.
		expect(fitsByRoom(feed, party(7), NOW)).toEqual(
			new Map([
				['a1', 0],
				['a2', 1],
			]),
		)
	})
	it('counts a table that is taken or booked in the party’s time as not fitting', () => {
		const feed = withFloor([
			rsv({ start: 18 * 60 + 30, tableIds: ['p6'], tableLabels: ['P6'] }),
		])
		expect(fitsByRoom(feed, party(7), NOW).get('a2')).toBe(0)
	})
})

describe('when no single table seats the party', () => {
	it('says so, with the group to join', () => {
		const feed = withFloor()
		const noFit = noFitOf(feed, party(9), NOW)
		expect(noFit.none).toBe(true)
		expect(noFit.tooBig).toBe(true)
		expect(noFit.biggest).toBe(8)
		expect(noFit.group?.tableIds).toEqual(['t6', 't7'])
	})
	it('is not "none" while some table seats them', () => {
		const noFit = noFitOf(withFloor(), party(8), NOW)
		expect(noFit.none).toBe(false)
		expect(noFit.tooBig).toBe(false)
		expect(noFit.group).toBeNull()
	})
	it('is busy, not too big, when the floor is full for a party that would fit a table', () => {
		const full = withFloor(
			['t6', 't7', 't8', 't9', 'p6'].map((id) =>
				rsv({
					start: 17 * 60,
					status: 'seated',
					seatedAt: at(17 * 60 + 5),
					tableIds: [id],
					tableLabels: [id],
				}),
			),
		)
		const noFit = noFitOf(full, party(4), NOW)
		expect(noFit.none).toBe(true)
		expect(noFit.tooBig).toBe(false)
		expect(noFit.group).toBeNull()
	})
	it('has no group when nothing free joins to seat them', () => {
		const noFit = noFitOf(withFloor(), party(40), NOW)
		expect(noFit.none).toBe(true)
		expect(noFit.group).toBeNull()
	})
	it('counts a table booked inside their stay as unavailable to them', () => {
		const feed = withFloor([
			rsv({
				start: 18 * 60 + 20,
				partySize: 6,
				tableIds: ['p6'],
				tableLabels: ['P6'],
			}),
		])
		// The patio's table for eight is booked at 18:20: not free for an hour and a half.
		expect(noFitOf(feed, party(8), NOW).none).toBe(true)
		expect(noFitOf(feed, party(8, { durationMin: 15 }), NOW).none).toBe(false)
		expect(MIN).toBe(60_000)
	})
})
