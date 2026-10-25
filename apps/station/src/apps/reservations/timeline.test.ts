import { describe, expect, it } from 'vitest'
import { at, day, rsv, SERVICES } from './testing.ts'
import {
	layoutTimeline,
	minuteAt,
	minutesFormatter,
	nowOffset,
	packLanes,
	slotTotals,
	timelineRange,
} from './timeline.ts'

const rows = (groups: ReturnType<typeof layoutTimeline>) =>
	groups.flatMap((g) => g.rows)

describe('the range of the grid', () => {
	it('is the services’ hours, whole hours', () => {
		const feed = day([], { services: SERVICES })
		expect(timelineRange(feed)).toEqual({ startMin: 11 * 60, endMin: 23 * 60 })
		expect(timelineRange(feed, 'dinner')).toEqual({
			startMin: 17 * 60,
			endMin: 23 * 60,
		})
	})
	it('widens for a booking outside them', () => {
		const feed = day([rsv({ start: 9 * 60 + 30, partySize: 2 })], {
			services: SERVICES,
		})
		expect(timelineRange(feed).startMin).toBe(9 * 60)
		// A late stay past closing.
		const late = day([rsv({ start: 22 * 60, durationMin: 150 })], {
			services: SERVICES,
		})
		expect(timelineRange(late).endMin).toBe(25 * 60)
	})
	it('with no services is the bookings with an hour to spare', () => {
		const feed = day([
			rsv({ start: 12 * 60 + 15 }),
			rsv({ start: 19 * 60, durationMin: 60 }),
		])
		expect(timelineRange(feed)).toEqual({ startMin: 11 * 60, endMin: 21 * 60 })
	})
	it('with nothing at all is a working day, and never under three hours', () => {
		expect(timelineRange(day([]))).toEqual({
			startMin: 11 * 60,
			endMin: 23 * 60,
		})
		const short = day([rsv({ start: 12 * 60, durationMin: 15 })])
		const range = timelineRange(short)
		expect(range.endMin - range.startMin).toBeGreaterThanOrEqual(180)
	})
})

describe('the bars', () => {
	const range = { startMin: 11 * 60, endMin: 23 * 60 }
	it('start where the booking starts and run as long as it lasts', () => {
		const feed = day([
			rsv({
				start: 12 * 60 + 30,
				durationMin: 90,
				tableIds: ['t2'],
				partySize: 4,
			}),
		])
		const [bar] = rows(layoutTimeline(feed, range)).find(
			(r) => r.key === 't2',
		)!.bars
		expect(bar).toMatchObject({
			startMin: 12 * 60 + 30,
			endMin: 14 * 60,
			lane: 0,
			clippedStart: false,
			clippedEnd: false,
			overrun: false,
		})
	})
	it('are grouped by room, tables in label order', () => {
		const groups = layoutTimeline(day([]), range)
		expect(groups.map((g) => g.area?.name)).toEqual(['Main', 'Patio'])
		expect(groups[0]!.rows.map((r) => r.table?.label)).toEqual(['1', '2', '10'])
		expect(groups[1]!.rows.map((r) => r.table?.label)).toEqual(['P1'])
	})
	it('stack on a table when they overlap (an overbook), else share a line', () => {
		const feed = day([
			rsv({ start: 12 * 60, tableIds: ['t1'] }),
			rsv({ start: 12 * 60 + 60, tableIds: ['t1'] }),
			rsv({ start: 13 * 60 + 30, tableIds: ['t1'] }),
		])
		const row = rows(layoutTimeline(feed, range)).find((r) => r.key === 't1')!
		expect(row.bars.map((b) => b.lane)).toEqual([0, 1, 0])
		expect(row.lanes).toBe(2)
	})
	it('put a party seated on two tables on each', () => {
		const feed = day([
			rsv({ start: 12 * 60, tableIds: ['t1', 't2'], partySize: 6 }),
		])
		const all = rows(layoutTimeline(feed, range))
		expect(all.find((r) => r.key === 't1')!.bars).toHaveLength(1)
		expect(all.find((r) => r.key === 't2')!.bars).toHaveLength(1)
	})
	it('put bookings with no table in a top row of their own', () => {
		const feed = day([
			rsv({ start: 12 * 60, tableIds: [] }),
			rsv({ start: 12 * 60, tableIds: ['t1'] }),
		])
		const groups = layoutTimeline(feed, range)
		expect(groups[0]).toMatchObject({ key: 'none', area: null })
		expect(groups[0]!.rows[0]!.table).toBeNull()
		expect(groups[0]!.rows[0]!.bars).toHaveLength(1)
		// No such row when everyone has a table.
		expect(
			layoutTimeline(day([rsv({ start: 600, tableIds: ['t1'] })]), range)[0]!
				.key,
		).not.toBe('none')
	})
	it('leave out cancelled bookings and no-shows, keep the ones that left', () => {
		const feed = day([
			rsv({ start: 12 * 60, tableIds: ['t1'], status: 'cancelled' }),
			rsv({ start: 12 * 60, tableIds: ['t2'], status: 'no_show' }),
			rsv({ start: 12 * 60, tableIds: ['t10'], status: 'finished' }),
		])
		const all = rows(layoutTimeline(feed, range))
		expect(all.find((r) => r.key === 't1')!.bars).toHaveLength(0)
		expect(all.find((r) => r.key === 't2')!.bars).toHaveLength(0)
		expect(all.find((r) => r.key === 't10')!.bars).toHaveLength(1)
	})
	it('are clipped to the range and say so; ones wholly outside are dropped', () => {
		const feed = day([
			rsv({ start: 10 * 60 + 30, durationMin: 90, tableIds: ['t1'] }),
			rsv({ start: 22 * 60 + 30, durationMin: 90, tableIds: ['t2'] }),
			rsv({ start: 8 * 60, durationMin: 60, tableIds: ['t10'] }),
		])
		const all = rows(layoutTimeline(feed, range))
		expect(all.find((r) => r.key === 't1')!.bars[0]).toMatchObject({
			startMin: 11 * 60,
			endMin: 12 * 60,
			clippedStart: true,
		})
		expect(all.find((r) => r.key === 't2')!.bars[0]).toMatchObject({
			endMin: 23 * 60,
			clippedEnd: true,
		})
		expect(all.find((r) => r.key === 't10')!.bars).toHaveLength(0)
	})
	it('run to now for a party still seated past its time', () => {
		const feed = day([
			rsv({
				start: 12 * 60,
				durationMin: 60,
				tableIds: ['t1'],
				status: 'seated',
				seatedAt: at(12 * 60),
			}),
		])
		const now = at(13 * 60 + 20)
		const [bar] = rows(layoutTimeline(feed, range, { now })).find(
			(r) => r.key === 't1',
		)!.bars
		expect(bar).toMatchObject({ endMin: 13 * 60 + 20, overrun: true })
		const [onTime] = rows(
			layoutTimeline(feed, range, { now: at(12 * 60 + 30) }),
		).find((r) => r.key === 't1')!.bars
		expect(onTime).toMatchObject({ endMin: 13 * 60, overrun: false })
	})
	it('draw blocks on a table, or on every table of a room', () => {
		const feed = day([], {
			blocks: [
				{
					id: 'b1',
					tableId: 't1',
					startAt: at(12 * 60),
					endAt: at(13 * 60),
					reason: 'Wobbly',
				},
				{ id: 'b2', areaId: 'a2', startAt: at(18 * 60), endAt: at(19 * 60) },
			],
		})
		const all = rows(layoutTimeline(feed, range))
		expect(all.find((r) => r.key === 't1')!.blocks).toEqual([
			{ id: 'b1', startMin: 12 * 60, endMin: 13 * 60, reason: 'Wobbly' },
		])
		expect(all.find((r) => r.key === 'p1')!.blocks[0]).toMatchObject({
			id: 'b2',
		})
		expect(all.find((r) => r.key === 't2')!.blocks).toEqual([])
	})
	it('narrow to a service', () => {
		const feed = day(
			[
				rsv({ start: 12 * 60, tableIds: ['t1'] }),
				rsv({ start: 18 * 60, tableIds: ['t1'] }),
			],
			{ services: SERVICES },
		)
		const row = rows(
			layoutTimeline(feed, timelineRange(feed, 'dinner'), {
				serviceId: 'dinner',
			}),
		).find((r) => r.key === 't1')!
		expect(row.bars.map((b) => b.startMin)).toEqual([18 * 60])
	})
})

describe('packLanes', () => {
	it('puts back-to-back items on one line', () => {
		const packed = packLanes([
			{ startMin: 0, endMin: 60 },
			{ startMin: 60, endMin: 120 },
			{ startMin: 30, endMin: 90 },
		])
		expect(packed.map((p) => [p.startMin, p.lane])).toEqual([
			[0, 0],
			[30, 1],
			[60, 0],
		])
	})
})

describe('what the bottom row counts', () => {
	const range = { startMin: 17 * 60, endMin: 19 * 60 }
	it('is per slot against capacity when the feed has pacing', () => {
		const feed = day(
			[
				rsv({ start: 17 * 60, partySize: 4 }),
				rsv({ start: 17 * 60 + 15, partySize: 2 }),
			],
			{
				services: SERVICES,
				pacing: [
					{
						localMin: 17 * 60,
						serviceId: 'dinner',
						bookedCovers: 4,
						partyCount: 1,
						maxCovers: 18,
					},
					{
						localMin: 17 * 60 + 15,
						serviceId: 'dinner',
						bookedCovers: 2,
						partyCount: 1,
						maxCovers: 18,
					},
				],
			},
		)
		const totals = slotTotals(feed, range)
		expect(totals.kind).toBe('slots')
		expect(totals.cells).toHaveLength(8)
		expect(totals.cells[0]).toMatchObject({
			covers: 4,
			parties: 1,
			cap: 18,
			spanMin: 15,
		})
		expect(totals.cells[1]).toMatchObject({ covers: 2, cap: 18 })
		// A slot pacing says nothing of still counts what starts in it.
		expect(totals.cells[2]).toMatchObject({ covers: 0, cap: null })
		expect(totals).toMatchObject({ parties: 2, covers: 6 })
	})
	it('is per hour with no pacing, counting what starts in the hour', () => {
		const feed = day([
			rsv({ start: 17 * 60 + 20, partySize: 3 }),
			rsv({ start: 17 * 60 + 50, partySize: 2 }),
			rsv({ start: 18 * 60, partySize: 5 }),
			rsv({ start: 18 * 60, partySize: 9, status: 'cancelled' }),
		])
		const totals = slotTotals(feed, range)
		expect(totals.kind).toBe('hours')
		expect(totals.cells.map((c) => [c.covers, c.parties, c.spanMin])).toEqual([
			[5, 2, 60],
			[5, 1, 60],
		])
	})
})

describe('the clock and the pointer', () => {
	it('places now in the range, or says it is outside', () => {
		const feed = day([])
		const range = { startMin: 11 * 60, endMin: 23 * 60 }
		expect(nowOffset(at(12 * 60 + 30), feed, range)).toBe(90)
		expect(nowOffset(at(10 * 60), feed, range)).toBeNull()
		expect(nowOffset(at(23 * 60 + 5), feed, range)).toBeNull()
	})
	it('finds the slot under a tap and never past the last one', () => {
		const range = { startMin: 11 * 60, endMin: 12 * 60 }
		expect(minuteAt(0, 48, range)).toBe(11 * 60)
		expect(minuteAt(100, 48, range)).toBe(11 * 60 + 30)
		expect(minuteAt(-20, 48, range)).toBe(11 * 60)
		expect(minuteAt(9999, 48, range)).toBe(11 * 60 + 45)
	})
	it('formats minutes after midnight as a clock time', () => {
		expect(minutesFormatter('en')(19 * 60 + 30).replace(/\s/g, ' ')).toBe(
			'7:30 PM',
		)
		expect(minutesFormatter('en')(25 * 60)).toBe(minutesFormatter('en')(60))
	})
})
