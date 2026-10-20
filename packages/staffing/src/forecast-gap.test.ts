import { describe, expect, it } from 'vitest'
import {
	computeForecastGap,
	type ForecastShiftFact,
	GAP_OVER_THRESHOLD,
	GAP_SHORT_THRESHOLD,
	neededPeople,
	scheduledByHour,
	slotStatus,
} from './forecast-gap.ts'
import { type DemandGuide } from './schedule-api.ts'
import { weekDates } from './schedule-estimate.ts'
import { zonedLocalToUtc } from './tz.ts'

const CHI = 'America/Chicago'

function at(date: string, hhmm: string, tz = CHI): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number]
	const [h, min] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(y, m, d, h, min, tz)
}

function guideFor(
	start: string,
	hours: Record<string, Record<number, number>> = {},
): DemandGuide {
	return {
		kind: 'guide',
		estimate: true,
		source: 'online_orders',
		statistic: 'median',
		weeks: 8,
		windowStart: '2026-01-12',
		windowEnd: '2026-03-08',
		daysWithOrders: 40,
		timeZone: CHI,
		days: weekDates(start).map((date, i) => ({
			date,
			weekday: (i + 1) % 7,
			hours: Array.from({ length: 24 }, (_, h) => hours[date]?.[h] ?? 0),
			totalOrders: 0,
		})),
	}
}

const shift = (
	staffId: string | null,
	positionId: string | null,
	date: string,
	from: string,
	to: string,
	unpaidBreakMinutes = 0,
): ForecastShiftFact => ({
	staffId,
	positionId,
	startsAt: at(date, from),
	endsAt: at(date, to),
	unpaidBreakMinutes,
})

describe('neededPeople', () => {
	it('rounds up to whole people and is zero without orders', () => {
		expect(neededPeople(25, 10)).toBe(3)
		expect(neededPeople(40, 10)).toBe(4)
		expect(neededPeople(8, 10)).toBe(1)
		expect(neededPeople(0, 10)).toBe(0)
		expect(neededPeople(5, 0)).toBe(0)
	})
	it('does not round up an exact quotient hit by float noise', () => {
		expect(neededPeople(3.6, 1.2)).toBe(3)
		expect(neededPeople(0.3, 0.1)).toBe(3)
	})
})

describe('slotStatus', () => {
	const base = { orders: 5, needed: 1, scheduled: 1, short: 0, surplus: 0 }
	it('flags a shortfall of at least half a person', () => {
		expect(slotStatus({ ...base, short: GAP_SHORT_THRESHOLD })).toBe('short')
		expect(slotStatus({ ...base, short: GAP_SHORT_THRESHOLD - 0.01 })).toBe(
			'ok',
		)
	})
	it('flags a surplus of a whole person only when nothing is short', () => {
		expect(slotStatus({ ...base, surplus: GAP_OVER_THRESHOLD })).toBe('over')
		expect(slotStatus({ ...base, surplus: GAP_OVER_THRESHOLD, short: 1 })).toBe(
			'short',
		)
	})
	it('calls an empty hour quiet', () => {
		expect(
			slotStatus({ orders: 0, needed: 0, scheduled: 0, short: 0, surplus: 0 }),
		).toBe('quiet')
	})
})

describe('scheduledByHour', () => {
	it('splits a shift across the hours it touches by real time', () => {
		const { byHour } = scheduledByHour(
			[shift('a', 'cook', '2026-03-09', '10:30', '12:15')],
			CHI,
			new Set(['2026-03-09']),
		)
		const hour = (h: number) => byHour.get(`2026-03-09#${h}`)?.get('cook') ?? 0
		expect(hour(10)).toBeCloseTo(0.5)
		expect(hour(11)).toBeCloseTo(1)
		expect(hour(12)).toBeCloseTo(0.25)
		expect(hour(9)).toBe(0)
	})

	it('puts the minutes of a shift that starts mid-quarter in the hour they fall in', () => {
		const { byHour } = scheduledByHour(
			[shift('a', 'cook', '2026-03-09', '10:50', '11:10')],
			CHI,
			new Set(['2026-03-09']),
		)
		expect(byHour.get('2026-03-09#10')!.get('cook')!).toBeCloseTo(10 / 60)
		expect(byHour.get('2026-03-09#11')!.get('cook')!).toBeCloseTo(10 / 60)
	})

	it('spreads an unpaid break over the shift', () => {
		const { byHour } = scheduledByHour(
			[shift('a', 'cook', '2026-03-09', '10:00', '12:00', 30)],
			CHI,
			new Set(['2026-03-09']),
		)
		// 90 paid minutes over 120: each hour counts 0.75 of a person.
		expect(byHour.get('2026-03-09#10')!.get('cook')!).toBeCloseTo(0.75)
		expect(byHour.get('2026-03-09#11')!.get('cook')!).toBeCloseTo(0.75)
	})

	it('counts real hours on the day clocks spring forward (no 02:00 hour)', () => {
		const { byHour } = scheduledByHour(
			[
				{
					staffId: 'a',
					positionId: 'cook',
					startsAt: at('2026-03-08', '00:00'),
					endsAt: at('2026-03-08', '05:00'),
					unpaidBreakMinutes: 0,
				},
			],
			CHI,
			new Set(['2026-03-08']),
		)
		const hours = [...byHour.keys()]
			.map((k) => Number(k.split('#')[1]))
			.sort((a, b) => a - b)
		expect(hours).toEqual([0, 1, 3, 4])
		const total = [...byHour.values()].reduce(
			(s, m) => s + (m.get('cook') ?? 0),
			0,
		)
		expect(total).toBeCloseTo(4)
	})

	it('puts the minutes after midnight on the next date and ignores dates outside the week', () => {
		const { byHour } = scheduledByHour(
			[
				shift('a', 'cook', '2026-03-09', '22:00', '23:59'),
				{
					staffId: 'a',
					positionId: 'cook',
					startsAt: at('2026-03-09', '23:00'),
					endsAt: at('2026-03-10', '02:00'),
					unpaidBreakMinutes: 0,
				},
			],
			CHI,
			new Set(['2026-03-10']),
		)
		expect([...byHour.keys()].every((k) => k.startsWith('2026-03-10#'))).toBe(
			true,
		)
		expect(byHour.get('2026-03-10#1')!.get('cook')!).toBeCloseTo(1)
	})

	it('skips open shifts and reports positionless shifts apart', () => {
		const { byHour, unpositioned } = scheduledByHour(
			[
				shift(null, 'cook', '2026-03-09', '10:00', '12:00'),
				shift('a', null, '2026-03-09', '10:00', '12:00'),
			],
			CHI,
			new Set(['2026-03-09']),
		)
		expect(byHour.size).toBe(0)
		expect(unpositioned.get('2026-03-09')!).toBeCloseTo(2)
	})
})

describe('computeForecastGap: a hand-calculated Monday', () => {
	// Standard: one cook handles 10 orders an hour.
	// Median orders: 11:00 25, 12:00 40, 13:00 8, 14:00 0 (12 are already booked for 14:00).
	// Needed cooks:  3,       4,        1,       2 (booked 12 -> ceil 1.2).
	// Scheduled:     A 11-14, B 11:30-13:30, C 12-13 =>
	//   11:00 1.5   12:00 3   13:00 1.5   14:00 0
	const monday = '2026-03-09'
	const view = computeForecastGap({
		guide: guideFor(monday, { [monday]: { 11: 25, 12: 40, 13: 8, 14: 0 } }),
		booked: [{ date: monday, hour: 14, orders: 12 }],
		standards: { cook: 10 },
		shifts: [
			shift('a', 'cook', monday, '11:00', '14:00'),
			shift('b', 'cook', monday, '11:30', '13:30'),
			shift('c', 'cook', monday, '12:00', '13:00'),
			shift(null, 'cook', monday, '11:00', '15:00'),
			shift('d', 'server', monday, '11:00', '15:00'),
			shift('e', null, monday, '11:00', '13:00'),
		],
		timeZone: CHI,
	})
	const day = view.days[0]!
	const slot = (h: number) => day.hours[h]!

	it('needs ceil(orders / standard) people and counts scheduled people by the hour', () => {
		expect(slot(11)).toMatchObject({
			orders: 25,
			needed: 3,
			scheduled: 1.5,
			short: 1.5,
			surplus: 0,
			status: 'short',
		})
		expect(slot(12)).toMatchObject({
			orders: 40,
			needed: 4,
			scheduled: 3,
			short: 1,
			status: 'short',
		})
		expect(slot(13)).toMatchObject({
			orders: 8,
			needed: 1,
			scheduled: 1.5,
			short: 0,
			surplus: 0.5,
			status: 'ok',
		})
	})

	it('never forecasts fewer orders than are already booked', () => {
		expect(slot(14)).toMatchObject({
			orders: 12,
			booked: 12,
			needed: 2,
			scheduled: 0,
			short: 2,
			status: 'short',
		})
		// Booked orders below the median change nothing.
		expect(slot(12).booked).toBe(0)
	})

	it('totals the day and each position, leaving positions without a standard out', () => {
		expect(day).toMatchObject({
			neededHours: 10,
			scheduledHours: 6,
			shortHours: 4.5,
			surplusHours: 0.5,
		})
		expect(day.byPosition).toEqual([
			{
				positionId: 'cook',
				ordersPerLaborHour: 10,
				neededHours: 10,
				scheduledHours: 6,
			},
		])
		// The server and the positionless cashier are not in the cook figures.
		expect(day.unpositionedHours).toBe(2)
	})

	it('describes the method honestly', () => {
		expect(view).toMatchObject({
			kind: 'forecast_gap',
			estimate: true,
			method: 'median_orders_per_labor_hour',
			source: 'online_orders',
			configured: true,
			timeZone: CHI,
		})
		expect(view.days).toHaveLength(7)
	})
})

describe('computeForecastGap: positions are compared one by one', () => {
	it('does not let a surplus in one position hide a shortage in another', () => {
		const date = '2026-03-09'
		const view = computeForecastGap({
			guide: guideFor(date, { [date]: { 12: 20 } }),
			booked: [],
			standards: { cook: 10, cashier: 20 },
			shifts: [
				shift('a', 'cook', date, '12:00', '13:00'),
				shift('b', 'cook', date, '12:00', '13:00'),
				shift('c', 'cook', date, '12:00', '13:00'),
			],
			timeZone: CHI,
		})
		// Cooks: need 2, have 3 (surplus 1). Cashier: need 1, have 0 (short 1).
		expect(view.days[0]!.hours[12]).toMatchObject({
			needed: 3,
			scheduled: 3,
			short: 1,
			surplus: 1,
			status: 'short',
		})
	})
})

describe('computeForecastGap: nothing configured', () => {
	it('compares nothing and says so', () => {
		const view = computeForecastGap({
			guide: guideFor('2026-03-09', { '2026-03-09': { 12: 20 } }),
			booked: [],
			standards: {},
			shifts: [shift('a', 'cook', '2026-03-09', '12:00', '13:00')],
			timeZone: CHI,
		})
		expect(view.configured).toBe(false)
		expect(
			view.days[0]!.hours.every((h) => h.status === 'quiet' && h.needed === 0),
		).toBe(true)
		expect(view.days[0]!.hours[12]!.orders).toBe(20)
	})
})

describe('computeForecastGap: determinism', () => {
	it('gives identical output for the same inputs in any shift order', () => {
		const date = '2026-03-09'
		const shifts = [
			shift('a', 'cook', date, '11:00', '14:00'),
			shift('b', 'cook', date, '11:30', '13:30'),
			shift('c', 'cook', date, '12:00', '13:00'),
		]
		const run = (list: ForecastShiftFact[]) =>
			computeForecastGap({
				guide: guideFor(date, { [date]: { 11: 25, 12: 40 } }),
				booked: [],
				standards: { cook: 10 },
				shifts: list,
				timeZone: CHI,
			})
		expect(run(shifts)).toEqual(run([...shifts].reverse()))
	})
})
