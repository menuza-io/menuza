import { describe, expect, it } from 'vitest'
import { type LaborRules, NEUTRAL_LABOR_RULES } from './rules.ts'
import {
	allocatePaidMinutesByDay,
	estimatePerShift,
	estimateWeek,
	type EstimateShift,
	overtimeMinutesByShift,
	paidMinutesOf,
	planningRules,
	shiftToEntry,
	weekDates,
	weeksTouched,
} from './schedule-estimate.ts'
import { minuteOfDayFromHhmm, resolveShiftWindow } from './schedule-time.ts'

const CHI = 'America/Chicago'
const RIYADH = 'Asia/Riyadh'

function shift(
	id: string,
	date: string,
	start: string,
	end: string,
	overrides: Partial<EstimateShift> = {},
	tz = CHI,
): EstimateShift {
	const result = resolveShiftWindow({
		date,
		startMinute: minuteOfDayFromHhmm(start),
		endMinute: minuteOfDayFromHhmm(end),
		timeZone: tz,
	})
	if (!result.ok) throw new Error('bad fixture')
	return {
		id,
		scopeId: 'loc-1',
		startsAt: result.window.startsAt,
		endsAt: result.window.endsAt,
		unpaidBreakMinutes: 0,
		...overrides,
	}
}

const WEEKLY_40: LaborRules = {
	...NEUTRAL_LABOR_RULES,
	weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
}

describe('planningRules', () => {
	it('drops rounding, the automatic break deduction and the long-shift flag', () => {
		const rules = planningRules({
			...NEUTRAL_LABOR_RULES,
			rounding: { mode: 'nearest', incrementMinutes: 15 },
			autoBreakDeduction: { afterMinutes: 360, deductMinutes: 30 },
			dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
		})
		expect(rules.rounding).toEqual({ mode: 'none', incrementMinutes: 1 })
		expect(rules.autoBreakDeduction).toBeNull()
		expect(rules.dailyOvertime).toEqual({
			thresholdMinutes: 480,
			multiplierBp: 15000,
		})
	})
})

describe('shiftToEntry and paidMinutesOf', () => {
	it('places the unpaid break in the middle of the shift', () => {
		const s = shift('a', '2026-03-02', '09:00', '17:00', {
			unpaidBreakMinutes: 30,
		})
		const entry = shiftToEntry(s)
		expect(entry.breaks).toHaveLength(1)
		const [brk] = entry.breaks!
		expect(brk!.paid).toBe(false)
		expect(brk!.endAt! - brk!.startAt).toBe(30 * 60_000)
		expect(brk!.startAt - s.startsAt).toBe(225 * 60_000)
		expect(paidMinutesOf(s)).toBe(450)
	})

	it('never lets a break exceed the shift', () => {
		const s = shift('a', '2026-03-02', '09:00', '10:00', {
			unpaidBreakMinutes: 120,
		})
		expect(paidMinutesOf(s)).toBe(0)
		const [brk] = shiftToEntry(s).breaks!
		expect(brk!.endAt! - brk!.startAt).toBe(60 * 60_000)
	})

	it('has no break entry for a shift without one', () => {
		expect(
			shiftToEntry(shift('a', '2026-03-02', '09:00', '17:00')).breaks,
		).toEqual([])
	})
})

describe('estimateWeek', () => {
	it('adds up paid minutes and prices them at the shift rate', () => {
		const summary = estimateWeek(
			[
				shift('a', '2026-03-02', '09:00', '17:00', {
					rateMinor: 2000,
					currency: 'USD',
					unpaidBreakMinutes: 30,
				}),
				shift('b', '2026-03-03', '09:00', '13:00', {
					rateMinor: 2000,
					currency: 'USD',
				}),
			],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-03-02',
		)
		expect(summary.estimate).toBe(true)
		expect(summary.total).toBe(450 + 240)
		// 11.5 hours at $20.00.
		expect(summary.payMinorByCurrency).toEqual({ USD: 23_000 })
	})

	it('prices overtime with the policy multiplier', () => {
		const shifts = ['02', '03', '04', '05', '06', '07'].map((d) =>
			shift(`s${d}`, `2026-03-${d}`, '09:00', '17:00', {
				rateMinor: 1000,
				currency: 'USD',
			}),
		)
		const summary = estimateWeek(shifts, WEEKLY_40, CHI, '2026-03-02')
		expect(summary.total).toBe(2880)
		expect(summary.overtime).toBe(480)
		// 40h at $10 plus 8h at $15.
		expect(summary.payMinorByCurrency).toEqual({ USD: 40_000 + 12_000 })
	})

	it('does not price a shift with no rate and counts its minutes as unpriced', () => {
		const summary = estimateWeek(
			[shift('a', '2026-03-02', '09:00', '17:00')],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-03-02',
		)
		expect(summary.payMinorByCurrency).toEqual({})
		expect(summary.unpricedMinutes).toBe(480)
	})

	it('never adds money across currencies', () => {
		const summary = estimateWeek(
			[
				shift('a', '2026-03-02', '09:00', '17:00', {
					rateMinor: 2000,
					currency: 'USD',
				}),
				shift('b', '2026-03-03', '09:00', '17:00', {
					rateMinor: 5000,
					currency: 'SAR',
				}),
			],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-03-02',
		)
		expect(summary.payMinorByCurrency).toEqual({ USD: 16_000, SAR: 40_000 })
	})

	it('splits a shift at the week boundary: only the in-week part counts', () => {
		// Sunday 22:00 to Monday 06:00, Monday-start week: 2h Sunday, 6h Monday.
		const spill = shift('spill', '2026-03-01', '22:00', '06:00')
		const thisWeek = estimateWeek(
			[spill],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-03-02',
		)
		expect(thisWeek.total).toBe(360)
		expect(thisWeek.outsideWeekMinutes).toBe(120)
		const lastWeek = estimateWeek(
			[spill],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-02-23',
		)
		expect(lastWeek.total).toBe(120)
		expect(thisWeek.days.map((d) => [d.date, d.total]).slice(0, 2)).toEqual([
			['2026-03-02', 360],
			['2026-03-03', 0],
		])
	})

	it('measures the spring-forward night by real hours', () => {
		const night = shift('night', '2026-03-07', '22:00', '06:00')
		const summary = estimateWeek(
			[night],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-03-02',
		)
		expect(summary.total).toBe(7 * 60)
		expect(summary.days.find((d) => d.date === '2026-03-07')!.total).toBe(120)
		expect(summary.days.find((d) => d.date === '2026-03-08')!.total).toBe(300)
	})

	it('measures the fall-back night by real hours', () => {
		const night = shift('night', '2026-10-31', '22:00', '06:00')
		const summary = estimateWeek(
			[night],
			NEUTRAL_LABOR_RULES,
			CHI,
			'2026-10-26',
		)
		expect(summary.total).toBe(9 * 60)
	})

	it('is a flat 8 hours in Riyadh across the same dates', () => {
		const night = shift('night', '2026-03-07', '22:00', '06:00', {}, RIYADH)
		const summary = estimateWeek(
			[night],
			NEUTRAL_LABOR_RULES,
			RIYADH,
			'2026-03-02',
		)
		expect(summary.total).toBe(480)
	})

	it('honors a Sunday week start', () => {
		const rules: LaborRules = { ...NEUTRAL_LABOR_RULES, weekStartsOn: 0 }
		const summary = estimateWeek(
			[shift('sun', '2026-03-01', '09:00', '17:00')],
			rules,
			CHI,
			'2026-03-01',
		)
		expect(summary.total).toBe(480)
		expect(summary.weekEndDate).toBe('2026-03-07')
		expect(() => estimateWeek([], rules, CHI, '2026-03-02')).toThrow(RangeError)
	})
})

describe('weeksTouched and overtimeMinutesByShift', () => {
	it('lists the week of the start and of the end, once each', () => {
		const spill = shift('spill', '2026-03-01', '22:00', '06:00')
		expect(weeksTouched([spill], NEUTRAL_LABOR_RULES, CHI)).toEqual([
			'2026-02-23',
			'2026-03-02',
		])
		const plain = shift('plain', '2026-03-03', '09:00', '17:00')
		expect(weeksTouched([plain], NEUTRAL_LABOR_RULES, CHI)).toEqual([
			'2026-03-02',
		])
	})

	it('reports overtime only for the shifts that carry it, summed over weeks', () => {
		const shifts = ['02', '03', '04', '05', '06'].map((d) =>
			shift(`s${d}`, `2026-03-${d}`, '09:00', '17:00'),
		)
		shifts.push(shift('extra', '2026-03-07', '09:00', '12:00'))
		const result = overtimeMinutesByShift(shifts, WEEKLY_40, CHI)
		expect([...result]).toEqual([['extra', 180]])
		expect(overtimeMinutesByShift([], WEEKLY_40, CHI).size).toBe(0)
	})

	it('lists the seven dates of a week', () => {
		expect(weekDates('2026-03-02')).toEqual([
			'2026-03-02',
			'2026-03-03',
			'2026-03-04',
			'2026-03-05',
			'2026-03-06',
			'2026-03-07',
			'2026-03-08',
		])
	})
})

describe('estimatePerShift', () => {
	it('gives each shift its overtime share and its cost in cost units', () => {
		const shifts = [
			shift('a', '2026-03-02', '08:00', '18:00', {
				rateMinor: 2000,
				currency: 'USD',
			}),
			shift('b', '2026-03-03', '08:00', '18:00', {
				rateMinor: 2000,
				currency: 'USD',
			}),
			shift('c', '2026-03-04', '08:00', '18:00', {
				rateMinor: 2000,
				currency: 'USD',
			}),
			shift('d', '2026-03-05', '08:00', '18:00', {
				rateMinor: 2000,
				currency: 'USD',
			}),
			shift('e', '2026-03-06', '08:00', '18:00', {
				rateMinor: 2000,
				currency: 'USD',
			}),
		]
		const out = estimatePerShift(shifts, WEEKLY_40, CHI)
		// 50 hours: the last shift carries the 10 overtime hours.
		expect(out.get('e')!.overtimeMinutes).toBe(600)
		expect(out.get('a')!.overtimeMinutes).toBe(0)
		// 600 min x 2000/h = 20000 minor regular; the overtime shift costs 1.5x.
		expect(Math.round(out.get('a')!.costUnitsByCurrency.USD! / 600_000)).toBe(
			20000,
		)
		expect(Math.round(out.get('e')!.costUnitsByCurrency.USD! / 600_000)).toBe(
			30000,
		)
	})

	it('reports a shift without a rate as unpriced minutes', () => {
		const out = estimatePerShift(
			[shift('a', '2026-03-02', '09:00', '17:00')],
			NEUTRAL_LABOR_RULES,
			CHI,
		)
		expect(out.get('a')).toEqual({
			overtimeMinutes: 0,
			costUnitsByCurrency: {},
			unpricedMinutes: 480,
		})
	})

	it('is empty for no shifts', () => {
		expect(estimatePerShift([], NEUTRAL_LABOR_RULES, CHI).size).toBe(0)
	})
})

describe('allocatePaidMinutesByDay', () => {
	it('keeps a day shift on one date and takes the break out', () => {
		const s = shift('a', '2026-03-02', '09:00', '17:00', {
			unpaidBreakMinutes: 30,
		})
		expect(allocatePaidMinutesByDay(s, CHI)).toEqual([
			{ date: '2026-03-02', minutes: 450 },
		])
	})

	it('splits an overnight shift at local midnight and always adds up', () => {
		const s = shift('a', '2026-03-02', '22:00', '03:00', {
			unpaidBreakMinutes: 31,
		})
		const out = allocatePaidMinutesByDay(s, CHI)
		expect(out.map((p) => p.date)).toEqual(['2026-03-02', '2026-03-03'])
		expect(out.reduce((sum, p) => sum + p.minutes, 0)).toBe(300 - 31)
	})

	it('measures real time across a spring-forward night', () => {
		// 2026-03-08 02:00 does not exist in Chicago: 22:00 to 06:00 is 7 hours.
		const s = shift('a', '2026-03-07', '22:00', '06:00')
		const out = allocatePaidMinutesByDay(s, CHI)
		expect(out.reduce((sum, p) => sum + p.minutes, 0)).toBe(420)
		expect(out[0]).toEqual({ date: '2026-03-07', minutes: 120 })
		expect(out[1]).toEqual({ date: '2026-03-08', minutes: 300 })
	})

	it('is empty for a shift that is all break', () => {
		const s = shift('a', '2026-03-02', '09:00', '10:00', {
			unpaidBreakMinutes: 60,
		})
		expect(allocatePaidMinutesByDay(s, CHI)).toEqual([])
	})
})
