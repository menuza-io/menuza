// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
	applyFilters,
	filterCounts,
	FILTERS_KEY,
	groupByHour,
	hourPressure,
	LIST_FILTERS,
	matchesFilter,
	nextDue,
	readFilters,
	writeFilters,
	type ListFilter,
} from './listView.ts'
import { at, day, MIN, rsv, SERVICES } from './testing.ts'

const NOW = at(14 * 60 + 32)
const vip = { tags: [{ id: 't', name: 'VIP' }], id: 'g', name: 'V I Pee' }

describe('what each filter chip means', () => {
	const booking = (over: Record<string, unknown> = {}) =>
		rsv({ start: 14 * 60 + 45, ...over })
	it('To seat is a party at the stand', () => {
		expect(matchesFilter(booking({ status: 'arrived' }), 'toSeat', NOW)).toBe(
			true,
		)
		expect(matchesFilter(booking({ status: 'booked' }), 'toSeat', NOW)).toBe(
			false,
		)
	})
	it('Late is a party past its time, or one that called to say it is running late, and not one at the stand', () => {
		expect(
			matchesFilter(
				booking({ localStartMin: 800, startAt: NOW - 20 * MIN }),
				'late',
				NOW,
			),
		).toBe(true)
		expect(
			matchesFilter(
				booking({ startAt: NOW + 10 * MIN, runningLateMin: 15 }),
				'late',
				NOW,
			),
		).toBe(true)
		expect(matchesFilter(booking(), 'late', NOW)).toBe(false)
		expect(
			matchesFilter(
				booking({ status: 'arrived', startAt: NOW - 20 * MIN }),
				'late',
				NOW,
			),
		).toBe(false)
	})
	it('VIP, Large, Online and No table read the booking', () => {
		expect(matchesFilter(booking({ guest: vip }), 'vip', NOW)).toBe(true)
		expect(matchesFilter(booking(), 'vip', NOW)).toBe(false)
		expect(matchesFilter(booking({ partySize: 8 }), 'large', NOW)).toBe(true)
		expect(matchesFilter(booking({ partySize: 7 }), 'large', NOW)).toBe(false)
		for (const channel of ['online', 'native', 'voice_agent'])
			expect(matchesFilter(booking({ channel }), 'online', NOW)).toBe(true)
		expect(matchesFilter(booking({ channel: 'phone' }), 'online', NOW)).toBe(
			false,
		)
		expect(matchesFilter(booking({ tableIds: [] }), 'noTable', NOW)).toBe(true)
		expect(matchesFilter(booking({ tableIds: ['t1'] }), 'noTable', NOW)).toBe(
			false,
		)
	})
})

describe('the chips’ counts and the rows they leave', () => {
	const rows = [
		rsv({ start: 14 * 60 + 30, status: 'arrived', tableIds: ['t1'] }),
		rsv({ start: 14 * 60 + 45, guest: vip, partySize: 9 }),
		rsv({ start: 15 * 60, channel: 'online', tableIds: ['t2'] }),
		rsv({ start: 15 * 60, runningLateMin: 20, tableIds: ['t2'] }),
	]
	it('counts each chip against the whole list', () => {
		expect(filterCounts(rows, NOW)).toEqual({
			toSeat: 1,
			late: 1,
			vip: 1,
			large: 1,
			online: 1,
			noTable: 1,
		})
	})
	it('shows everything when no chip is chosen', () => {
		expect(applyFilters(rows, new Set(), NOW)).toEqual(rows)
	})
	it('widens with each chip chosen: a booking that is any of them shows', () => {
		const some = (...chosen: ListFilter[]) =>
			applyFilters(rows, new Set(chosen), NOW).map((r) => r.id)
		expect(some('vip')).toEqual([rows[1]!.id])
		expect(some('vip', 'online')).toEqual([rows[1]!.id, rows[2]!.id])
		expect(some('noTable')).toEqual([rows[1]!.id])
		expect(some('late', 'toSeat')).toEqual([rows[0]!.id, rows[3]!.id])
	})
	it('has a chip for every kind, in order', () => {
		expect([...LIST_FILTERS]).toEqual([
			'toSeat',
			'late',
			'vip',
			'large',
			'online',
			'noTable',
		])
	})
})

describe('the chips kept per device', () => {
	afterEach(() => localStorage.clear())
	it('are remembered and read back', () => {
		writeFilters(new Set<ListFilter>(['vip', 'late']))
		// Stored in the chips' own order, whatever order they were chosen in.
		expect(localStorage.getItem(FILTERS_KEY)).toBe('["late","vip"]')
		expect([...readFilters()]).toEqual(['late', 'vip'])
	})
	it('start with none, and ignore what is not a chip', () => {
		expect(readFilters().size).toBe(0)
		localStorage.setItem(FILTERS_KEY, '["vip","nonsense",3]')
		expect([...readFilters()]).toEqual(['vip'])
		localStorage.setItem(FILTERS_KEY, 'not json')
		expect(readFilters().size).toBe(0)
	})
	it('survive storage that throws', () => {
		const original = Storage.prototype.setItem
		Storage.prototype.setItem = () => {
			throw new Error('quota')
		}
		try {
			expect(() => writeFilters(new Set<ListFilter>(['vip']))).not.toThrow()
		} finally {
			Storage.prototype.setItem = original
		}
	})
})

describe('the rows under hour headers', () => {
	const rows = [
		rsv({ start: 14 * 60, partySize: 2 }),
		rsv({ start: 14 * 60 + 30, partySize: 4 }),
		rsv({ start: 15 * 60 + 5, partySize: 6 }),
		rsv({ start: 25 * 60 + 15, partySize: 3 }),
	]
	it('groups by the hour a booking starts, with its parties and covers', () => {
		const groups = groupByHour(rows)
		expect(
			groups.map((g) => [g.hour, g.startMin, g.parties, g.covers]),
		).toEqual([
			[14, 840, 2, 6],
			[15, 900, 1, 6],
			// A late slot after midnight keeps counting up from the day's start.
			[25, 1500, 1, 3],
		])
		expect(groups[0]!.rows).toEqual([rows[0], rows[1]])
	})
	it('starts a group each time the hour changes, however the rows are ordered', () => {
		expect(groupByHour([rows[2]!, rows[0]!]).map((g) => g.hour)).toEqual([
			15, 14,
		])
	})
	it('is nothing for no rows', () => {
		expect(groupByHour([])).toEqual([])
	})
	it('carries the pace of an hour that is filling up', () => {
		const pressure = new Map([
			[14, { level: 'high' as const, covers: 20, cap: 24 }],
		])
		const groups = groupByHour(rows, pressure)
		expect(groups[0]!.pressure).toEqual({ level: 'high', covers: 20, cap: 24 })
		expect(groups[1]!.pressure).toBeNull()
	})
})

describe('which hours are near their cap', () => {
	const pace = (localMin: number, bookedCovers: number, maxCovers: number) => ({
		localMin,
		serviceId: 'dinner',
		bookedCovers,
		partyCount: 1,
		maxCovers,
	})
	const feed = (pacing: ReturnType<typeof pace>[]) =>
		day([rsv({ start: 18 * 60 })], {
			services: SERVICES,
			pacing,
			tables: [
				{ id: 't1', areaId: 'a1', label: '1', minCovers: 1, maxCovers: 40 },
			],
		})
	it('marks the busiest slot of an hour from four fifths of its cap', () => {
		const pressure = hourPressure(
			feed([
				pace(18 * 60, 10, 20),
				pace(18 * 60 + 15, 16, 20),
				pace(19 * 60, 20, 20),
				pace(19 * 60 + 15, 5, 20),
			]),
		)
		expect(pressure.get(18)).toEqual({ level: 'high', covers: 16, cap: 20 })
		expect(pressure.get(19)).toEqual({ level: 'full', covers: 20, cap: 20 })
		expect(pressure.has(20)).toBe(false)
	})
	it('says nothing for an hour with room, or with no cap configured', () => {
		expect(hourPressure(feed([pace(18 * 60, 9, 20)])).size).toBe(0)
		// A cap the server sets as its own default (at or above the seats) is not a pace.
		expect(hourPressure(feed([pace(18 * 60, 45, 50)])).size).toBe(0)
	})
	it('says nothing when the feed has no pacing', () => {
		expect(hourPressure(feed([])).size).toBe(0)
	})
})

describe('the party the Now button goes to', () => {
	it('is the first booking not yet due, skipping parties at the stand', () => {
		const rows = [
			rsv({ start: 14 * 60, status: 'arrived' }),
			rsv({ start: 14 * 60 + 20 }),
			rsv({ start: 14 * 60 + 45 }),
			rsv({ start: 15 * 60 }),
		]
		expect(nextDue(rows, NOW)?.id).toBe(rows[2]!.id)
	})
	it('is nobody when everyone is late or here, or the list is empty', () => {
		expect(nextDue([], NOW)).toBeNull()
		expect(nextDue([rsv({ start: 14 * 60 })], NOW)).toBeNull()
	})
})
