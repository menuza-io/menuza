import { describe, expect, it } from 'vitest'
import {
	computeDemandGuide,
	computeLaborTarget,
	DEMAND_BUCKET_SECONDS,
	type DemandBucket,
	demandWindow,
	demandWindowSeconds,
	manualSalesGuide,
	medianOf,
} from './schedule-demand.ts'
import { weekDates } from './schedule-estimate.ts'
import { zonedLocalToUtc } from './tz.ts'

const CHI = 'America/Chicago'
const RIYADH = 'Asia/Riyadh'

/** The bucket index of a local time. */
function bucketAt(date: string, hhmm: string, tz: string): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number]
	const [h, min] = hhmm.split(':').map(Number) as [number, number]
	return Math.floor(
		zonedLocalToUtc(y, m, d, h, min, tz) / 1000 / DEMAND_BUCKET_SECONDS,
	)
}

function bucket(
	date: string,
	hhmm: string,
	orders: number,
	salesMinor = orders * 2000,
	tz = CHI,
	currency = 'USD',
): DemandBucket {
	return { bucket: bucketAt(date, hhmm, tz), currency, orders, salesMinor }
}

describe('medianOf', () => {
	it('takes the middle value, or the mean of the two middle values', () => {
		expect(medianOf([])).toBe(0)
		expect(medianOf([5])).toBe(5)
		expect(medianOf([3, 1, 2])).toBe(2)
		expect(medianOf([4, 1, 3, 2])).toBe(2.5)
		expect(medianOf([0, 0, 0, 0, 0, 0, 10, 10])).toBe(0)
	})
	it('does not reorder its input', () => {
		const values = [3, 1, 2]
		medianOf(values)
		expect(values).toEqual([3, 1, 2])
	})
})

describe('demandWindow', () => {
	it('is the eight weeks before the anchor, as 56 dates', () => {
		const w = demandWindow('2026-03-09')
		expect(w.startDate).toBe('2026-01-12')
		expect(w.endDate).toBe('2026-03-08')
		expect(w.dates).toHaveLength(56)
		expect(w.dates[0]).toBe('2026-01-12')
		expect(w.dates[55]).toBe('2026-03-08')
	})
	it('bounds the orders query by local midnights', () => {
		const { fromSeconds, toSeconds } = demandWindowSeconds('2026-03-09', CHI)
		expect(fromSeconds).toBe(zonedLocalToUtc(2026, 1, 12, 0, 0, CHI) / 1000)
		expect(toSeconds).toBe(zonedLocalToUtc(2026, 3, 9, 0, 0, CHI) / 1000)
	})
})

describe('computeDemandGuide', () => {
	const week = weekDates('2026-03-09') // Monday
	function guide(buckets: DemandBucket[], tz = CHI, includeSales = false) {
		return computeDemandGuide({
			buckets,
			weekDates: week,
			anchorDate: '2026-03-09',
			timeZone: tz,
			includeSales,
		})
	}

	it('labels itself a guide from online orders, never a forecast', () => {
		const g = guide([])
		expect(g).toMatchObject({
			kind: 'guide',
			estimate: true,
			source: 'online_orders',
			statistic: 'median',
			weeks: 8,
			windowStart: '2026-01-12',
			windowEnd: '2026-03-08',
			daysWithOrders: 0,
			timeZone: CHI,
		})
		expect(g.days).toHaveLength(7)
		expect(g.days[0]!.hours).toEqual(new Array(24).fill(0))
		expect(g.days[0]!.totalOrders).toBe(0)
	})

	it('takes the median over the same weekday of each trailing week', () => {
		// Eight Mondays at noon: 1,2,3,4,5,6,7,8 orders. Median is 4.5.
		const mondays = [
			'2026-01-12',
			'2026-01-19',
			'2026-01-26',
			'2026-02-02',
			'2026-02-09',
			'2026-02-16',
			'2026-02-23',
			'2026-03-02',
		]
		const buckets = mondays.map((d, i) => bucket(d, '12:00', i + 1))
		const g = guide(buckets)
		expect(g.days[0]).toMatchObject({ date: '2026-03-09', weekday: 1 })
		expect(g.days[0]!.hours[12]).toBe(4.5)
		expect(g.days[1]!.hours[12]).toBe(0) // Tuesday has no orders
		expect(g.daysWithOrders).toBe(8)
	})

	it('ignores orders outside the window and the week being planned', () => {
		const g = guide([
			bucket('2026-01-05', '12:00', 50),
			bucket('2026-03-09', '12:00', 50),
			bucket('2026-03-02', '12:00', 3),
		])
		expect(g.days[0]!.hours[12]).toBe(0) // one Monday in eight is not the median
		expect(g.daysWithOrders).toBe(1)
	})

	it('adds the buckets of one hour together, in any order', () => {
		const sameHour = ['12:00', '12:15', '12:30', '12:45'].map((t) =>
			bucket('2026-03-02', t, 1),
		)
		const g = guide(sameHour.reverse())
		expect(g.days[0]!.hours[12]).toBe(0) // still one Monday of eight
		const many = [
			'2026-01-12',
			'2026-01-19',
			'2026-01-26',
			'2026-02-02',
		].flatMap((d) => ['12:00', '12:45'].map((t) => bucket(d, t, 2)))
		expect(guide(many).days[0]!.hours[12]).toBe(2) // 4 of 8 Mondays have 4 orders: median (0+4)/2
	})

	it('reports hours in the scope zone, not UTC', () => {
		const buckets = [
			'2026-01-12',
			'2026-01-19',
			'2026-01-26',
			'2026-02-02',
			'2026-02-09',
		].map((d) => bucket(d, '19:00', 6, undefined, RIYADH))
		const g = computeDemandGuide({
			buckets,
			weekDates: week,
			anchorDate: '2026-03-09',
			timeZone: RIYADH,
			includeSales: false,
		})
		expect(g.days[0]!.hours[19]).toBe(6)
		expect(g.days[0]!.hours[16]).toBe(0) // 19:00 Riyadh is 16:00 UTC
	})

	it('puts late-night orders on the local day they were placed', () => {
		const buckets = [
			'2026-01-12',
			'2026-01-19',
			'2026-01-26',
			'2026-02-02',
			'2026-02-09',
		].map((d) => bucket(d, '23:45', 3))
		const g = guide(buckets)
		expect(g.days[0]!.hours[23]).toBe(3)
		expect(g.days[1]!.hours[23]).toBe(0)
	})

	it('shows the daylight saving shift: the same wall hour on both sides', () => {
		// Fridays on both sides of 2026-03-08 at 18:00 local.
		const fridays = [
			'2026-01-16',
			'2026-01-23',
			'2026-01-30',
			'2026-02-06',
			'2026-02-13',
			'2026-02-20',
			'2026-02-27',
			'2026-03-06',
		]
		const g = guide(fridays.map((d) => bucket(d, '18:00', 5)))
		expect(g.days[4]).toMatchObject({ date: '2026-03-13', weekday: 5 })
		expect(g.days[4]!.hours[18]).toBe(5)
	})

	it('leaves money out unless asked, and keeps currencies apart', () => {
		const mondays = [
			'2026-01-12',
			'2026-01-19',
			'2026-01-26',
			'2026-02-02',
			'2026-02-09',
		]
		const buckets = [
			...mondays.map((d) => bucket(d, '12:00', 2, 4000)),
			...mondays.map((d) => bucket(d, '13:00', 1, 9000, CHI, 'SAR')),
		]
		const without = guide(buckets)
		expect(without.days[0]!.salesMinorByCurrency).toBeUndefined()
		const withSales = guide(buckets, CHI, true)
		expect(withSales.days[0]!.salesMinorByCurrency).toEqual({
			SAR: 9000,
			USD: 4000,
		})
	})

	it('is the same on every run', () => {
		const buckets = ['2026-01-12', '2026-02-09', '2026-03-02'].map((d, i) =>
			bucket(d, '12:00', i + 1),
		)
		expect(guide(buckets)).toEqual(guide([...buckets].reverse()))
	})
})

describe('computeLaborTarget', () => {
	it('compares cost with guide sales per currency, never across them', () => {
		const target = computeLaborTarget({
			salesSource: 'online_orders',
			targetBp: 3000,
			costMinorByCurrency: { USD: 150_000, SAR: 10_000 },
			guideSalesMinorByCurrency: { USD: 600_000 },
		})
		expect(target.salesSource).toBe('online_orders')
		expect(target.targetBp).toBe(3000)
		expect(target.currencies).toEqual([
			{
				currency: 'SAR',
				costMinor: 10_000,
				guideSalesMinor: 0,
				laborBp: null,
				allowedCostMinor: null,
			},
			{
				currency: 'USD',
				costMinor: 150_000,
				guideSalesMinor: 600_000,
				laborBp: 2500,
				allowedCostMinor: 180_000,
			},
		])
	})

	it('shows no allowance without a target', () => {
		const target = computeLaborTarget({
			targetBp: null,
			costMinorByCurrency: { USD: 100 },
			guideSalesMinorByCurrency: { USD: 1000 },
		})
		expect(target.currencies[0]).toMatchObject({
			laborBp: 1000,
			allowedCostMinor: null,
		})
	})

	it('lists sales even when nothing is scheduled', () => {
		const target = computeLaborTarget({
			salesSource: 'online_orders',
			targetBp: 3000,
			costMinorByCurrency: {},
			guideSalesMinorByCurrency: { USD: 1000 },
		})
		expect(target.currencies).toEqual([
			{
				currency: 'USD',
				costMinor: 0,
				guideSalesMinor: 1000,
				laborBp: 0,
				allowedCostMinor: 300,
			},
		])
	})
})

describe('computeLaborTarget: the sales source decides what may be judged', () => {
	const inputs = {
		salesSource: 'online_orders' as const,
		targetBp: 3000,
		costMinorByCurrency: { USD: 150_000 },
		guideSalesMinorByCurrency: { USD: 600_000 },
	}
	it('never says within or over for online orders alone', () => {
		const target = computeLaborTarget(inputs)
		expect(target).toMatchObject({
			salesSource: 'online_orders',
			salesComplete: false,
			targetColoring: false,
		})
		expect(target.currencies[0]).not.toHaveProperty('targetStatus')
	})
	it('judges once the scope is online-only or enters its own sales', () => {
		for (const salesSource of ['online_only', 'manual'] as const) {
			const target = computeLaborTarget({ ...inputs, salesSource })
			expect(target).toMatchObject({
				salesSource,
				salesComplete: true,
				targetColoring: true,
			})
			expect(target.currencies[0]!.targetStatus).toBe('within') // 25% <= 30%
		}
		const over = computeLaborTarget({
			...inputs,
			salesSource: 'manual',
			costMinorByCurrency: { USD: 200_000 },
		})
		expect(over.currencies[0]!.targetStatus).toBe('over') // 33.3% > 30%
	})
	it('gives no judgement without a target or without sales', () => {
		expect(
			computeLaborTarget({ ...inputs, salesSource: 'manual', targetBp: null })
				.currencies[0],
		).not.toHaveProperty('targetStatus')
		expect(
			computeLaborTarget({
				...inputs,
				salesSource: 'manual',
				guideSalesMinorByCurrency: {},
			}).currencies[0],
		).not.toHaveProperty('targetStatus')
	})
})

describe('manualSalesGuide', () => {
	// 2026-03-09 is a Monday. The window is the eight weeks before it.
	const week = weekDates('2026-03-09')
	it('takes the median of the same weekday and skips days nobody entered', () => {
		const entries = [
			{ date: '2026-03-02', currency: 'USD', salesMinor: 100_000 },
			{ date: '2026-02-23', currency: 'USD', salesMinor: 120_000 },
			{ date: '2026-02-16', currency: 'USD', salesMinor: 200_000 },
			// A Tuesday: only one sample.
			{ date: '2026-03-03', currency: 'USD', salesMinor: 90_000 },
		]
		const guide = manualSalesGuide({
			entries,
			weekDates: week,
			anchorDate: '2026-03-09',
		})
		expect(guide['2026-03-09']).toEqual({ USD: 120_000 })
		expect(guide['2026-03-10']).toEqual({ USD: 90_000 })
		// No Wednesday was ever entered: no figure, not zero.
		expect(guide['2026-03-11']).toEqual({})
	})
	it('keeps currencies apart and ignores entries outside the window', () => {
		const entries = [
			{ date: '2026-03-02', currency: 'USD', salesMinor: 100_000 },
			{ date: '2026-02-23', currency: 'SAR', salesMinor: 50_000 },
			{ date: '2025-01-06', currency: 'USD', salesMinor: 999_999 },
			{ date: '2026-03-09', currency: 'USD', salesMinor: 999_999 },
		]
		const guide = manualSalesGuide({
			entries,
			weekDates: week,
			anchorDate: '2026-03-09',
		})
		expect(guide['2026-03-09']).toEqual({ SAR: 50_000, USD: 100_000 })
	})
})
