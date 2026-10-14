import { describe, expect, it } from 'vitest'
import { BUILTIN_LABOR_POLICY, laborPolicyToRules } from './labor-policy.ts'
import {
	autoClockOutDeadline,
	breakIsPaid,
	computeCachedMinutes,
	computeEntryFigures,
	computeEntryIssues,
	decideClockIn,
	decideClockOut,
	missedBreakRules,
	missedClockOutReminderDeadline,
	needsReview,
	statusAfterClose,
	type EntryBreak,
	type ShiftWindow,
} from './punch-policy.ts'
import { parseDate, zonedLocalToUtc } from './tz.ts'

const CHI = 'America/Chicago'
const TOR = 'America/Toronto'
const RUH = 'Asia/Riyadh'

function at(date: string, hhmm: string, tz: string): number {
	const { year, month, day } = parseDate(date)
	const [h, m] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(year, month, day, h, m, tz)
}
const MIN = 60_000

describe('decideClockIn', () => {
	const policy = {
		lateGraceMinutes: 5,
		preventEarlyMinutes: 15 as number | null,
		allowUnscheduled: true,
	}
	const shift: ShiftWindow = {
		id: 's1',
		startAt: 10_000 * MIN,
		endAt: 18_000 * MIN,
		positionId: null,
	}

	it('does not judge scheduling when the schedule is unavailable', () => {
		expect(decideClockIn({ policy, atMs: 0, shift: undefined })).toEqual({
			ok: true,
			flags: [],
			shift: null,
		})
	})

	it('flags unscheduled punches or refuses them by policy', () => {
		expect(decideClockIn({ policy, atMs: 1, shift: null })).toEqual({
			ok: true,
			flags: ['unscheduled'],
			shift: null,
		})
		expect(
			decideClockIn({
				policy: { ...policy, allowUnscheduled: false },
				atMs: 1,
				shift: null,
			}),
		).toEqual({
			ok: false,
			code: 'unscheduled_not_allowed',
		})
	})

	it('blocks clock-ins earlier than the prevent-early window and reports when it opens', () => {
		const result = decideClockIn({
			policy,
			atMs: shift.startAt - 16 * MIN,
			shift,
		})
		expect(result).toEqual({
			ok: false,
			code: 'early_clock_in',
			earliestAt: shift.startAt - 15 * MIN,
		})
		expect(
			decideClockIn({ policy, atMs: shift.startAt - 15 * MIN, shift }).ok,
		).toBe(true)
	})

	it('flags late beyond grace and early when prevent-early is off', () => {
		expect(
			decideClockIn({ policy, atMs: shift.startAt + 5 * MIN, shift }),
		).toMatchObject({ ok: true, flags: [] })
		expect(
			decideClockIn({ policy, atMs: shift.startAt + 5 * MIN + 1, shift }),
		).toMatchObject({ flags: ['late'] })
		const off = { ...policy, preventEarlyMinutes: null }
		expect(
			decideClockIn({ policy: off, atMs: shift.startAt - 6 * MIN, shift }),
		).toMatchObject({ flags: ['early_in'] })
		expect(
			decideClockIn({ policy: off, atMs: shift.startAt - 5 * MIN, shift }),
		).toMatchObject({ flags: [] })
	})

	it('flags an early clock-out beyond grace', () => {
		expect(
			decideClockOut({ policy, atMs: shift.endAt - 6 * MIN, shift }),
		).toEqual(['early_out'])
		expect(
			decideClockOut({ policy, atMs: shift.endAt - 5 * MIN, shift }),
		).toEqual([])
		expect(decideClockOut({ policy, atMs: 0, shift: null })).toEqual([])
		expect(decideClockOut({ policy, atMs: 0, shift: undefined })).toEqual([])
	})
})

describe('deadlines', () => {
	it('are null when off and relative to the shift end or clock-in otherwise', () => {
		const clockInAt = 1_000 * MIN
		expect(
			autoClockOutDeadline({
				policy: { autoClockOutMinutes: null },
				clockInAt,
				shiftEndAt: null,
			}),
		).toBeNull()
		expect(
			autoClockOutDeadline({
				policy: { autoClockOutMinutes: 60 },
				clockInAt,
				shiftEndAt: null,
			}),
		).toBe(clockInAt + 60 * MIN)
		expect(
			autoClockOutDeadline({
				policy: { autoClockOutMinutes: 60 },
				clockInAt,
				shiftEndAt: 2_000 * MIN,
			}),
		).toBe(2_060 * MIN)
		expect(
			missedClockOutReminderDeadline({
				policy: { missedClockOutReminderMinutes: 30 },
				clockInAt,
				shiftEndAt: 2_000 * MIN,
			}),
		).toBe(2_030 * MIN)
		expect(
			missedClockOutReminderDeadline({
				policy: { missedClockOutReminderMinutes: null },
				clockInAt,
				shiftEndAt: null,
			}),
		).toBeNull()
	})
})

describe('break rules', () => {
	const meal = {
		kind: 'meal',
		afterMinutes: 300,
		minutes: 30,
		paid: false,
		mandatory: true,
	} as const
	const b = (
		kind: 'meal' | 'rest',
		start: number,
		end: number | null,
	): EntryBreak => ({
		kind,
		startAt: start * MIN,
		endAt: end === null ? null : end * MIN,
		paid: kind === 'rest',
	})

	it('reports a mandatory rule not met after enough time', () => {
		expect(missedBreakRules([meal], 299, [])).toEqual([])
		expect(missedBreakRules([meal], 300, [])).toEqual([meal])
		expect(missedBreakRules([meal], 400, [b('meal', 100, 129)])).toEqual([meal])
		expect(missedBreakRules([meal], 400, [b('meal', 100, 130)])).toEqual([])
		expect(missedBreakRules([meal], 400, [b('rest', 100, 160)])).toEqual([meal])
		expect(missedBreakRules([meal], 400, [b('meal', 100, null)])).toEqual([
			meal,
		])
		expect(missedBreakRules([{ ...meal, mandatory: false }], 600, [])).toEqual(
			[],
		)
	})

	it('meal breaks are unpaid and rest breaks are paid unless a rule says otherwise', () => {
		expect(breakIsPaid([], 'meal')).toBe(false)
		expect(breakIsPaid([], 'rest')).toBe(true)
		expect(breakIsPaid([{ ...meal, paid: true }], 'meal')).toBe(true)
	})
})

describe('computeEntryIssues', () => {
	const policy = {
		...BUILTIN_LABOR_POLICY,
		breakRules: {
			rules: [
				{
					kind: 'meal' as const,
					afterMinutes: 300,
					minutes: 30,
					paid: false,
					mandatory: true,
				},
			],
			autoDeduction: null,
		},
	}
	const rules = laborPolicyToRules(policy)
	const base = (
		clockIn: number,
		clockOut: number | null,
		breaks: EntryBreak[] = [],
	) => ({
		id: 'e1',
		scopeId: 'l1',
		clockInAt: clockIn,
		clockOutAt: clockOut,
		breaks,
	})
	const run = (
		entry: ReturnType<typeof base>,
		extra: { nowMs?: number; punchFlags?: string[] } = {},
	) =>
		computeEntryIssues({
			entry,
			rules,
			breakRules: policy.breakRules.rules,
			timeZone: CHI,
			...extra,
		})

	it('is clean for an ordinary shift', () => {
		const start = at('2026-03-02', '09:00', CHI)
		expect(run(base(start, start + 240 * MIN))).toEqual([])
	})

	it('flags a missed mandatory break and a long shift', () => {
		const start = at('2026-03-02', '06:00', CHI)
		const issues = run(base(start, start + 17 * 60 * MIN))
		expect(issues).toContain('missed_break')
		expect(issues).toContain('long_shift')
		expect(needsReview(issues)).toBe(true)
		expect(statusAfterClose(issues)).toBe('needs_review')
	})

	it('does not flag a missed break for a person allowed to waive breaks', () => {
		const start = at('2026-03-02', '06:00', CHI)
		const entry = { ...base(start, start + 400 * MIN), breakWaived: true }
		expect(run(entry)).not.toContain('missed_break')
	})

	it('keeps punch flags, ignores unknown ones, and orders by taxonomy', () => {
		const start = at('2026-03-02', '09:00', CHI)
		const issues = run(base(start, start + 120 * MIN), {
			punchFlags: ['late', 'offline_punch', 'made_up', 'unscheduled'],
		})
		expect(issues).toEqual(['unscheduled', 'late', 'offline_punch'])
		expect(statusAfterClose(issues)).toBe('closed')
	})

	it('marks an entry open for longer than the long-shift limit as missing its clock-out', () => {
		const start = at('2026-03-02', '09:00', CHI)
		expect(run(base(start, null), { nowMs: start + 17 * 60 * MIN })).toContain(
			'missing_clock_out',
		)
		expect(
			run(base(start, null), { nowMs: start + 3 * 60 * MIN }),
		).not.toContain('missing_clock_out')
		expect(run(base(start, null))).toEqual([])
	})

	it('reports break problems from the shared time math', () => {
		const start = at('2026-03-02', '09:00', CHI)
		const issues = run(
			base(start, start + 240 * MIN, [
				{
					kind: 'meal',
					startAt: start + 60 * MIN,
					endAt: start + 100 * MIN,
					paid: false,
				},
				{
					kind: 'meal',
					startAt: start + 80 * MIN,
					endAt: start + 120 * MIN,
					paid: false,
				},
				{
					kind: 'meal',
					startAt: start + 230 * MIN,
					endAt: start + 260 * MIN,
					paid: false,
				},
			]),
		)
		expect(issues).toContain('overlapping_breaks')
		expect(issues).toContain('break_outside_entry')
	})
})

describe('computeCachedMinutes', () => {
	const resolve =
		(tz: string, patch = {}) =>
		() => ({
			rules: laborPolicyToRules({ ...BUILTIN_LABOR_POLICY, ...patch }),
			timeZone: tz,
		})
	const entry = (
		id: string,
		loc: string,
		from: number,
		to: number,
		extra = {},
	) => ({
		id,
		scopeId: loc,
		clockInAt: from,
		clockOutAt: to,
		...extra,
	})

	it('returns zeros for open entries and splits regular and overtime across a week', () => {
		const week = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']
		const entries = week.map((d, i) =>
			entry(`e${i}`, 'l1', at(d, '08:00', CHI), at(d, '19:00', CHI)),
		)
		const open = entry('open', 'l1', at('2026-03-06', '08:00', CHI), 0)
		const result = computeCachedMinutes(
			[...entries, { ...open, clockOutAt: null }],
			resolve(CHI, {
				weeklyOvertime: { thresholdMinutes: 40 * 60, multiplierBp: 15000 },
			}),
		)
		const regular = [...result.values()].reduce(
			(s, v) => s + v.regularMinutes,
			0,
		)
		const overtime = [...result.values()].reduce(
			(s, v) => s + v.overtimeMinutes,
			0,
		)
		expect(regular).toBe(40 * 60)
		expect(overtime).toBe(4 * 11 * 60 - 40 * 60)
		expect(result.get('open')).toEqual({
			regularMinutes: 0,
			overtimeMinutes: 0,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: 0,
			unpaidBreakMinutes: 0,
		})
		// Later entries absorb the overtime.
		expect(result.get('e3')!.overtimeMinutes).toBeGreaterThan(0)
		expect(result.get('e0')!.overtimeMinutes).toBe(0)
	})

	it('keeps scopes separate unless the policy aggregates them', () => {
		const a = entry(
			'a',
			'l1',
			at('2026-03-02', '08:00', CHI),
			at('2026-03-02', '16:00', CHI),
		)
		const b = entry(
			'b',
			'l2',
			at('2026-03-02', '16:00', CHI),
			at('2026-03-02', '22:00', CHI),
		)
		const dailyOt = {
			dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
		}
		const separate = computeCachedMinutes(
			[a, b],
			resolve(CHI, { ...dailyOt, aggregateOvertimeAcrossScopes: false }),
		)
		expect(separate.get('b')!.overtimeMinutes).toBe(0)
		const combined = computeCachedMinutes(
			[a, b],
			resolve(CHI, { ...dailyOt, aggregateOvertimeAcrossScopes: true }),
		)
		expect(combined.get('b')!.overtimeMinutes).toBe(6 * 60)
	})

	it('sums a shift that crosses the week boundary over both weeks', () => {
		// Monday week start: Sunday 22:00 to Monday 04:00 belongs to two weeks.
		const e = entry(
			'x',
			'l1',
			at('2026-03-01', '22:00', CHI),
			at('2026-03-02', '04:00', CHI),
		)
		const result = computeCachedMinutes([e], resolve(CHI))
		expect(result.get('x')!.paidMinutes).toBe(6 * 60)
		expect(result.get('x')!.regularMinutes).toBe(6 * 60)
	})

	it('is DST-correct: a night shift over spring-forward is one hour short on the wall clock', () => {
		// 2026-03-08 in Chicago: 02:00 does not exist.
		const e = entry(
			'dst',
			'l1',
			at('2026-03-07', '22:00', CHI),
			at('2026-03-08', '06:00', CHI),
		)
		expect(e.clockOutAt - e.clockInAt).toBe(7 * 60 * MIN)
		expect(
			computeCachedMinutes([e], resolve(CHI)).get('dst')!.paidMinutes,
		).toBe(7 * 60)
	})

	it('is DST-correct on fall-back and in zones without DST', () => {
		const fall = entry(
			'f',
			'l1',
			at('2026-11-01', '00:30', CHI),
			at('2026-11-01', '04:30', CHI),
		)
		expect(
			computeCachedMinutes([fall], resolve(CHI)).get('f')!.paidMinutes,
		).toBe(5 * 60)
		const riyadh = entry(
			'r',
			'l1',
			at('2026-03-07', '22:00', RUH),
			at('2026-03-08', '06:00', RUH),
		)
		expect(
			computeCachedMinutes([riyadh], resolve(RUH)).get('r')!.paidMinutes,
		).toBe(8 * 60)
		const toronto = entry(
			't',
			'l1',
			at('2026-03-07', '22:00', TOR),
			at('2026-03-08', '06:00', TOR),
		)
		expect(
			computeCachedMinutes([toronto], resolve(TOR)).get('t')!.paidMinutes,
		).toBe(7 * 60)
	})

	it('deducts an unpaid break and caches it', () => {
		const start = at('2026-03-02', '09:00', CHI)
		const e = entry('br', 'l1', start, start + 480 * MIN, {
			breaks: [
				{ startAt: start + 240 * MIN, endAt: start + 270 * MIN, paid: false },
			],
		})
		const row = computeCachedMinutes([e], resolve(CHI)).get('br')!
		expect(row.unpaidBreakMinutes).toBe(30)
		expect(row.paidMinutes).toBe(450)
	})
})

describe('computeEntryFigures', () => {
	const resolve =
		(tz: string, patch = {}) =>
		() => ({
			rules: laborPolicyToRules({ ...BUILTIN_LABOR_POLICY, ...patch }),
			timeZone: tz,
		})
	const entry = (
		id: string,
		from: number,
		to: number | null,
		extra: Record<string, unknown> = {},
	) => ({
		id,
		scopeId: 'l1',
		clockInAt: from,
		clockOutAt: to,
		rateMinor: 2000,
		currency: 'USD',
		...extra,
	})

	it('agrees with computeCachedMinutes on every minute figure', () => {
		const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']
		const entries = days.map((d, i) =>
			entry(`e${i}`, at(d, '08:00', CHI), at(d, '19:00', CHI)),
		)
		const patch = {
			weeklyOvertime: { thresholdMinutes: 40 * 60, multiplierBp: 15000 },
			dailyOvertime: { thresholdMinutes: 600, multiplierBp: 15000 },
		}
		const figures = computeEntryFigures(entries, resolve(CHI, patch))
		const cached = computeCachedMinutes(entries, resolve(CHI, patch))
		for (const [id, minutes] of cached) {
			const f = figures.get(id)!
			expect({
				regularMinutes: f.regularMinutes,
				overtimeMinutes: f.overtimeMinutes,
				doubleTimeMinutes: f.doubleTimeMinutes,
				holidayMinutes: f.holidayMinutes,
				paidMinutes: f.paidMinutes,
				unpaidBreakMinutes: f.unpaidBreakMinutes,
			}).toEqual(minutes)
		}
	})

	it('prices each card with its own rate snapshot and the overtime multiplier', () => {
		// 10 hours at 20.00/h with daily overtime after 8 at 1.5x:
		// 8 x 20 + 2 x 30 = 220.00.
		const e = entry(
			'a',
			at('2026-03-02', '08:00', CHI),
			at('2026-03-02', '18:00', CHI),
		)
		const f = computeEntryFigures(
			[e],
			resolve(CHI, {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
			}),
		).get('a')!
		expect(f.costCurrency).toBe('USD')
		expect(f.costUnits / 600_000).toBeCloseTo(22_000, 6)
		expect(f.unpricedMinutes).toBe(0)
	})

	it('does not reprice history when a later card has a higher rate', () => {
		const a = entry(
			'a',
			at('2026-03-02', '08:00', CHI),
			at('2026-03-02', '16:00', CHI),
			{
				rateMinor: 1500,
			},
		)
		const b = entry(
			'b',
			at('2026-03-03', '08:00', CHI),
			at('2026-03-03', '16:00', CHI),
			{
				rateMinor: 2500,
			},
		)
		const f = computeEntryFigures([a, b], resolve(CHI))
		expect(f.get('a')!.costUnits / 600_000).toBeCloseTo(12_000, 6)
		expect(f.get('b')!.costUnits / 600_000).toBeCloseTo(20_000, 6)
	})

	it('leaves unrated cards unpriced instead of costing them at zero', () => {
		const e = entry(
			'a',
			at('2026-03-02', '08:00', CHI),
			at('2026-03-02', '10:00', CHI),
			{
				rateMinor: null,
			},
		)
		const f = computeEntryFigures([e], resolve(CHI)).get('a')!
		expect(f.costUnits).toBe(0)
		expect(f.unpricedMinutes).toBe(120)
		const noCurrency = entry(
			'b',
			at('2026-03-03', '08:00', CHI),
			at('2026-03-03', '09:00', CHI),
			{
				currency: null,
			},
		)
		expect(
			computeEntryFigures([noCurrency], resolve(CHI)).get('b')!.unpricedMinutes,
		).toBe(60)
	})

	it('splits a card that crosses the week boundary and prices both halves', () => {
		const e = entry(
			'x',
			at('2026-03-01', '22:00', CHI),
			at('2026-03-02', '04:00', CHI),
		)
		const f = computeEntryFigures([e], resolve(CHI)).get('x')!
		expect(f.paidMinutes).toBe(360)
		expect(f.costUnits / 600_000).toBeCloseTo(12_000, 6)
	})

	it('measures an open card to now only when a clock is given', () => {
		const e = entry('o', at('2026-03-02', '08:00', CHI), null)
		expect(computeEntryFigures([e], resolve(CHI)).get('o')!.paidMinutes).toBe(0)
		expect(
			computeEntryFigures(
				[e],
				resolve(CHI),
				at('2026-03-02', '10:00', CHI),
			).get('o')!.paidMinutes,
		).toBe(120)
	})
})
