import { describe, expect, it } from 'vitest'
import { type LaborMoneyView } from './labor-api.ts'
import {
	computeLaborSummary,
	datesInRange,
	type LaborCardFact,
	type LaborSalesFact,
	ratioBp,
	salesPerLaborHour,
	targetStatusOf,
} from './labor-summary.ts'

/** Cost units of a card: minutes x minor-per-hour x basis points. */
const units = (minutes: number, rateMinor: number, bp = 10_000) =>
	minutes * rateMinor * bp

function card(
	date: string,
	staffId: string,
	minutes: number,
	rateMinor: number,
	extra: Partial<LaborCardFact> = {},
): LaborCardFact {
	return {
		staffId,
		date,
		paidMinutes: minutes,
		overtimeMinutes: 0,
		costUnits: units(minutes, rateMinor),
		currency: 'USD',
		unpricedMinutes: 0,
		open: false,
		...extra,
	}
}

const sale = (
	date: string,
	dollars: number,
	currency = 'USD',
): LaborSalesFact => ({
	date,
	currency,
	salesMinor: dollars * 100,
})

/**
 * One hand-calculated week (Monday 2026-03-02 to Sunday 03-08), USD.
 *
 *   Mon  A 8h at $15 = $120, B 6h at $12 = $72     cost $192  sales $800
 *   Tue  A 8h at $15                               cost $120  sales $600
 *   Wed  B 5h30 at $12 = $66, A 8h at $15 = $120   cost $186  (no sales entered)
 *   Thu  nobody works                              cost $0    sales $500
 *   Fri  A 8h at $15 + B 8h at $12 = $216          cost $216  sales $1,200
 *   Sat  A 8h at $15 + 2h overtime at 1.5x         cost $165  sales $1,500
 *   Sun  closed
 */
const WEEK_CARDS: LaborCardFact[] = [
	card('2026-03-02', 'a', 480, 1500),
	card('2026-03-02', 'b', 360, 1200),
	card('2026-03-03', 'a', 480, 1500),
	card('2026-03-04', 'b', 330, 1200),
	card('2026-03-04', 'a', 480, 1500),
	card('2026-03-06', 'a', 480, 1500),
	card('2026-03-06', 'b', 480, 1200),
	{
		...card('2026-03-07', 'a', 600, 1500),
		overtimeMinutes: 120,
		costUnits: units(480, 1500) + units(120, 1500, 15_000),
	},
]
const WEEK_SALES: LaborSalesFact[] = [
	sale('2026-03-02', 800),
	sale('2026-03-03', 600),
	sale('2026-03-05', 500),
	sale('2026-03-06', 1200),
	sale('2026-03-07', 1500),
]

function week(
	source: Parameters<typeof computeLaborSummary>[0]['salesSource'],
	targetBp: number | null = 1800,
) {
	return computeLaborSummary({
		scopeId: 'loc1',
		timeZone: 'America/Chicago',
		from: '2026-03-02',
		to: '2026-03-08',
		salesSource: source,
		targetBp,
		cards: WEEK_CARDS,
		sales: WEEK_SALES,
	})
}

const usd = (money: LaborMoneyView[]) =>
	money.find((m) => m.currency === 'USD')!

describe('ratioBp and salesPerLaborHour', () => {
	it('round to the nearest basis point and cent', () => {
		expect(ratioBp(693, 4600)).toBe(1507)
		expect(ratioBp(1, 3)).toBe(3333)
		expect(ratioBp(10, 0)).toBeNull()
		expect(salesPerLaborHour(460_000, 2880)).toBe(9583)
		expect(salesPerLaborHour(10_000, 0)).toBeNull()
	})
})

describe('datesInRange', () => {
	it('lists every date inclusively, across a month end', () => {
		expect(datesInRange('2026-02-27', '2026-03-02')).toEqual([
			'2026-02-27',
			'2026-02-28',
			'2026-03-01',
			'2026-03-02',
		])
		expect(datesInRange('2026-03-05', '2026-03-04')).toEqual([])
	})
})

describe('computeLaborSummary: a hand-calculated week', () => {
	const summary = week('manual')

	it('gives one row per day with hours, people, cost and sales', () => {
		expect(summary.days.map((d) => d.date)).toEqual(
			datesInRange('2026-03-02', '2026-03-08'),
		)
		const [mon, tue, wed, thu, fri, sat, sun] = summary.days
		expect(mon).toMatchObject({
			paidMinutes: 840,
			people: 2,
			cards: 2,
			hasSales: true,
		})
		expect(usd(mon!.money)).toMatchObject({
			costMinor: 19_200,
			salesMinor: 80_000,
			laborBp: 2400,
			salesPerLaborHourMinor: 5714,
		})
		expect(usd(tue!.money)).toMatchObject({
			costMinor: 12_000,
			salesMinor: 60_000,
			laborBp: 2000,
			salesPerLaborHourMinor: 7500,
		})
		expect(wed).toMatchObject({ paidMinutes: 810, hasSales: false })
		expect(usd(wed!.money)).toMatchObject({
			costMinor: 18_600,
			salesMinor: null,
			laborBp: null,
			salesPerLaborHourMinor: null,
		})
		expect(usd(thu!.money)).toMatchObject({
			costMinor: 0,
			salesMinor: 50_000,
			laborBp: 0,
		})
		expect(usd(fri!.money)).toMatchObject({
			costMinor: 21_600,
			salesMinor: 120_000,
			laborBp: 1800,
			salesPerLaborHourMinor: 7500,
		})
		expect(sat).toMatchObject({ paidMinutes: 600, overtimeMinutes: 120 })
		expect(usd(sat!.money)).toMatchObject({
			costMinor: 16_500,
			salesMinor: 150_000,
			laborBp: 1100,
			salesPerLaborHourMinor: 15_000,
		})
		expect(sun).toMatchObject({
			paidMinutes: 0,
			cards: 0,
			hasSales: false,
			money: [],
		})
	})

	it('totals the share as a ratio of sums over the days that have sales', () => {
		// Cost on the five days with sales: 192 + 120 + 0 + 216 + 165 = $693.
		// Sales: 800 + 600 + 500 + 1200 + 1500 = $4,600. 693 / 4600 = 15.07%.
		// Not the average of the daily shares: (24 + 20 + 0 + 18 + 11) / 5 = 14.6%.
		const total = usd(summary.totals.money)
		expect(total.laborBp).toBe(1507)
		expect(total.salesMinor).toBe(460_000)
		// The whole week still shows every wage dollar: 693 + 186 (the day without sales).
		expect(total.costMinor).toBe(87_900)
		// 2880 paid minutes on the days with sales = 48 hours: 4600 / 48 = $95.83.
		expect(total.salesPerLaborHourMinor).toBe(9583)
		expect(summary.totals).toMatchObject({
			paidMinutes: 840 + 480 + 810 + 960 + 600,
			overtimeMinutes: 120,
			cards: 8,
			salesDays: 5,
			daysWithoutSales: 2,
		})
	})

	it('judges against the target only because manual sales are complete', () => {
		expect(summary.salesComplete).toBe(true)
		expect(summary.targetColoring).toBe(true)
		expect(usd(summary.days[0]!.money).targetStatus).toBe('over') // 24% > 18%
		expect(usd(summary.days[4]!.money).targetStatus).toBe('within') // 18% <= 18%
		expect(usd(summary.totals.money).targetStatus).toBe('within') // 15.07%
		// No sales that day: no share, so no judgement either.
		expect(usd(summary.days[2]!.money).targetStatus).toBeUndefined()
	})
})

describe('computeLaborSummary: the sales source decides what may be judged', () => {
	it('never colors against a target when only online orders are counted', () => {
		const online = week('online_orders')
		expect(online.salesComplete).toBe(false)
		expect(online.targetColoring).toBe(false)
		const everyRow = [
			...online.days.flatMap((d) => d.money),
			...online.totals.money,
		]
		expect(everyRow.length).toBeGreaterThan(0)
		for (const row of everyRow) expect(row).not.toHaveProperty('targetStatus')
		// The share itself is still shown, labeled by the source the screen adds.
		expect(usd(online.totals.money).laborBp).not.toBeNull()
	})

	it('colors an online source once the scope is flagged online-only', () => {
		const flagged = week('online_only')
		expect(flagged.targetColoring).toBe(true)
		expect(usd(flagged.totals.money).targetStatus).toBeDefined()
	})

	it('treats every day as having sales on an online source, even without orders', () => {
		const online = week('online_orders')
		expect(online.days.every((d) => d.hasSales)).toBe(true)
		// Wednesday has wages and zero counted orders: the share is blank, not infinite.
		expect(usd(online.days[2]!.money)).toMatchObject({
			salesMinor: 0,
			laborBp: null,
		})
		expect(online.totals.daysWithoutSales).toBe(0)
	})

	it('gives no judgement without a target', () => {
		expect(usd(week('manual', null).totals.money).targetStatus).toBeUndefined()
		expect(
			targetStatusOf({ source: 'manual', targetBp: null, laborBp: 100 }),
		).toBeNull()
		expect(
			targetStatusOf({ source: 'manual', targetBp: 3000, laborBp: null }),
		).toBeNull()
		expect(
			targetStatusOf({ source: 'online_orders', targetBp: 3000, laborBp: 100 }),
		).toBeNull()
	})
})

describe('computeLaborSummary: currencies are never added', () => {
	it('refuses to compare wages with sales of another currency and says so', () => {
		const summary = computeLaborSummary({
			scopeId: 'loc1',
			timeZone: 'America/Chicago',
			from: '2026-03-02',
			to: '2026-03-03',
			salesSource: 'manual',
			targetBp: 3000,
			cards: [
				card('2026-03-02', 'a', 480, 1500),
				card('2026-03-02', 'c', 480, 5000, { currency: 'SAR' }),
			],
			sales: [sale('2026-03-02', 1000), sale('2026-03-03', 500)],
		})
		expect(summary.currencyMismatch).toEqual({
			costOnly: ['SAR'],
			salesOnly: [],
		})
		const total = summary.totals.money
		expect(total.map((m) => m.currency)).toEqual(['SAR', 'USD'])
		const sar = total.find((m) => m.currency === 'SAR')!
		expect(sar).toMatchObject({
			costMinor: 40_000,
			laborBp: null,
			salesPerLaborHourMinor: null,
		})
		expect(sar.targetStatus).toBeUndefined()
		// The USD share counts only USD cost over USD sales: $120 / $1,500.
		expect(usd(total)).toMatchObject({
			costMinor: 12_000,
			salesMinor: 150_000,
			laborBp: 800,
		})
	})

	it('reports sales in a currency with no wages as the other side of the mismatch', () => {
		const summary = computeLaborSummary({
			scopeId: 'loc1',
			timeZone: 'Asia/Riyadh',
			from: '2026-03-02',
			to: '2026-03-02',
			salesSource: 'manual',
			targetBp: null,
			cards: [card('2026-03-02', 'a', 480, 4000, { currency: 'SAR' })],
			sales: [sale('2026-03-02', 1000, 'USD')],
		})
		expect(summary.currencyMismatch).toEqual({
			costOnly: ['SAR'],
			salesOnly: ['USD'],
		})
		expect(summary.totals.money.every((m) => m.laborBp === null)).toBe(true)
	})

	it('reports no mismatch when there are no sales at all', () => {
		const summary = computeLaborSummary({
			scopeId: 'loc1',
			timeZone: 'America/Chicago',
			from: '2026-03-02',
			to: '2026-03-02',
			salesSource: 'manual',
			targetBp: null,
			cards: [card('2026-03-02', 'a', 480, 1500)],
			sales: [],
		})
		expect(summary.currencyMismatch).toBeNull()
		expect(usd(summary.totals.money)).toMatchObject({
			costMinor: 12_000,
			salesMinor: null,
			laborBp: null,
		})
		expect(summary.totals.daysWithoutSales).toBe(1)
	})
})

describe('computeLaborSummary: edges', () => {
	it('counts unpriced minutes and open cards without inventing cost', () => {
		const summary = computeLaborSummary({
			scopeId: 'loc1',
			timeZone: 'America/Chicago',
			from: '2026-03-02',
			to: '2026-03-02',
			salesSource: 'online_orders',
			targetBp: null,
			cards: [
				card('2026-03-02', 'a', 240, 0, {
					costUnits: 0,
					currency: null,
					unpricedMinutes: 240,
					open: true,
				}),
			],
			sales: [],
		})
		expect(summary).toMatchObject({ unpricedMinutes: 240, openCards: 1 })
		expect(summary.days[0]).toMatchObject({ paidMinutes: 240, money: [] })
	})

	it('ignores cards and sales outside the range', () => {
		const summary = computeLaborSummary({
			scopeId: 'loc1',
			timeZone: 'America/Chicago',
			from: '2026-03-02',
			to: '2026-03-02',
			salesSource: 'manual',
			targetBp: null,
			cards: [
				card('2026-03-01', 'a', 480, 1500),
				card('2026-03-03', 'a', 480, 1500),
			],
			sales: [sale('2026-03-01', 100), sale('2026-03-03', 100)],
		})
		expect(summary.totals).toMatchObject({
			paidMinutes: 0,
			cards: 0,
			money: [],
		})
	})

	it('rounds cost once from exact units, not per card', () => {
		// Three 20-minute cards at $10.01/h: each is $3.3367 (333.67 minor).
		// Rounded per card that is 334 x 3 = 1002; from exact units it is 1001.
		const cards = ['a', 'b', 'c'].map((id) => card('2026-03-02', id, 20, 1001))
		const summary = computeLaborSummary({
			scopeId: 'loc1',
			timeZone: 'America/Chicago',
			from: '2026-03-02',
			to: '2026-03-02',
			salesSource: 'manual',
			targetBp: null,
			cards,
			sales: [],
		})
		expect(usd(summary.days[0]!.money).costMinor).toBe(1001)
	})

	it('carries the truncation flag and the scope facts through', () => {
		const summary = computeLaborSummary({
			scopeId: 'loc9',
			timeZone: 'Asia/Riyadh',
			from: '2026-03-02',
			to: '2026-03-02',
			salesSource: 'manual',
			targetBp: null,
			cards: [],
			sales: [],
			truncated: true,
		})
		expect(summary).toMatchObject({
			estimate: true,
			scopeId: 'loc9',
			timeZone: 'Asia/Riyadh',
			truncated: true,
		})
	})
})
