import { describe, expect, it } from 'vitest'
import {
	createReportDefinition,
	runReport,
	organizationCatalog,
} from '@repo/reports'
import {
	computeLaborSummary,
	type LaborCardFact,
	type LaborSalesFact,
} from '@repo/staffing'
import {
	arrivalOf,
	LABOR_REPORT_MAX_DAYS,
	laborDailyRecords,
	laborReportRange,
	shiftRecord,
	staffAuthFromSubjects,
} from './staffing-report-records.ts'

const MIN = 60_000
/** Cost units of a dollar amount (units are 1/600,000 of a minor unit). */
const usd = (dollars: number) => dollars * 100 * 600_000

describe('arrivalOf', () => {
	const shift = (id: string, startsAt: number, staffId = 's1') => ({
		id,
		staffId,
		startsAt,
	})
	const start = Date.UTC(2026, 2, 2, 15, 0)
	const index = (shifts: ReturnType<typeof shift>[]) => {
		const byId = new Map(shifts.map((s) => [s.id, s]))
		const byStaffDate = new Map<string, ReturnType<typeof shift>[]>()
		for (const s of shifts) {
			const key = `${s.staffId}|2026-03-02`
			byStaffDate.set(key, [...(byStaffDate.get(key) ?? []), s])
		}
		return { byId, byStaffDate }
	}
	const card = (clockInAt: number, shiftId: string | null = null) => ({
		shiftId,
		staffId: 's1',
		localDate: '2026-03-02',
		clockInAt,
	})

	it('treats early arrivals and the grace minutes as on time', () => {
		const idx = index([shift('a', start)])
		expect(arrivalOf(card(start - 30 * MIN), idx)).toEqual({
			arrival: 'on_time',
			lateMinutes: null,
		})
		expect(arrivalOf(card(start + 5 * MIN), idx).arrival).toBe('on_time')
		expect(arrivalOf(card(start + 6 * MIN), idx)).toEqual({
			arrival: 'late',
			lateMinutes: 6,
		})
	})

	it('is unscheduled without a shift, and ignores another person’s shift', () => {
		expect(arrivalOf(card(start), index([])).arrival).toBe('unscheduled')
		const other = index([shift('b', start, 's2')])
		expect(arrivalOf(card(start), other).arrival).toBe('unscheduled')
	})

	it('prefers the linked shift, else the closest start', () => {
		const idx = index([
			shift('early', start - 6 * 60 * MIN),
			shift('late', start + 6 * 60 * MIN),
		])
		// Linked to the early shift: a long way after it, so late.
		expect(arrivalOf(card(start, 'early'), idx).arrival).toBe('late')
		// Unlinked: the closest start is used (an hour after the first, an hour before the second).
		expect(arrivalOf(card(start - 7 * 60 * MIN), idx).arrival).toBe('on_time')
		expect(arrivalOf(card(start + 5 * 60 * MIN), idx).arrival).toBe('on_time')
	})
})

describe('shiftRecord', () => {
	it('subtracts the unpaid break and marks open shifts', () => {
		const base = {
			startsAt: Date.UTC(2026, 2, 2, 15),
			endsAt: Date.UTC(2026, 2, 2, 23),
			unpaidBreakMinutes: 30,
			timeZone: 'America/Chicago',
			status: 'published' as const,
		}
		const names = { employee: 'Ana', position: 'Cook', scope: 'Main' }
		expect(shiftRecord({ ...base, staffId: 's1' }, names)).toMatchObject({
			scheduledMinutes: 450,
			openShift: false,
			status: 'published',
		})
		expect(shiftRecord({ ...base, staffId: null }, names).openShift).toBe(true)
		expect(
			shiftRecord(
				{
					...base,
					staffId: null,
					endsAt: base.startsAt,
					unpaidBreakMinutes: 60,
				},
				names,
			).scheduledMinutes,
		).toBe(0)
	})
})

describe('laborDailyRecords', () => {
	const NY = 'America/New_York'
	function summary(
		cards: LaborCardFact[],
		sales: LaborSalesFact[],
		range = { from: '2026-03-07', to: '2026-03-10' },
		source: 'online_orders' | 'manual' = 'manual',
	) {
		return computeLaborSummary({
			scopeId: 'loc-1',
			timeZone: NY,
			...range,
			salesSource: source,
			targetBp: null,
			cards,
			sales,
		})
	}
	const card = (
		date: string,
		costUnits: number,
		currency: string | null,
		paidMinutes = 480,
	): LaborCardFact => ({
		staffId: `s-${date}`,
		date,
		paidMinutes,
		overtimeMinutes: 0,
		costUnits,
		currency,
		unpricedMinutes: 0,
		open: false,
	})

	it('stamps each day at the scope’s midnight across the spring-forward change', () => {
		const records = laborDailyRecords({
			scopeName: 'Main',
			summary: summary(
				[
					card('2026-03-07', usd(10), 'USD'),
					card('2026-03-08', usd(10), 'USD'),
					card('2026-03-09', usd(10), 'USD'),
				],
				[],
			),
			scheduled: new Map(),
		})
		expect(records.map((r) => (r.date as Date).toISOString())).toEqual([
			'2026-03-07T05:00:00.000Z', // EST
			'2026-03-08T05:00:00.000Z', // midnight, an hour before the clocks change
			'2026-03-09T04:00:00.000Z', // EDT
		])
		expect(records.every((r) => r.timeZone === NY)).toBe(true)
	})

	it('runs a day-bucketed report through the change without gaps or repeats', () => {
		const records = laborDailyRecords({
			scopeName: 'Main',
			summary: summary(
				[
					card('2026-03-07', usd(10), 'USD'),
					card('2026-03-08', usd(10), 'USD'),
					card('2026-03-09', usd(10), 'USD'),
				],
				[
					{ date: '2026-03-07', currency: 'USD', salesMinor: 100_000 },
					{ date: '2026-03-08', currency: 'USD', salesMinor: 100_000 },
					{ date: '2026-03-09', currency: 'USD', salesMinor: 100_000 },
				],
			),
			scheduled: new Map(),
		})
		const result = runReport(
			organizationCatalog,
			createReportDefinition({
				subject: 'labor_daily',
				timeframe: {
					field: 'date',
					preset: 'custom',
					start: '2026-03-07T00:00:00.000Z',
					end: '2026-03-11T00:00:00.000Z',
				},
				groupBy: ['date'],
				timeBucket: 'day',
				visualization: {
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'paidMinutes',
					sortBy: 'none',
				},
				settings: { title: 'Hours', notes: '', timezone: 'UTC' },
			}),
			records,
			new Date('2026-03-11T00:00:00.000Z'),
		)
		if ('error' in result) throw new Error(result.message)
		const counted = result.segments.filter((s) => s.count > 0)
		expect(counted.map((s) => s.key)).toEqual([
			'2026-03-07',
			'2026-03-08',
			'2026-03-09',
		])
		expect(counted.map((s) => s.value)).toEqual([480, 480, 480])
	})

	it('skips quiet days and keeps wages out of a currency that has none', () => {
		const records = laborDailyRecords({
			scopeName: 'Main',
			summary: summary(
				[card('2026-03-08', usd(5), 'USD')],
				[{ date: '2026-03-08', currency: 'USD', salesMinor: 200_000 }],
			),
			scheduled: new Map([['2026-03-09', { minutes: 360, shifts: 1 }]]),
		})
		// The 7th and 10th have nothing; the 9th only has a scheduled shift.
		expect(
			records.map((r) => (r.date as Date).toISOString().slice(0, 10)),
		).toEqual(['2026-03-08', '2026-03-09'])
		expect(records[1]).toMatchObject({
			scheduledMinutes: 360,
			paidMinutes: 0,
			varianceMinutes: -360,
			clockIns: 0,
			laborCost: null,
			sales: null,
		})
	})

	it('never converts: wages in another currency leave the day out of shares', () => {
		const records = laborDailyRecords({
			scopeName: 'Main',
			summary: summary(
				[
					card('2026-03-08', usd(80), 'SAR'),
					card('2026-03-09', usd(10), 'USD'),
				],
				[
					{ date: '2026-03-08', currency: 'USD', salesMinor: 100_000 },
					{ date: '2026-03-09', currency: 'USD', salesMinor: 100_000 },
				],
			),
			scheduled: new Map(),
		})
		const mismatch = records.find((r) =>
			(r.date as Date).toISOString().startsWith('2026-03-08'),
		)!
		expect(mismatch).toMatchObject({
			currency: 'USD',
			currencyMismatch: true,
			laborCost: null,
			sales: 1000,
		})
		const clean = records.find((r) =>
			(r.date as Date).toISOString().startsWith('2026-03-09'),
		)!
		expect(clean).toMatchObject({
			currencyMismatch: false,
			laborCost: 10,
			sales: 1000,
		})

		const result = runReport(
			organizationCatalog,
			createReportDefinition({
				subject: 'labor_daily',
				timeframe: { field: 'date', preset: 'all_time' },
				visualization: {
					chartStyle: 'single_number',
					measure: 'ratio',
					valueField: 'laborCostPercent',
					sortBy: 'none',
				},
				settings: { title: 'Share', notes: '', timezone: 'UTC' },
			}),
			records,
			new Date('2026-03-12T00:00:00.000Z'),
		)
		if ('error' in result) throw new Error(result.message)
		// Only the clean day counts: $10 of $1,000.
		expect(result.value).toBeCloseTo(1, 10)
		expect(result.valueInfo?.excluded).toBe(1)
	})

	it('adds tips in the day’s currency', () => {
		const records = laborDailyRecords({
			scopeName: 'Main',
			summary: summary(
				[card('2026-03-08', usd(10), 'USD')],
				[{ date: '2026-03-08', currency: 'USD', salesMinor: 100_000 }],
			),
			scheduled: new Map(),
			tips: new Map([['2026-03-08|USD', 1234]]),
		})
		expect(records[0]?.tips).toBe(12.34)
	})
})

describe('laborReportRange', () => {
	const definition = (preset: 'today' | 'all_time' | 'last_7_days') =>
		createReportDefinition({
			subject: 'labor_daily',
			timeframe: { field: 'date', preset },
			visualization: { chartStyle: 'single_number', measure: 'count' },
			settings: { title: 'x', notes: '', timezone: 'UTC' },
		})

	it('uses the scope’s calendar, not the server’s', () => {
		// 03:00 UTC on 9 March is still the 8th in New York.
		const now = Date.UTC(2026, 2, 9, 3, 0)
		expect(
			laborReportRange(definition('today'), now, 'America/New_York', 0),
		).toEqual({
			from: '2026-03-08',
			to: '2026-03-08',
			clamped: false,
		})
		expect(
			laborReportRange(definition('last_7_days'), now, 'America/New_York', 0),
		).toMatchObject({ from: '2026-03-02', to: '2026-03-08' })
	})

	it('applies the workday rule', () => {
		// 02:00 local on the 9th belongs to the 8th when the day starts at 04:00.
		const now = Date.UTC(2026, 2, 9, 7, 0) // 03:00 EDT
		expect(
			laborReportRange(definition('today'), now, 'America/New_York', 240).to,
		).toBe('2026-03-08')
	})

	it('clamps all time to a year', () => {
		const range = laborReportRange(
			definition('all_time'),
			Date.UTC(2026, 2, 9, 12),
			'UTC',
			0,
		)
		expect(range.to).toBe('2026-03-09')
		expect(range.clamped).toBe(false)
		expect(range.from).toBe('2025-03-09')
		expect(LABOR_REPORT_MAX_DAYS).toBe(366)
	})
})

describe('staffAuthFromSubjects', () => {
	it('turns subjects into the least grants that cover them', () => {
		const auth = staffAuthFromSubjects({
			orgId: 'o',
			userId: 'u',
			subjects: ['labor_daily'],
			scopeIds: ['loc-1'],
		})
		expect(auth.grants).toEqual(['read:labor:any'])
		expect(auth.scopeIds).toEqual(['loc-1'])
		expect(auth.impersonated).toBe(false)

		const pay = staffAuthFromSubjects({
			orgId: 'o',
			userId: 'u',
			subjects: ['time_entries', 'staff_pay'],
			scopeIds: null,
		})
		expect(pay.grants).toEqual(
			expect.arrayContaining([
				'read:timesheet:any',
				'read:staff:any',
				'read:staff_pay:any',
			]),
		)
		expect(pay.grants).not.toContain('read:labor:any')
	})
})
