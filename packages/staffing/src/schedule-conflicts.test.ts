import { describe, expect, it } from 'vitest'
import { type LaborRules, NEUTRAL_LABOR_RULES } from './rules.ts'
import {
	type AvailabilityWindow,
	availabilityFor,
	availabilityViolation,
	type ConflictShift,
	detectPersonConflicts,
	groupConflictsByShift,
	type PersonConflictContext,
	type TimeOffWindow,
} from './schedule-conflicts.ts'
import { SCHEDULE_CONFLICT_CODES } from './schedule-api.ts'
import { minuteOfDayFromHhmm, resolveShiftWindow } from './schedule-time.ts'

const CHI = 'America/Chicago'
const RIYADH = 'Asia/Riyadh'
const LOC = 'loc-1'

function shift(
	id: string,
	date: string,
	start: string,
	end: string,
	overrides: Partial<ConflictShift> = {},
): ConflictShift {
	const tz = overrides.timeZone ?? CHI
	const result = resolveShiftWindow({
		date,
		startMinute: minuteOfDayFromHhmm(start),
		endMinute: minuteOfDayFromHhmm(end),
		timeZone: tz,
	})
	if (!result.ok) throw new Error(`bad fixture ${id}: ${result.reason}`)
	return {
		id,
		scopeId: LOC,
		positionId: 'tech',
		startsAt: result.window.startsAt,
		endsAt: result.window.endsAt,
		localDate: date,
		timeZone: tz,
		unpaidBreakMinutes: 0,
		...overrides,
	}
}

function person(
	overrides: Partial<PersonConflictContext> = {},
): PersonConflictContext {
	return {
		status: 'active',
		assignedScopeIds: new Set([LOC]),
		jobs: [
			{
				scopeId: LOC,
				positionId: 'tech',
				effectiveFrom: '2020-01-01',
				effectiveTo: null,
			},
		],
		timeOff: [],
		availability: [],
		...overrides,
	}
}

const WEEKLY_40: LaborRules = {
	...NEUTRAL_LABOR_RULES,
	weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
}

function detect(
	shifts: ConflictShift[],
	ctx: PersonConflictContext = person(),
	extra: Partial<Parameters<typeof detectPersonConflicts>[0]> = {},
) {
	return detectPersonConflicts({
		shifts,
		person: ctx,
		rules: NEUTRAL_LABOR_RULES,
		minRestMinutes: 0,
		...extra,
	})
}

const codes = (conflicts: { code: string }[]) => conflicts.map((c) => c.code)

describe('stable codes', () => {
	it('lists every code the detector can emit', () => {
		expect([...SCHEDULE_CONFLICT_CODES]).toEqual([
			'overlap',
			'time_off',
			'unavailable',
			'overtime',
			'min_rest',
			'position_mismatch',
			'not_at_scope',
			'staff_on_leave',
		])
	})
})

describe('a clean schedule', () => {
	it('reports nothing for separate shifts that fit', () => {
		expect(
			detect([
				shift('a', '2026-03-02', '09:00', '17:00'),
				shift('b', '2026-03-03', '09:00', '17:00'),
			]),
		).toEqual([])
	})
})

describe('overlap', () => {
	it('flags both shifts and points each at the other', () => {
		const conflicts = detect([
			shift('a', '2026-03-02', '09:00', '17:00'),
			shift('b', '2026-03-02', '16:00', '22:00'),
		])
		expect(conflicts).toEqual([
			{ code: 'overlap', shiftId: 'a', relatedId: 'b', date: '2026-03-02' },
			{ code: 'overlap', shiftId: 'b', relatedId: 'a', date: '2026-03-02' },
		])
	})

	it('lets shifts touch end to start without a conflict', () => {
		expect(
			detect([
				shift('a', '2026-03-02', '09:00', '13:00'),
				shift('b', '2026-03-02', '13:00', '17:00'),
			]),
		).toEqual([])
	})

	it('catches an overnight shift running into the next morning shift', () => {
		const conflicts = detect([
			shift('late', '2026-03-02', '22:00', '03:00'),
			shift('early', '2026-03-03', '02:00', '09:00'),
		])
		expect(codes(conflicts)).toEqual(['overlap', 'overlap'])
	})

	it('catches double booking across scopes', () => {
		const conflicts = detect([
			shift('a', '2026-03-02', '09:00', '17:00'),
			shift('b', '2026-03-02', '10:00', '12:00', { scopeId: 'loc-2' }),
		])
		expect(codes(conflicts)).toContain('overlap')
	})

	it('reports only on the shifts asked about', () => {
		const conflicts = detect(
			[
				shift('a', '2026-03-02', '09:00', '17:00'),
				shift('b', '2026-03-02', '16:00', '22:00'),
			],
			person(),
			{ only: new Set(['b']) },
		)
		expect(conflicts).toEqual([
			{ code: 'overlap', shiftId: 'b', relatedId: 'a', date: '2026-03-02' },
		])
	})
})

describe('time off', () => {
	const off = (overrides: Partial<TimeOffWindow> = {}): TimeOffWindow => ({
		id: 'off-1',
		startDate: '2026-03-03',
		endDate: '2026-03-04',
		allDay: true,
		startMinute: null,
		endMinute: null,
		...overrides,
	})

	it('flags a shift on a day of approved time off', () => {
		const conflicts = detect(
			[
				shift('a', '2026-03-02', '09:00', '17:00'),
				shift('b', '2026-03-03', '09:00', '17:00'),
				shift('c', '2026-03-04', '09:00', '17:00'),
				shift('d', '2026-03-05', '09:00', '17:00'),
			],
			person({ timeOff: [off()] }),
		)
		expect(
			conflicts.map((c) => [c.shiftId, c.code, c.relatedId, c.date]),
		).toEqual([
			['b', 'time_off', 'off-1', '2026-03-03'],
			['c', 'time_off', 'off-1', '2026-03-04'],
		])
	})

	it('flags an overnight shift that runs into a time-off day', () => {
		const conflicts = detect(
			[shift('night', '2026-03-02', '22:00', '04:00')],
			person({ timeOff: [off()] }),
		)
		expect(conflicts).toEqual([
			{
				code: 'time_off',
				shiftId: 'night',
				relatedId: 'off-1',
				date: '2026-03-03',
			},
		])
	})

	it('flags a part-day request only where the hours overlap', () => {
		const partial = off({
			startDate: '2026-03-03',
			endDate: '2026-03-03',
			allDay: false,
			startMinute: 13 * 60,
			endMinute: 15 * 60,
		})
		const conflicts = detect(
			[
				shift('morning', '2026-03-03', '08:00', '13:00'),
				shift('overlap', '2026-03-03', '14:00', '18:00'),
				shift('after', '2026-03-03', '15:00', '20:00'),
			],
			person({ timeOff: [partial] }),
		)
		expect(
			conflicts.filter((c) => c.code === 'time_off').map((c) => c.shiftId),
		).toEqual(['overlap'])
	})

	it('names a request once per shift even when it spans several days', () => {
		const conflicts = detect(
			[shift('long', '2026-03-03', '22:00', '23:59')],
			person({
				timeOff: [off({ startDate: '2026-03-03', endDate: '2026-03-09' })],
			}),
		)
		expect(conflicts.filter((c) => c.code === 'time_off')).toHaveLength(1)
	})
})

describe('availability', () => {
	let n = 0
	const win = (overrides: Partial<AvailabilityWindow>): AvailabilityWindow => ({
		id: `av-${++n}`,
		kind: 'weekly',
		weekday: 1, // Monday
		date: null,
		availability: 'unavailable',
		allDay: true,
		startMinute: null,
		endMinute: null,
		effectiveFrom: null,
		effectiveTo: null,
		...overrides,
	})

	it('flags a shift on a day the person cannot work', () => {
		const block = win({ id: 'mon' })
		const conflicts = detect(
			[
				shift('mon', '2026-03-02', '09:00', '17:00'), // Monday
				shift('tue', '2026-03-03', '09:00', '17:00'),
			],
			person({ availability: [block] }),
		)
		expect(conflicts).toEqual([
			{
				code: 'unavailable',
				shiftId: 'mon',
				relatedId: 'mon',
				date: '2026-03-02',
			},
		])
	})

	it('flags only the blocked hours of a partly blocked day', () => {
		const block = win({
			id: 'evening',
			allDay: false,
			startMinute: 17 * 60,
			endMinute: 1440,
		})
		const conflicts = detect(
			[
				shift('day', '2026-03-02', '09:00', '17:00'),
				shift('close', '2026-03-02', '16:00', '21:00'),
			],
			person({ availability: [block] }),
		)
		expect(
			conflicts.filter((c) => c.code === 'unavailable').map((c) => c.shiftId),
		).toEqual(['close'])
	})

	it('treats approved available windows as the only hours worth scheduling', () => {
		const open = win({
			id: 'open',
			availability: 'available',
			allDay: false,
			startMinute: 9 * 60,
			endMinute: 15 * 60,
		})
		const conflicts = detect(
			[
				shift('inside', '2026-03-02', '09:00', '15:00'),
				shift('spills', '2026-03-02', '13:00', '17:00'),
				shift('outside', '2026-03-02', '16:00', '20:00'),
			],
			person({ availability: [open] }),
		)
		expect(
			conflicts.filter((c) => c.code === 'unavailable').map((c) => c.shiftId),
		).toEqual(['spills', 'outside'])
	})

	it('joins adjacent available windows into one', () => {
		const windows = [
			win({
				id: 'a',
				availability: 'available',
				allDay: false,
				startMinute: 540,
				endMinute: 780,
			}),
			win({
				id: 'b',
				availability: 'available',
				allDay: false,
				startMinute: 780,
				endMinute: 1020,
			}),
		]
		expect(
			detect(
				[shift('x', '2026-03-02', '10:00', '16:00')],
				person({ availability: windows }),
			),
		).toEqual([])
	})

	it('lets a one-off row for a date replace that weekday pattern', () => {
		const weekly = win({ id: 'weekly-block' })
		const oneOff = win({
			id: 'one-off',
			kind: 'one_off',
			weekday: null,
			date: '2026-03-02',
			availability: 'available',
			allDay: true,
		})
		expect(
			detect(
				[shift('x', '2026-03-02', '09:00', '17:00')],
				person({ availability: [weekly, oneOff] }),
			),
		).toEqual([])
		// The next Monday still follows the weekly pattern.
		expect(
			codes(
				detect(
					[shift('y', '2026-03-09', '09:00', '17:00')],
					person({ availability: [weekly, oneOff] }),
				),
			),
		).toEqual(['unavailable'])
	})

	it('honors the dates a weekly pattern is effective for', () => {
		const windows = [
			win({ id: 'later', effectiveFrom: '2026-03-09' }),
			win({ id: 'ended', effectiveTo: '2026-02-23' }),
		]
		expect(
			detect(
				[shift('x', '2026-03-02', '09:00', '17:00')],
				person({ availability: windows }),
			),
		).toEqual([])
		expect(
			codes(
				detect(
					[shift('y', '2026-03-09', '09:00', '17:00')],
					person({ availability: windows }),
				),
			),
		).toEqual(['unavailable'])
	})

	it('checks each day of an overnight shift against its own day', () => {
		// Free all Monday, blocked Tuesday morning: a Monday-night shift runs into it.
		const tuesdayMorning = win({
			id: 'tue',
			weekday: 2,
			allDay: false,
			startMinute: 0,
			endMinute: 6 * 60,
		})
		const conflicts = detect(
			[shift('night', '2026-03-02', '22:00', '04:00')],
			person({ availability: [tuesdayMorning] }),
		)
		expect(conflicts).toEqual([
			{
				code: 'unavailable',
				shiftId: 'night',
				relatedId: 'tue',
				date: '2026-03-03',
			},
		])
	})

	it('exposes the rules that apply to a date', () => {
		const weekly = win({ id: 'w' })
		const oneOff = win({
			id: 'o',
			kind: 'one_off',
			weekday: null,
			date: '2026-03-02',
		})
		expect(
			availabilityFor('2026-03-02', [weekly, oneOff]).map((w) => w.id),
		).toEqual(['o'])
		expect(
			availabilityFor('2026-03-09', [weekly, oneOff]).map((w) => w.id),
		).toEqual(['w'])
		expect(
			availabilityViolation(
				{ date: '2026-03-03', startMinute: 0, endMinute: 100 },
				[weekly],
			),
		).toBeNull()
	})
})

describe('position and scope', () => {
	it('flags a position the person has no pay row for', () => {
		expect(
			codes(
				detect([
					shift('a', '2026-03-02', '09:00', '17:00', { positionId: 'bar' }),
				]),
			),
		).toEqual(['position_mismatch'])
	})

	it('flags a pay row that is not in force on the shift date', () => {
		const ctx = person({
			jobs: [
				{
					scopeId: LOC,
					positionId: 'tech',
					effectiveFrom: '2026-03-09',
					effectiveTo: null,
				},
			],
		})
		expect(
			codes(detect([shift('a', '2026-03-02', '09:00', '17:00')], ctx)),
		).toEqual(['position_mismatch'])
		const ended = person({
			jobs: [
				{
					scopeId: LOC,
					positionId: 'tech',
					effectiveFrom: '2020-01-01',
					effectiveTo: '2026-03-01',
				},
			],
		})
		expect(
			codes(detect([shift('a', '2026-03-02', '09:00', '17:00')], ended)),
		).toEqual(['position_mismatch'])
	})

	it('does not judge the position of a shift without one', () => {
		expect(
			detect([
				shift('a', '2026-03-02', '09:00', '17:00', { positionId: null }),
			]),
		).toEqual([])
	})

	it('flags a scope the person is not assigned to, without a second position warning', () => {
		const conflicts = detect([
			shift('a', '2026-03-02', '09:00', '17:00', { scopeId: 'loc-9' }),
		])
		expect(codes(conflicts)).toEqual(['not_at_scope'])
	})

	it('flags every shift of a person on leave', () => {
		const conflicts = detect(
			[
				shift('a', '2026-03-02', '09:00', '17:00'),
				shift('b', '2026-03-03', '09:00', '17:00'),
			],
			person({ status: 'on_leave' }),
		)
		expect(codes(conflicts)).toEqual(['staff_on_leave', 'staff_on_leave'])
	})
})

describe('minimum rest', () => {
	it('flags a short night between two days', () => {
		const conflicts = detect(
			[
				shift('close', '2026-03-02', '16:00', '23:00'),
				shift('open', '2026-03-03', '05:00', '13:00'),
			],
			person(),
			{ minRestMinutes: 480 },
		)
		expect(conflicts).toEqual([
			{
				code: 'min_rest',
				shiftId: 'open',
				relatedId: 'close',
				date: '2026-03-03',
				detail: { restMinutes: 360, requiredMinutes: 480 },
			},
		])
	})

	it('measures rest from an overnight shift end', () => {
		const conflicts = detect(
			[
				shift('late', '2026-03-02', '20:00', '02:00'),
				shift('lunch', '2026-03-03', '08:00', '16:00'),
			],
			person(),
			{ minRestMinutes: 480 },
		)
		expect(conflicts).toEqual([
			expect.objectContaining({
				code: 'min_rest',
				shiftId: 'lunch',
				detail: { restMinutes: 360, requiredMinutes: 480 },
			}),
		])
	})

	it('does not treat a split shift on one day as a short rest', () => {
		expect(
			detect(
				[
					shift('lunch', '2026-03-02', '11:00', '14:00'),
					shift('dinner', '2026-03-02', '17:00', '23:00'),
				],
				person(),
				{ minRestMinutes: 480 },
			),
		).toEqual([])
	})

	it('is off at zero and respects a long enough rest', () => {
		const shifts = [
			shift('a', '2026-03-02', '16:00', '23:00'),
			shift('b', '2026-03-03', '05:00', '13:00'),
		]
		expect(detect(shifts, person(), { minRestMinutes: 0 })).toEqual([])
		expect(detect(shifts, person(), { minRestMinutes: 360 })).toEqual([])
		expect(codes(detect(shifts, person(), { minRestMinutes: 361 }))).toEqual([
			'min_rest',
		])
	})

	it('can be skipped for callers that only want the cheap checks', () => {
		const shifts = [
			shift('a', '2026-03-02', '16:00', '23:00'),
			shift('b', '2026-03-03', '05:00', '13:00'),
		]
		expect(
			detect(shifts, person(), {
				minRestMinutes: 480,
				skip: new Set(['min_rest']),
			}),
		).toEqual([])
	})
})

describe('overtime', () => {
	function forty(...extra: ConflictShift[]) {
		// Monday to Friday, 8 hours each: exactly 40 hours.
		return [
			shift('mon', '2026-03-02', '09:00', '17:00'),
			shift('tue', '2026-03-03', '09:00', '17:00'),
			shift('wed', '2026-03-04', '09:00', '17:00'),
			shift('thu', '2026-03-05', '09:00', '17:00'),
			shift('fri', '2026-03-06', '09:00', '17:00'),
			...extra,
		]
	}

	it('is quiet at exactly the threshold', () => {
		expect(detect(forty(), person(), { rules: WEEKLY_40 })).toEqual([])
	})

	it('flags the shifts that carry the person past the weekly threshold', () => {
		const conflicts = detect(
			forty(shift('sat', '2026-03-07', '09:00', '13:00')),
			person(),
			{ rules: WEEKLY_40 },
		)
		expect(conflicts).toEqual([
			{
				code: 'overtime',
				shiftId: 'sat',
				date: '2026-03-07',
				detail: { overtimeMinutes: 240 },
			},
		])
	})

	it('does not count an unpaid break as scheduled time', () => {
		const conflicts = detect(
			[
				...forty().map((s) => ({ ...s, unpaidBreakMinutes: 30 })),
				shift('sat', '2026-03-07', '09:00', '13:00'),
			],
			person(),
			{ rules: WEEKLY_40 },
		)
		// 5 x 7.5h = 37.5h, plus 4h = 41.5h: 1.5h over.
		expect(conflicts).toEqual([
			{
				code: 'overtime',
				shiftId: 'sat',
				date: '2026-03-07',
				detail: { overtimeMinutes: 90 },
			},
		])
	})

	it('starts a new count at the week boundary (Monday week)', () => {
		// Sunday belongs to the week that began the Monday before.
		const conflicts = detect(
			[
				...forty(),
				shift('sun', '2026-03-08', '09:00', '13:00'),
				shift('next', '2026-03-09', '09:00', '17:00'),
			],
			person(),
			{ rules: WEEKLY_40 },
		)
		expect(
			conflicts.map((c) => [c.shiftId, c.detail?.overtimeMinutes]),
		).toEqual([['sun', 240]])
	})

	it('moves the boundary with a Sunday week start', () => {
		const sundayRules: LaborRules = { ...WEEKLY_40, weekStartsOn: 0 }
		// With Sunday starts, Sunday 03-08 begins a new week and carries no overtime.
		const conflicts = detect(
			[...forty(), shift('sun', '2026-03-08', '09:00', '13:00')],
			person(),
			{ rules: sundayRules },
		)
		expect(conflicts).toEqual([])
		// ...but Sunday 03-01 belongs to the same Sunday-week as Mon-Fri.
		const sameWeek = detect(
			[...forty(), shift('sun', '2026-03-01', '09:00', '13:00')],
			person(),
			{ rules: sundayRules },
		)
		expect(sameWeek.map((c) => c.shiftId)).toEqual(['fri'])
	})

	it('counts across scopes when the policy aggregates them', () => {
		const other = shift('other', '2026-03-07', '09:00', '13:00', {
			scopeId: 'loc-2',
		})
		const separate = detect(
			forty(other),
			person({
				assignedScopeIds: new Set([LOC, 'loc-2']),
				jobs: [
					{
						scopeId: LOC,
						positionId: 'tech',
						effectiveFrom: '2020-01-01',
						effectiveTo: null,
					},
					{
						scopeId: 'loc-2',
						positionId: 'tech',
						effectiveFrom: '2020-01-01',
						effectiveTo: null,
					},
				],
			}),
			{ rules: WEEKLY_40 },
		)
		expect(separate).toEqual([])
		const together = detect(
			forty(other),
			person({
				assignedScopeIds: new Set([LOC, 'loc-2']),
				jobs: [
					{
						scopeId: LOC,
						positionId: 'tech',
						effectiveFrom: '2020-01-01',
						effectiveTo: null,
					},
					{
						scopeId: 'loc-2',
						positionId: 'tech',
						effectiveFrom: '2020-01-01',
						effectiveTo: null,
					},
				],
			}),
			{ rules: { ...WEEKLY_40, aggregateOvertimeAcrossScopes: true } },
		)
		expect(together.map((c) => c.code)).toEqual(['overtime'])
	})

	it('applies daily overtime on one long day', () => {
		const daily: LaborRules = {
			...NEUTRAL_LABOR_RULES,
			dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
		}
		const conflicts = detect(
			[shift('long', '2026-03-02', '08:00', '19:00')],
			person(),
			{ rules: daily },
		)
		expect(conflicts).toEqual([
			{
				code: 'overtime',
				shiftId: 'long',
				date: '2026-03-02',
				detail: { overtimeMinutes: 180 },
			},
		])
	})

	it('handles a clock change inside the week by real hours', () => {
		// Sat night over spring-forward is 7 real hours, not 8: 40 + 7 = 47.
		const conflicts = detect(
			[...forty(), shift('night', '2026-03-07', '22:00', '06:00')],
			person(),
			{ rules: WEEKLY_40 },
		)
		// The whole shift is inside the Monday week (it ends Sunday morning).
		expect(conflicts).toEqual([
			{
				code: 'overtime',
				shiftId: 'night',
				date: '2026-03-07',
				detail: { overtimeMinutes: 420 },
			},
		])
	})

	it('is the same in Riyadh, where no clock change exists', () => {
		const rShift = (id: string, date: string, start: string, end: string) =>
			shift(id, date, start, end, { timeZone: RIYADH })
		const conflicts = detect(
			[
				rShift('sun', '2026-03-01', '09:00', '17:00'),
				rShift('mon', '2026-03-02', '09:00', '17:00'),
				rShift('tue', '2026-03-03', '09:00', '17:00'),
				rShift('wed', '2026-03-04', '09:00', '17:00'),
				rShift('thu', '2026-03-05', '09:00', '17:00'),
				rShift('night', '2026-03-05', '22:00', '04:00'),
			],
			person(),
			{ rules: { ...WEEKLY_40, weekStartsOn: 0 } },
		)
		expect(conflicts.map((c) => [c.shiftId, c.code])).toEqual([
			['night', 'overtime'],
		])
	})
})

describe('determinism and shape', () => {
	it('returns the same conflicts whatever order the shifts arrive in', () => {
		const shifts = [
			shift('b', '2026-03-02', '16:00', '22:00'),
			shift('a', '2026-03-02', '09:00', '17:00'),
			shift('c', '2026-03-03', '05:00', '09:00'),
		]
		const forward = detect(shifts, person(), { minRestMinutes: 600 })
		const backward = detect([...shifts].reverse(), person(), {
			minRestMinutes: 600,
		})
		expect(backward).toEqual(forward)
		expect(forward.length).toBeGreaterThan(0)
	})

	it('carries ids, dates and minutes only', () => {
		const conflicts = detect(
			[
				shift('a', '2026-03-02', '09:00', '17:00'),
				shift('b', '2026-03-02', '16:00', '22:00'),
			],
			person({ status: 'on_leave' }),
			{ minRestMinutes: 480 },
		)
		for (const conflict of conflicts) {
			expect(
				Object.keys(conflict).every((k) =>
					['code', 'shiftId', 'relatedId', 'date', 'detail'].includes(k),
				),
			).toBe(true)
			for (const value of Object.values(conflict.detail ?? {})) {
				expect(typeof value).toBe('number')
			}
		}
	})

	it('never throws on an empty week', () => {
		expect(detect([])).toEqual([])
	})

	it('groups conflicts by shift', () => {
		const grouped = groupConflictsByShift([
			{ code: 'overlap', shiftId: 'a', relatedId: 'b' },
			{ code: 'overlap', shiftId: 'b', relatedId: 'a' },
			{ code: 'time_off', shiftId: 'a' },
		])
		expect(grouped.get('a')).toHaveLength(2)
		expect(grouped.get('b')).toHaveLength(1)
	})
})
