import { describe, expect, it } from 'vitest'
import { NEUTRAL_LABOR_RULES, type LaborRules } from './rules.ts'
import {
	computeTimecard,
	computeWeek,
	roundInstant,
	type TimeEntryInput,
} from './time-math.ts'
import { addDays, parseDate, weekStartFor, zonedLocalToUtc } from './tz.ts'

const CHI = 'America/Chicago'
const TOR = 'America/Toronto'
const RUH = 'Asia/Riyadh'

function at(date: string, hhmm: string, tz: string): number {
	const { year, month, day } = parseDate(date)
	const [h, m] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(year, month, day, h, m, tz)
}

function entry(
	id: string,
	date: string,
	from: string,
	to: string,
	tz: string,
	extra: Partial<TimeEntryInput> = {},
	endDate = date,
): TimeEntryInput {
	return {
		id,
		scopeId: 'loc-1',
		clockInAt: at(date, from, tz),
		clockOutAt: at(endDate, to, tz),
		...extra,
	}
}

const rules = (patch: Partial<LaborRules> = {}): LaborRules => ({
	...NEUTRAL_LABOR_RULES,
	...patch,
})

const OT = { thresholdMinutes: 8 * 60, multiplierBp: 15_000 }
const DT = { thresholdMinutes: 12 * 60, multiplierBp: 20_000 }
const WEEKLY = { thresholdMinutes: 40 * 60, multiplierBp: 15_000 }

describe('roundInstant', () => {
	const nearest = { mode: 'nearest', incrementMinutes: 15 } as const
	const t = (hhmm: string) => at('2026-06-10', hhmm, CHI)
	it('rounds to the nearest increment', () => {
		expect(roundInstant(t('08:07'), nearest, CHI)).toBe(t('08:00'))
		expect(roundInstant(t('08:08'), nearest, CHI)).toBe(t('08:15'))
	})
	it('rounds up and down', () => {
		expect(
			roundInstant(t('08:01'), { mode: 'up', incrementMinutes: 15 }, CHI),
		).toBe(t('08:15'))
		expect(
			roundInstant(t('08:14'), { mode: 'down', incrementMinutes: 15 }, CHI),
		).toBe(t('08:00'))
		expect(
			roundInstant(t('08:15'), { mode: 'up', incrementMinutes: 15 }, CHI),
		).toBe(t('08:15'))
	})
	it('only drops seconds when rounding is off', () => {
		const withSeconds = t('08:07') + 45_000
		expect(
			roundInstant(withSeconds, { mode: 'none', incrementMinutes: 1 }, CHI),
		).toBe(t('08:07'))
	})
	it('rounds on local wall-clock minutes in a half-hour offset zone', () => {
		const ms = at('2026-06-10', '08:07', 'Asia/Kolkata')
		expect(
			roundInstant(
				ms,
				{ mode: 'nearest', incrementMinutes: 15 },
				'Asia/Kolkata',
			),
		).toBe(at('2026-06-10', '08:00', 'Asia/Kolkata'))
	})
})

describe('computeTimecard', () => {
	it('subtracts unpaid breaks and keeps paid breaks', () => {
		const card = computeTimecard(
			entry('e1', '2026-06-10', '09:00', '17:30', CHI, {
				breaks: [
					{
						startAt: at('2026-06-10', '12:00', CHI),
						endAt: at('2026-06-10', '12:30', CHI),
						paid: false,
					},
					{
						startAt: at('2026-06-10', '15:00', CHI),
						endAt: at('2026-06-10', '15:10', CHI),
						paid: true,
					},
				],
			}),
			rules(),
			{ timeZone: CHI },
		)
		expect(card.elapsedMinutes).toBe(510)
		expect(card.unpaidBreakMinutes).toBe(30)
		expect(card.paidBreakMinutes).toBe(10)
		expect(card.workedMinutes).toBe(480)
		expect(card.businessDate).toBe('2026-06-10')
		expect(card.issues).toEqual([])
	})

	it('counts 8 real hours across a spring-forward night', () => {
		// Sat 22:00 to Sun 07:00 on the night clocks skip 02:00-03:00.
		const card = computeTimecard(
			entry('e1', '2026-03-07', '22:00', '07:00', CHI, {}, '2026-03-08'),
			rules(),
			{ timeZone: CHI },
		)
		expect(card.workedMinutes).toBe(8 * 60)
		expect(card.slices.map((s) => [s.date, s.minutes])).toEqual([
			['2026-03-07', 120],
			['2026-03-08', 360],
		])
	})

	it('counts 10 real hours across a fall-back night', () => {
		const card = computeTimecard(
			entry('e1', '2026-10-31', '22:00', '07:00', CHI, {}, '2026-11-01'),
			rules(),
			{ timeZone: CHI },
		)
		expect(card.workedMinutes).toBe(10 * 60)
		expect(card.slices.map((s) => [s.date, s.minutes])).toEqual([
			['2026-10-31', 120],
			['2026-11-01', 480],
		])
	})

	it('splits a shift across midnight into two business dates', () => {
		const card = computeTimecard(
			entry('e1', '2026-06-09', '22:00', '02:00', CHI, {}, '2026-06-10'),
			rules(),
			{ timeZone: CHI },
		)
		expect(card.slices.map((s) => [s.date, s.minutes])).toEqual([
			['2026-06-09', 120],
			['2026-06-10', 120],
		])
	})

	it('keeps a late-night shift on one business date when the workday starts at 4am', () => {
		const card = computeTimecard(
			entry('e1', '2026-06-09', '22:00', '02:00', CHI, {}, '2026-06-10'),
			rules({ workdayStartMinute: 240 }),
			{ timeZone: CHI },
		)
		expect(card.slices.map((s) => [s.date, s.minutes])).toEqual([
			['2026-06-09', 240],
		])
		expect(card.businessDate).toBe('2026-06-09')
	})

	it('handles Riyadh without any DST adjustment', () => {
		const card = computeTimecard(
			entry('e1', '2026-03-28', '22:00', '06:00', RUH, {}, '2026-03-29'),
			rules(),
			{ timeZone: RUH },
		)
		expect(card.workedMinutes).toBe(8 * 60)
	})

	it('applies rounding at calculation time and leaves input punches alone', () => {
		const input = entry('e1', '2026-06-10', '08:07', '17:08', CHI)
		const frozen = JSON.stringify(input)
		const card = computeTimecard(
			input,
			rules({ rounding: { mode: 'nearest', incrementMinutes: 15 } }),
			{ timeZone: CHI },
		)
		expect(card.clockInAt).toBe(at('2026-06-10', '08:00', CHI))
		expect(card.clockOutAt).toBe(at('2026-06-10', '17:15', CHI))
		expect(card.elapsedMinutes).toBe(9 * 60 + 15)
		expect(JSON.stringify(input)).toBe(frozen)
	})

	describe('automatic break deduction', () => {
		const auto = rules({
			autoBreakDeduction: { afterMinutes: 360, deductMinutes: 30 },
		})
		it('deducts when no break was recorded on a long shift', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '17:00', CHI),
				auto,
				{ timeZone: CHI },
			)
			expect(card.workedMinutes).toBe(450)
			expect(card.issues).toContain('auto_break_deducted')
		})
		it('does not deduct on a short shift', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '14:59', CHI),
				auto,
				{ timeZone: CHI },
			)
			expect(card.workedMinutes).toBe(359)
		})
		it('does not deduct when a break was recorded', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '17:00', CHI, {
					breaks: [
						{
							startAt: at('2026-06-10', '12:00', CHI),
							endAt: at('2026-06-10', '12:10', CHI),
							paid: false,
						},
					],
				}),
				auto,
				{ timeZone: CHI },
			)
			expect(card.workedMinutes).toBe(470)
		})
		it('does not deduct when the break is waived', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '17:00', CHI, { breakWaived: true }),
				auto,
				{ timeZone: CHI },
			)
			expect(card.workedMinutes).toBe(480)
		})
	})

	describe('odd input', () => {
		it('reports an open entry as zero without a clock, and counts it with one', () => {
			const open: TimeEntryInput = {
				id: 'e1',
				scopeId: 'loc-1',
				clockInAt: at('2026-06-10', '09:00', CHI),
				clockOutAt: null,
			}
			const noNow = computeTimecard(open, rules(), { timeZone: CHI })
			expect(noNow.workedMinutes).toBe(0)
			expect(noNow.open).toBe(true)
			expect(noNow.issues).toContain('open_entry')
			const withNow = computeTimecard(open, rules(), {
				timeZone: CHI,
				nowMs: at('2026-06-10', '11:30', CHI),
			})
			expect(withNow.workedMinutes).toBe(150)
		})

		it('flags a clock-out before clock-in and counts nothing', () => {
			const card = computeTimecard(
				{
					id: 'e1',
					scopeId: 'l',
					clockInAt: at('2026-06-10', '10:00', CHI),
					clockOutAt: at('2026-06-10', '09:00', CHI),
				},
				rules(),
				{ timeZone: CHI },
			)
			expect(card.workedMinutes).toBe(0)
			expect(card.issues).toContain('negative_duration')
		})

		it('merges overlapping unpaid breaks instead of double counting', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '17:00', CHI, {
					breaks: [
						{
							startAt: at('2026-06-10', '12:00', CHI),
							endAt: at('2026-06-10', '12:30', CHI),
							paid: false,
						},
						{
							startAt: at('2026-06-10', '12:15', CHI),
							endAt: at('2026-06-10', '12:45', CHI),
							paid: false,
						},
					],
				}),
				rules(),
				{ timeZone: CHI },
			)
			expect(card.unpaidBreakMinutes).toBe(45)
			expect(card.workedMinutes).toBe(435)
			expect(card.issues).toContain('overlapping_breaks')
		})

		it('clips a break that sticks out of the entry and flags it', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '17:00', CHI, {
					breaks: [
						{
							startAt: at('2026-06-10', '16:30', CHI),
							endAt: at('2026-06-10', '18:00', CHI),
							paid: false,
						},
					],
				}),
				rules(),
				{ timeZone: CHI },
			)
			expect(card.unpaidBreakMinutes).toBe(30)
			expect(card.issues).toContain('break_outside_entry')
		})

		it('ends an open break at the clock-out and flags it', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '09:00', '17:00', CHI, {
					breaks: [
						{
							startAt: at('2026-06-10', '16:00', CHI),
							endAt: null,
							paid: false,
						},
					],
				}),
				rules(),
				{ timeZone: CHI },
			)
			expect(card.unpaidBreakMinutes).toBe(60)
			expect(card.issues).toContain('open_break')
		})

		it('flags a very long shift', () => {
			const card = computeTimecard(
				entry('e1', '2026-06-10', '06:00', '23:30', CHI),
				rules(),
				{ timeZone: CHI },
			)
			expect(card.issues).toContain('long_shift')
		})
	})
})

describe('computeWeek', () => {
	const SUN = '2026-06-07' // a Sunday
	const MON = '2026-06-01' // a Monday
	const day = (weekStart: string, i: number) => addDays(weekStart, i)

	it('rejects a date that is not the configured week start', () => {
		expect(() =>
			computeWeek([], rules({ weekStartsOn: 0 }), {
				timeZone: CHI,
				weekStartDate: '2026-06-08',
			}),
		).toThrow(RangeError)
	})

	it('computes weekly overtime in minutes and basis points of pay (Riyadh, Sunday week)', () => {
		const entries = Array.from({ length: 6 }, (_, i) =>
			entry(`e${i}`, day(SUN, i), '09:00', '17:00', RUH, {
				rateMinor: 2000,
				currency: 'SAR',
			}),
		)
		const week = computeWeek(
			entries,
			rules({ weekStartsOn: 0, weeklyOvertime: WEEKLY }),
			{
				timeZone: RUH,
				weekStartDate: SUN,
			},
		)
		expect(week.regular).toBe(40 * 60)
		expect(week.overtime).toBe(8 * 60)
		expect(week.total).toBe(48 * 60)
		// 40h x 20.00 + 8h x 20.00 x 1.5 = 800.00 + 240.00
		expect(week.payMinorByCurrency).toEqual({ SAR: 104_000 })
		expect(week.estimate).toBe(true)
		expect(week.weekEndDate).toBe('2026-06-13')
	})

	it('splits a 14 hour day into regular, overtime, and double time', () => {
		const week = computeWeek(
			[
				entry('e1', '2026-06-02', '06:00', '20:00', CHI, {
					rateMinor: 1000,
					currency: 'USD',
				}),
			],
			rules({ dailyOvertime: OT, dailyDoubleTime: DT }),
			{ timeZone: CHI, weekStartDate: MON },
		)
		expect(week.regular).toBe(480)
		expect(week.overtime).toBe(240)
		expect(week.doubleTime).toBe(120)
		// 8h x 10 + 4h x 15 + 2h x 20 = 80 + 60 + 40
		expect(week.payMinorByCurrency).toEqual({ USD: 18_000 })
	})

	it('treats double time with no daily overtime rule as starting at its own threshold', () => {
		const week = computeWeek(
			[entry('e1', '2026-06-02', '06:00', '20:00', CHI)],
			rules({ dailyDoubleTime: DT }),
			{ timeZone: CHI, weekStartDate: MON },
		)
		expect(week.regular).toBe(720)
		expect(week.overtime).toBe(0)
		expect(week.doubleTime).toBe(120)
	})

	it('does not double count minutes already paid as daily overtime toward the weekly limit', () => {
		// Five 10-hour days: 8h regular + 2h daily OT each = exactly 40h regular.
		const five = Array.from({ length: 5 }, (_, i) =>
			entry(`e${i}`, day(MON, i), '08:00', '18:00', CHI),
		)
		const r = rules({ dailyOvertime: OT, weeklyOvertime: WEEKLY })
		const base = computeWeek(five, r, { timeZone: CHI, weekStartDate: MON })
		expect(base.regular).toBe(40 * 60)
		expect(base.overtime).toBe(10 * 60)
		// A sixth 4-hour day is entirely weekly overtime.
		const six = computeWeek(
			[...five, entry('e5', day(MON, 5), '09:00', '13:00', CHI)],
			r,
			{
				timeZone: CHI,
				weekStartDate: MON,
			},
		)
		expect(six.regular).toBe(40 * 60)
		expect(six.overtime).toBe(14 * 60)
	})

	it('excludes holiday hours from overtime and pays the holiday multiplier', () => {
		const monday = MON
		const entries = [
			entry('hol', monday, '09:00', '17:00', CHI, {
				rateMinor: 1000,
				currency: 'USD',
			}),
			...[1, 2, 3, 4].map((i) =>
				entry(`e${i}`, day(MON, i), '08:00', '18:00', CHI, {
					rateMinor: 1000,
					currency: 'USD',
				}),
			),
		]
		const week = computeWeek(
			entries,
			rules({
				dailyOvertime: OT,
				weeklyOvertime: WEEKLY,
				holiday: { dates: [monday], multiplierBp: 20_000 },
			}),
			{ timeZone: CHI, weekStartDate: MON },
		)
		expect(week.holiday).toBe(480)
		// 4 days x (8h regular + 2h OT); holiday hours do not push into weekly OT.
		expect(week.regular).toBe(4 * 480)
		expect(week.overtime).toBe(4 * 120)
		// holiday 8h x 10 x 2 = 160; regular 32h x 10 = 320; OT 8h x 10 x 1.5 = 120
		expect(week.payMinorByCurrency).toEqual({ USD: 60_000 })
	})

	it('gives exempt staff regular minutes only', () => {
		const entries = Array.from({ length: 6 }, (_, i) =>
			entry(`e${i}`, day(MON, i), '07:00', '19:00', CHI, {
				overtimeExempt: true,
			}),
		)
		const week = computeWeek(
			entries,
			rules({ dailyOvertime: OT, weeklyOvertime: WEEKLY }),
			{
				timeZone: CHI,
				weekStartDate: MON,
			},
		)
		expect(week.overtime).toBe(0)
		expect(week.regular).toBe(72 * 60)
	})

	describe('overtime across scopes', () => {
		const entries = [
			...[0, 1, 2].map((i) => ({
				...entry(`a${i}`, day(MON, i), '09:00', '17:00', CHI),
				scopeId: 'A',
			})),
			...[3, 4, 5].map((i) => ({
				...entry(`b${i}`, day(MON, i), '09:00', '17:00', CHI),
				scopeId: 'B',
			})),
		]
		it('evaluates each scope on its own when aggregation is off', () => {
			const week = computeWeek(
				entries,
				rules({
					weeklyOvertime: WEEKLY,
					aggregateOvertimeAcrossScopes: false,
				}),
				{
					timeZone: CHI,
					weekStartDate: MON,
				},
			)
			expect(week.overtime).toBe(0)
			expect(week.total).toBe(48 * 60)
		})
		it('shares thresholds across scopes when aggregation is on', () => {
			const week = computeWeek(
				entries,
				rules({
					weeklyOvertime: WEEKLY,
					aggregateOvertimeAcrossScopes: true,
				}),
				{
					timeZone: CHI,
					weekStartDate: MON,
				},
			)
			expect(week.overtime).toBe(8 * 60)
			expect(week.regular).toBe(40 * 60)
		})
	})

	describe('week boundaries', () => {
		const sat = entry(
			'e1',
			'2026-06-13',
			'22:00',
			'02:00',
			CHI,
			{},
			'2026-06-14',
		)
		it('gives a Saturday-night shift to both Sunday-start weeks', () => {
			const r = rules({ weekStartsOn: 0 })
			const before = computeWeek([sat], r, {
				timeZone: CHI,
				weekStartDate: '2026-06-07',
			})
			const after = computeWeek([sat], r, {
				timeZone: CHI,
				weekStartDate: '2026-06-14',
			})
			expect(before.total).toBe(120)
			expect(before.outsideWeekMinutes).toBe(120)
			expect(after.total).toBe(120)
			expect(after.outsideWeekMinutes).toBe(120)
		})
		it('keeps the same shift in one Monday-start week', () => {
			const r = rules({ weekStartsOn: 1 })
			const week = computeWeek([sat], r, {
				timeZone: CHI,
				weekStartDate: '2026-06-08',
			})
			expect(week.total).toBe(240)
			expect(week.outsideWeekMinutes).toBe(0)
		})
	})

	it('keeps currencies apart and reports unpriced minutes', () => {
		const week = computeWeek(
			[
				entry('a', '2026-06-01', '09:00', '17:00', TOR, {
					rateMinor: 2000,
					currency: 'CAD',
				}),
				entry('b', '2026-06-02', '09:00', '17:00', TOR, {
					rateMinor: 1500,
					currency: 'USD',
				}),
				entry('c', '2026-06-03', '09:00', '17:00', TOR),
			],
			rules(),
			{ timeZone: TOR, weekStartDate: MON },
		)
		expect(week.payMinorByCurrency).toEqual({ CAD: 16_000, USD: 12_000 })
		expect(week.unpricedMinutes).toBe(480)
	})

	it('computes a daylight saving week in the scope timezone', () => {
		// Week of the spring-forward: Sun 2026-03-08 starts a Sunday-start week.
		const week = computeWeek(
			[entry('e1', '2026-03-08', '00:00', '08:00', CHI)],
			rules({ weekStartsOn: 0, dailyOvertime: OT }),
			{ timeZone: CHI, weekStartDate: '2026-03-08' },
		)
		// Midnight to 08:00 only spans 7 real hours on the change day.
		expect(week.total).toBe(7 * 60)
		expect(week.overtime).toBe(0)
	})

	it('holds the bucket invariants for randomized weeks across DST', () => {
		let seed = 12345
		const next = () => {
			seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296
			return seed / 4_294_967_296
		}
		const r = rules({
			weekStartsOn: 0,
			dailyOvertime: OT,
			dailyDoubleTime: DT,
			weeklyOvertime: WEEKLY,
			workdayStartMinute: 180,
			aggregateOvertimeAcrossScopes: true,
			rounding: { mode: 'nearest', incrementMinutes: 5 },
		})
		for (const weekStart of ['2026-03-08', '2026-11-01', '2026-06-07']) {
			for (let run = 0; run < 25; run++) {
				const entries: TimeEntryInput[] = []
				for (let i = 0; i < 9; i++) {
					const start =
						at(day(weekStart, Math.floor(next() * 7)), '00:00', CHI) +
						Math.floor(next() * 24 * 60) * 60_000
					entries.push({
						id: `e${i}`,
						scopeId: next() < 0.5 ? 'A' : 'B',
						clockInAt: start,
						clockOutAt: start + Math.floor(next() * 14 * 60) * 60_000,
						rateMinor: 1000,
						currency: 'USD',
					})
				}
				const week = computeWeek(entries, r, {
					timeZone: CHI,
					weekStartDate: weekStart,
				})
				expect(
					week.regular + week.overtime + week.doubleTime + week.holiday,
				).toBe(week.total)
				for (const d of week.days) {
					expect(d.regular + d.overtime + d.doubleTime + d.holiday).toBe(
						d.total,
					)
					expect(d.regular).toBeGreaterThanOrEqual(0)
					expect(d.overtime).toBeGreaterThanOrEqual(0)
				}
				expect(week.regular).toBeLessThanOrEqual(40 * 60)
				const worked = week.timecards.reduce((s, c) => s + c.workedMinutes, 0)
				expect(week.total + week.outsideWeekMinutes).toBe(worked)
				expect(weekStartFor(weekStart, 0)).toBe(weekStart)
			}
		}
	})
})

describe('computeWeek entry cost', () => {
	it('prices every entry and the entries add up to the week figure', () => {
		const week = computeWeek(
			[
				entry('a', '2026-03-02', '08:00', '16:00', CHI, {
					rateMinor: 1500,
					currency: 'USD',
				}),
				entry('b', '2026-03-03', '08:00', '18:00', CHI, {
					rateMinor: 2000,
					currency: 'USD',
				}),
				entry('c', '2026-03-04', '08:00', '10:00', CHI, {
					rateMinor: null,
					currency: 'USD',
				}),
			],
			rules({ dailyOvertime: OT }),
			{ timeZone: CHI, weekStartDate: '2026-03-02' },
		)
		expect(week.entryCost.a).toEqual({
			units: 1500 * 480 * 10_000,
			currency: 'USD',
			unpricedMinutes: 0,
		})
		// 8h regular + 2h at 1.5x for 20.00/h.
		expect(week.entryCost.b!.units / 600_000).toBeCloseTo(22_000, 6)
		expect(week.entryCost.c).toEqual({
			units: 0,
			currency: 'USD',
			unpricedMinutes: 120,
		})
		const sum = Object.values(week.entryCost).reduce((s, c) => s + c.units, 0)
		expect(Math.round(sum / 600_000)).toBe(week.payMinorByCurrency.USD)
		expect(week.unpricedMinutes).toBe(120)
	})
})
