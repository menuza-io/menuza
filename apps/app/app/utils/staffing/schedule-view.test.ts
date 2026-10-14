import { describe, expect, it } from 'vitest'
import {
	DATES,
	HOUR,
	NINE_AM,
	demand,
	person,
	shift,
	week,
} from './schedule-fixtures.ts'
import {
	buildGrid,
	cellNotes,
	cellDropId,
	clipFromShift,
	conflictedShifts,
	footerFor,
	formatClock,
	formatDuration,
	formatHourOfDay,
	formatShiftRange,
	hhmmWrapped,
	isOvernight,
	monthWeekStarts,
	movePatch,
	moveTimes,
	positionName,
	neighborCell,
	parseCellDropId,
	parseScheduleSearch,
	parseShiftDragId,
	pasteBody,
	rankBackfill,
	resizeTimes,
	shiftDragId,
	shiftMonth,
	shiftTimes,
	summarizePublish,
	estimateRecipients,
	snapMinutes,
	summarizeDemand,
	timeSteps,
	unpublishedShifts,
	wallLengthMinutes,
	writeScheduleSearch,
	OPEN_ROW,
} from './schedule-view.ts'

const TODAY = '2026-03-04'

describe('address bar', () => {
	it('falls back to defaults on junk', () => {
		const search = parseScheduleSearch(
			new URLSearchParams('view=bogus&date=2026-13-45&group=x'),
			TODAY,
			'loc-1',
		)
		expect(search).toEqual({
			view: 'week',
			date: TODAY,
			scopeId: 'loc-1',
			group: 'position',
			conflicts: true,
		})
	})

	it('writes only what differs from the defaults', () => {
		const out = writeScheduleSearch(
			new URLSearchParams(),
			{ view: 'day', date: '2026-03-09', conflicts: false },
			TODAY,
			'loc-1',
		)
		expect(out.toString()).toBe('view=day&date=2026-03-09&conflicts=off')
		const back = writeScheduleSearch(
			out,
			{ view: 'week', conflicts: true, date: TODAY },
			TODAY,
			'loc-1',
		)
		expect(back.toString()).toBe('')
	})

	it('keeps a chosen workplace other than the default', () => {
		const out = writeScheduleSearch(
			new URLSearchParams(),
			{ scopeId: 'loc-2' },
			TODAY,
			'loc-1',
		)
		expect(out.get('scope')).toBe('loc-2')
	})
})

describe('times', () => {
	it('lists 96 quarter-hour steps', () => {
		const steps = timeSteps()
		expect(steps).toHaveLength(96)
		expect(steps[0]).toBe('00:00')
		expect(steps[95]).toBe('23:45')
	})

	it('snaps to 15 minutes', () => {
		expect(snapMinutes(7)).toBe(0)
		expect(snapMinutes(8)).toBe(15)
		expect(snapMinutes(-22)).toBe(-15)
	})

	it('wraps past midnight', () => {
		expect(hhmmWrapped(1440)).toBe('00:00')
		expect(hhmmWrapped(1500)).toBe('01:00')
		expect(hhmmWrapped(-60)).toBe('23:00')
	})

	it('reads the local times and detects overnight shifts', () => {
		const day = shift()
		expect(shiftTimes(day)).toEqual({ startTime: '09:00', endTime: '17:00' })
		expect(isOvernight(day)).toBe(false)
		const night = shift({
			startsAt: NINE_AM + 12 * HOUR,
			endsAt: NINE_AM + 18 * HOUR,
		})
		expect(shiftTimes(night)).toEqual({ startTime: '21:00', endTime: '03:00' })
		expect(isOvernight(night)).toBe(true)
	})

	it('formats clocks in the workplace zone', () => {
		expect(formatClock(NINE_AM, 'America/Chicago', 'en')).toMatch(/^9\s?AM$/)
		expect(formatClock(NINE_AM + 30 * 60_000, 'America/Chicago', 'en')).toMatch(
			/^9:30\s?AM$/,
		)
		expect(formatShiftRange(shift(), 'en')).toMatch(/9\s?AM . 5\s?PM/)
	})

	it('formats an hour of the day', () => {
		expect(formatHourOfDay(18, 'en')).toMatch(/^6\s?PM$/)
		expect(formatHourOfDay(0, 'en')).toMatch(/^12\s?AM$/)
	})

	it('formats durations', () => {
		expect(formatDuration(450)).toBe('7h 30m')
		expect(formatDuration(480)).toBe('8h')
		expect(formatDuration(45)).toBe('45m')
		expect(formatDuration(-5)).toBe('0m')
	})
})

describe('buildGrid', () => {
	const view = week({
		people: [
			person({
				id: 'a',
				firstName: 'Zed',
				lastName: 'Cook',
				positionIds: ['p2'],
			}),
			person({
				id: 'b',
				firstName: 'Amy',
				lastName: 'Server',
				positionIds: ['p1'],
			}),
			person({
				id: 'c',
				firstName: 'Bo',
				lastName: 'Both',
				positionIds: ['p2', 'p1'],
			}),
			person({
				id: 'h',
				firstName: 'Hidden',
				lastName: 'One',
				showInSchedule: false,
			}),
			person({
				id: 'x',
				firstName: 'Gone',
				lastName: 'Away',
				status: 'terminated',
			}),
			person({
				id: 'n',
				firstName: 'No',
				lastName: 'Position',
				positionIds: [],
			}),
		],
		shifts: [
			shift({ id: '1', staffId: 'b', localDate: '2026-03-03' }),
			shift({
				id: '2',
				staffId: 'b',
				localDate: '2026-03-03',
				startsAt: NINE_AM - 2 * HOUR,
			}),
			shift({ id: '3', staffId: null }),
			shift({ id: '4', staffId: 'h' }),
		],
	})

	it('groups by position in the server order with the unplaced last', () => {
		const grid = buildGrid(view, { group: 'position', locale: 'en' })
		expect(grid.groups.map((group) => group.key)).toEqual(['p1', 'p2', 'none'])
		// Bo holds both and lands under the first position in the order (Server).
		expect(grid.groups[0]!.rows.map((row) => row.key)).toEqual(['b', 'c', 'h'])
		expect(grid.groups[1]!.rows.map((row) => row.key)).toEqual(['a'])
	})

	it('shows hidden people only while they hold a shift', () => {
		const grid = buildGrid(view, { group: 'none', locale: 'en' })
		const keys = grid.groups[0]!.rows.map((row) => row.key)
		expect(keys).toContain('h')
		expect(keys).not.toContain('x')
		expect(grid.hiddenCount).toBe(1)
	})

	it('puts open shifts in their own row and sorts a cell by start', () => {
		const grid = buildGrid(view, { group: 'position', locale: 'en' })
		expect(grid.open.cells.get('2026-03-02')?.map((s) => s.id)).toEqual(['3'])
		const amy = grid.groups[0]!.rows[0]!
		expect(amy.cells.get('2026-03-03')?.map((s) => s.id)).toEqual(['2', '1'])
	})

	it('sorts names by the viewer locale and prefers Arabic names', () => {
		const arabic = week({
			people: [
				person({
					id: 'a',
					firstName: 'Zed',
					lastName: 'Z',
					firstNameAr: 'أحمد',
					lastNameAr: 'ب',
				}),
				person({ id: 'b', firstName: 'Amy', lastName: 'A' }),
			],
		})
		const grid = buildGrid(arabic, { group: 'none', locale: 'ar' })
		expect(grid.groups[0]!.rows).toHaveLength(2)
	})
})

describe('week summaries', () => {
	it('finds conflicted and unpublished shifts', () => {
		const view = week({
			shifts: [
				shift({ id: '1', state: 'published' }),
				shift({ id: '2', conflicts: [{ code: 'overlap', shiftId: '2' }] }),
			],
		})
		expect(conflictedShifts(view).map((s) => s.id)).toEqual(['2'])
		expect(unpublishedShifts(view).map((s) => s.id)).toEqual(['2'])
	})

	it('has a zero footer for a date the server skipped', () => {
		expect(footerFor(week({ footers: [] }), '2026-03-02').headcount).toBe(0)
	})
})

describe('summarizePublish', () => {
	it('counts what is about to go out, by kind', () => {
		const view = week({
			shifts: [
				shift({ id: '1', state: 'draft' }),
				shift({
					id: '2',
					state: 'draft',
					conflicts: [{ code: 'overlap', shiftId: '2' }],
				}),
				shift({ id: '3', state: 'changed' }),
				shift({ id: '4', state: 'cancel_pending' }),
				shift({
					id: '5',
					state: 'published',
					conflicts: [{ code: 'overtime', shiftId: '5' }],
				}),
			],
		})
		expect(summarizePublish(view)).toEqual({
			created: 2,
			changed: 1,
			removed: 1,
			warned: 1,
			total: 4,
			// A removal is not live after publishing.
			liveShifts: 4,
			openShifts: 0,
			minutes: 0,
			conflicted: 2,
		})
		expect(summarizePublish(week()).total).toBe(0)
	})

	it('carries the week hours, the open shifts and (with the grant) the estimated cost', () => {
		const view = week({
			shifts: [
				shift({ id: '1', state: 'draft', staffId: null }),
				shift({ id: '2', state: 'published' }),
			],
			totals: {
				minutes: 900,
				overtimeMinutes: 0,
				openShifts: 1,
				openMinutes: 450,
				costMinorByCurrency: { USD: 22500 },
			},
		})
		expect(summarizePublish(view)).toMatchObject({
			liveShifts: 2,
			openShifts: 1,
			minutes: 900,
			costMinorByCurrency: { USD: 22500 },
		})
		expect('costMinorByCurrency' in summarizePublish(week())).toBe(false)
	})
})

describe('estimateRecipients', () => {
	const view = week({
		shifts: [
			shift({ id: '1', state: 'draft', staffId: 'a' }),
			shift({
				id: '2',
				state: 'changed',
				staffId: 'b',
				published: {
					staffId: 'c',
					positionId: null,
					startsAt: 0,
					endsAt: 1,
					unpaidBreakMinutes: 0,
					notes: null,
				},
			}),
			shift({ id: '3', state: 'cancel_pending', staffId: 'd' }),
			shift({ id: '4', state: 'published', staffId: 'e' }),
			shift({ id: '5', state: 'draft', staffId: null }),
		],
	})

	it('counts whoever has something new, edited or removed, and who lost a shift', () => {
		expect(estimateRecipients(view, 'changed').people).toBe(4)
	})
	it('adds everyone else working the week in everyone mode', () => {
		expect(estimateRecipients(view, 'everyone').people).toBe(5)
	})
	it('tells nobody in nobody mode', () => {
		expect(estimateRecipients(view, 'nobody').people).toBe(0)
	})
})

describe('cellNotes', () => {
	const overlay = {
		staffId: 's1',
		timeOff: [
			{
				id: 't1',
				status: 'pending' as const,
				category: 'pto',
				startDate: '2026-03-03',
				endDate: '2026-03-04',
				allDay: true,
				startMinute: null,
				endMinute: null,
			},
			{
				id: 't2',
				status: 'approved' as const,
				category: 'pto',
				startDate: '2026-03-04',
				endDate: '2026-03-04',
				allDay: true,
				startMinute: null,
				endMinute: null,
			},
		],
		availability: [
			{
				id: 'a1',
				kind: 'weekly' as const,
				weekday: 1,
				date: null,
				availability: 'unavailable' as const,
				allDay: true,
				startMinute: null,
				endMinute: null,
				effectiveFrom: null,
				effectiveTo: null,
			},
			{
				id: 'a2',
				kind: 'one_off' as const,
				weekday: null,
				date: '2026-03-06',
				availability: 'unavailable' as const,
				allDay: false,
				startMinute: 600,
				endMinute: 700,
				effectiveFrom: null,
				effectiveTo: null,
			},
		],
	}

	it('prefers approved over pending time off', () => {
		expect(cellNotes(overlay, '2026-03-03').timeOff).toBe('pending')
		expect(cellNotes(overlay, '2026-03-04').timeOff).toBe('approved')
		expect(cellNotes(overlay, '2026-03-05').timeOff).toBeNull()
	})

	it('flags whole-day unavailability on its weekday only', () => {
		expect(cellNotes(overlay, '2026-03-02').unavailable).toBe(true) // a Monday
		expect(cellNotes(overlay, '2026-03-03').unavailable).toBe(false)
		// A part-day window is not a whole-day flag.
		expect(cellNotes(overlay, '2026-03-06').unavailable).toBe(false)
		expect(cellNotes(undefined, '2026-03-02')).toEqual({
			timeOff: null,
			unavailable: false,
		})
	})
})

describe('drag and drop', () => {
	it('round-trips ids and refuses junk', () => {
		expect(parseShiftDragId(shiftDragId('abc'))).toBe('abc')
		expect(parseShiftDragId('cell:x:y')).toBeNull()
		expect(parseCellDropId(cellDropId('s1', '2026-03-03'))).toEqual({
			rowKey: 's1',
			date: '2026-03-03',
		})
		expect(parseCellDropId('cell:s1:not-a-date')).toBeNull()
		expect(parseCellDropId(undefined)).toBeNull()
	})

	it('moves to another day, another person, or open', () => {
		const s = shift({ version: 3 })
		expect(movePatch(s, { rowKey: 's1', date: '2026-03-02' })).toBeNull()
		expect(movePatch(s, { rowKey: 's1', date: '2026-03-04' })).toEqual({
			expectedVersion: 3,
			date: '2026-03-04',
		})
		expect(movePatch(s, { rowKey: 's2', date: '2026-03-02' })).toEqual({
			expectedVersion: 3,
			staffId: 's2',
		})
		expect(movePatch(s, { rowKey: OPEN_ROW, date: '2026-03-05' })).toEqual({
			expectedVersion: 3,
			date: '2026-03-05',
			staffId: null,
		})
		expect(
			movePatch(shift({ staffId: null }), {
				rowKey: OPEN_ROW,
				date: '2026-03-02',
			}),
		).toBeNull()
	})

	it('steps between cells with the arrow keys, mirroring in right-to-left', () => {
		const context = { dates: DATES, rowKeys: ['open', 'a', 'b'], rtl: false }
		const from = { rowKey: 'a', date: '2026-03-03' }
		expect(neighborCell(from, 'right', context)).toEqual({
			rowKey: 'a',
			date: '2026-03-04',
		})
		expect(neighborCell(from, 'left', context)).toEqual({
			rowKey: 'a',
			date: '2026-03-02',
		})
		expect(neighborCell(from, 'down', context)).toEqual({
			rowKey: 'b',
			date: '2026-03-03',
		})
		expect(neighborCell(from, 'up', context)).toEqual({
			rowKey: 'open',
			date: '2026-03-03',
		})
		expect(
			neighborCell({ rowKey: 'open', date: '2026-03-02' }, 'up', context),
		).toBeNull()
		expect(
			neighborCell({ rowKey: 'a', date: '2026-03-02' }, 'left', context),
		).toBeNull()
		expect(neighborCell(from, 'right', { ...context, rtl: true })).toEqual({
			rowKey: 'a',
			date: '2026-03-02',
		})
		expect(
			neighborCell({ rowKey: 'zz', date: '2026-03-02' }, 'right', context),
		).toBeNull()
	})
})

describe('resize', () => {
	const s = shift() // 09:00 to 17:00

	it('moves the end in 15-minute steps', () => {
		expect(resizeTimes(s, 'end', 60)).toEqual({
			startTime: '09:00',
			endTime: '18:00',
		})
		expect(resizeTimes(s, 'end', -22)).toEqual({
			startTime: '09:00',
			endTime: '16:45',
		})
		expect(resizeTimes(s, 'end', 5)).toBeNull()
	})

	it('moves the start and shortens the shift', () => {
		expect(resizeTimes(s, 'start', 30)).toEqual({
			startTime: '09:30',
			endTime: '17:00',
		})
		expect(resizeTimes(s, 'start', -60)).toEqual({
			startTime: '08:00',
			endTime: '17:00',
		})
	})

	it('never goes below one step', () => {
		expect(resizeTimes(s, 'end', -10_000)).toEqual({
			startTime: '09:00',
			endTime: '09:15',
		})
		expect(resizeTimes(s, 'start', 10_000)).toEqual({
			startTime: '16:45',
			endTime: '17:00',
		})
	})

	it('runs past midnight into the next day', () => {
		const late = shift({
			startsAt: NINE_AM + 12 * HOUR,
			endsAt: NINE_AM + 16 * HOUR,
		}) // 21:00-01:00
		expect(resizeTimes(late, 'end', 60)).toEqual({
			startTime: '21:00',
			endTime: '02:00',
		})
		const evening = shift({
			startsAt: NINE_AM + 8 * HOUR,
			endsAt: NINE_AM + 14 * HOUR,
		}) // 17:00-23:00
		expect(resizeTimes(evening, 'end', 60)).toEqual({
			startTime: '17:00',
			endTime: '00:00',
		})
	})

	it('caps a shift at a day', () => {
		expect(resizeTimes(s, 'end', 24 * 60)).toEqual({
			startTime: '09:00',
			endTime: '09:00',
		})
	})
})

describe('sliding a shift in time', () => {
	it('keeps the length and snaps to 15 minutes', () => {
		expect(moveTimes(shift(), 60)).toEqual({
			startTime: '10:00',
			endTime: '18:00',
		})
		expect(moveTimes(shift(), -38)).toEqual({
			startTime: '08:15',
			endTime: '16:15',
		})
		expect(moveTimes(shift(), 6)).toBeNull()
	})

	it('stops at the day edge and runs on past midnight', () => {
		expect(moveTimes(shift(), -10_000)).toEqual({
			startTime: '00:00',
			endTime: '08:00',
		})
		expect(moveTimes(shift(), 10_000)).toEqual({
			startTime: '23:45',
			endTime: '07:45',
		})
	})
})

describe('across a clock change', () => {
	// 2026-03-08 in Chicago: 02:00 jumps to 03:00, so 01:00 to 05:00 is 3 hours
	// elapsed but 4 hours on the wall clock.
	const springForward = shift({
		localDate: '2026-03-08',
		startsAt: Date.UTC(2026, 2, 8, 7, 0),
		endsAt: Date.UTC(2026, 2, 8, 10, 0),
	})

	it('measures the length on the wall clock', () => {
		expect(wallLengthMinutes(springForward)).toBe(240)
		expect(wallLengthMinutes(shift())).toBe(480)
	})

	it('keeps the wall-clock end when the start slides', () => {
		expect(moveTimes(springForward, 15)).toEqual({
			startTime: '01:15',
			endTime: '05:15',
		})
	})

	it('moves only the edge that was resized', () => {
		expect(resizeTimes(springForward, 'end', 60)).toEqual({
			startTime: '01:00',
			endTime: '06:00',
		})
		expect(resizeTimes(springForward, 'start', 15)).toEqual({
			startTime: '01:15',
			endTime: '05:00',
		})
	})
})

describe('position names', () => {
	it('prefers Arabic for an Arabic viewer and falls back', () => {
		const p = { name: 'Server', nameAr: 'نادل' }
		expect(positionName(p, 'ar')).toBe('نادل')
		expect(positionName(p, 'en')).toBe('Server')
		expect(positionName({ name: 'Cook', nameAr: null }, 'ar')).toBe('Cook')
		expect(positionName(null, 'en')).toBe('')
	})
})

describe('copy and paste', () => {
	it('pastes the times, position, break and notes on another cell', () => {
		const clip = clipFromShift(
			shift({ notes: 'Patio', unpaidBreakMinutes: 30 }),
		)
		expect(
			pasteBody(clip, { rowKey: 's2', date: '2026-03-05' }, 'loc-1'),
		).toEqual({
			scopeId: 'loc-1',
			staffId: 's2',
			positionId: 'p1',
			dates: ['2026-03-05'],
			startTime: '09:00',
			endTime: '17:00',
			unpaidBreakMinutes: 30,
			notes: 'Patio',
		})
		expect(
			pasteBody(clip, { rowKey: OPEN_ROW, date: '2026-03-05' }, 'loc-1')
				.staffId,
		).toBeNull()
	})
})

describe('demand strip', () => {
	it('scales every day against the busiest hour of the week', () => {
		const days = summarizeDemand(demand())
		expect(days).toHaveLength(7)
		const busiest = Math.max(...days.flatMap((day) => day.bars))
		expect(busiest).toBe(1)
		expect(days[0]!.peakHour).toBe(11)
		expect(days[0]!.bars[3]).toBe(0)
	})

	it('has no peak on a quiet week', () => {
		const quiet = demand()
		for (const day of quiet.days) day.hours = day.hours.map(() => 0)
		const days = summarizeDemand(quiet)
		expect(days[0]!.peakHour).toBeNull()
		expect(days[0]!.bars.every((bar) => bar === 0)).toBe(true)
	})
})

describe('backfill ranking', () => {
	const open = shift({ id: 'open1', staffId: null, positionId: 'p1' })
	const base = (extra: Parameters<typeof week>[0] = {}) =>
		week({
			people: [
				person({ id: 'a', positionIds: ['p1'], weekMinutes: 1200 }),
				person({ id: 'b', positionIds: ['p1'], weekMinutes: 600 }),
				person({ id: 'c', positionIds: ['p2'] }),
				person({ id: 'd', positionIds: ['p1'], eligibleOpenShifts: false }),
				person({ id: 'e', positionIds: ['p1'], status: 'terminated' }),
			],
			shifts: [open],
			...extra,
		})

	it('offers people holding the position, fewest hours first', () => {
		const result = rankBackfill({ shift: open, week: base() })
		expect(result.map((c) => c.person.id)).toEqual(['b', 'a'])
		expect(result[0]!.afterMinutes).toBe(600 + 450)
	})

	it('puts the explicitly available first and flags near-overtime last', () => {
		const view = base({
			people: [
				person({ id: 'a', positionIds: ['p1'], weekMinutes: 1200 }),
				person({
					id: 'b',
					positionIds: ['p1'],
					weekMinutes: 600,
					overtimeMinutes: 30,
				}),
				person({ id: 'f', positionIds: ['p1'], weekMinutes: 1800 }),
			],
			overlays: [
				{
					staffId: 'f',
					timeOff: [],
					availability: [
						{
							id: 'av',
							kind: 'weekly',
							weekday: 1,
							date: null,
							availability: 'available',
							allDay: false,
							startMinute: 8 * 60,
							endMinute: 18 * 60,
							effectiveFrom: null,
							effectiveTo: null,
						},
					],
				},
			],
		})
		const result = rankBackfill({ shift: open, week: view })
		expect(result.map((c) => [c.person.id, c.status])).toEqual([
			['f', 'available'],
			['a', 'unknown'],
			['b', 'unknown'],
		])
	})

	it('drops people on time off, double-booked, or blocked, unless asked to show them', () => {
		const view = base({
			shifts: [
				open,
				shift({
					id: 'busy',
					staffId: 'a',
					startsAt: NINE_AM + HOUR,
					endsAt: NINE_AM + 5 * HOUR,
				}),
			],
			overlays: [
				{
					staffId: 'b',
					timeOff: [
						{
							id: 't',
							status: 'approved',
							category: 'pto',
							startDate: '2026-03-02',
							endDate: '2026-03-02',
							allDay: true,
							startMinute: null,
							endMinute: null,
						},
					],
					availability: [],
				},
			],
		})
		expect(rankBackfill({ shift: open, week: view })).toEqual([])
		const all = rankBackfill({ shift: open, week: view, includeBlocked: true })
		expect(all.map((c) => [c.person.id, c.status])).toEqual([
			['b', 'time_off'],
			['a', 'overlap'],
		])
	})

	it('ignores pending time off and a window that does not cover the shift', () => {
		const view = base({
			overlays: [
				{
					staffId: 'a',
					timeOff: [
						{
							id: 't',
							status: 'pending',
							category: 'pto',
							startDate: '2026-03-02',
							endDate: '2026-03-02',
							allDay: true,
							startMinute: null,
							endMinute: null,
						},
					],
					availability: [
						{
							id: 'one',
							kind: 'one_off',
							weekday: null,
							date: '2026-03-02',
							availability: 'available',
							allDay: false,
							startMinute: 10 * 60,
							endMinute: 14 * 60,
							effectiveFrom: null,
							effectiveTo: null,
						},
					],
				},
			],
		})
		const result = rankBackfill({ shift: open, week: view })
		expect(result.find((c) => c.person.id === 'a')?.status).toBe('outside')
	})

	it('does not offer the person already on the shift', () => {
		const held = shift({ id: 'h', staffId: 'b' })
		const result = rankBackfill({ shift: held, week: base({ shifts: [held] }) })
		expect(result.map((c) => c.person.id)).not.toContain('b')
	})
})

describe('month math', () => {
	it('lists the weeks a month touches', () => {
		// March 2026 starts on a Sunday; with Monday weeks it needs 6 rows.
		expect(monthWeekStarts('2026-03-15', 1)).toEqual([
			'2026-02-23',
			'2026-03-02',
			'2026-03-09',
			'2026-03-16',
			'2026-03-23',
			'2026-03-30',
		])
		expect(monthWeekStarts('2026-03-15', 0)[0]).toBe('2026-03-01')
		expect(monthWeekStarts('2026-12-31', 1).at(-1)).toBe('2026-12-28')
	})

	it('steps months across a year', () => {
		expect(shiftMonth('2026-12-15', 1)).toBe('2027-01-01')
		expect(shiftMonth('2026-01-31', -1)).toBe('2025-12-01')
		expect(shiftMonth('2026-03-15', 0)).toBe('2026-03-01')
	})
})
