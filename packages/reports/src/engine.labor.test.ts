import { describe, expect, it } from 'vitest'
import { getSubject, organizationCatalog } from './catalog.ts'
import { createReportDefinition, type ReportDefinition } from './dsl.ts'
import {
	isReportRunError,
	localDateIn,
	referencedFieldIds,
	resolveReportTimeZone,
	resolveTimeframeRange,
	runReport,
	startOfLocalDay,
	timeframeLoadWindow,
	validateReportDefinition,
} from './engine.ts'
import { formatDuration, formatMeasuredValue } from './format.ts'

const NEW_YORK = 'America/New_York'
const RIYADH = 'Asia/Riyadh'

function notesByDay(preset: ReportDefinition['timeframe']['preset']) {
	return createReportDefinition({
		subject: 'notes',
		timeframe: { field: 'createdAt', preset },
		groupBy: ['createdAt'],
		timeBucket: 'day',
		visualization: {
			chartStyle: 'bar',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'Notes by day', notes: '', timezone: 'user' },
	})
}

function ok<T extends object>(result: T | { error: string }): T {
	if ('error' in result) throw new Error(JSON.stringify(result))
	return result
}

describe('resolveReportTimeZone', () => {
	it('follows the viewer, UTC, or a named zone, and never throws', () => {
		expect(resolveReportTimeZone('user', RIYADH)).toBe(RIYADH)
		expect(resolveReportTimeZone('user')).toBe('UTC')
		expect(resolveReportTimeZone('user', 'Not/AZone')).toBe('UTC')
		expect(resolveReportTimeZone('UTC', RIYADH)).toBe('UTC')
		expect(resolveReportTimeZone(NEW_YORK, RIYADH)).toBe(NEW_YORK)
		expect(resolveReportTimeZone('Mars/Olympus', RIYADH)).toBe('UTC')
	})
})

describe('resolveTimeframeRange in a time zone', () => {
	it('starts today at the zone’s midnight, not the server’s', () => {
		// 22:30 UTC is already the 25th in Riyadh (UTC+3).
		const now = new Date('2026-08-24T22:30:00.000Z')
		const riyadh = resolveTimeframeRange('today', now, undefined, RIYADH)
		expect(riyadh.start?.toISOString()).toBe('2026-08-24T21:00:00.000Z')
		const utc = resolveTimeframeRange('today', now)
		expect(utc.start?.toISOString()).toBe('2026-08-24T00:00:00.000Z')
		const newYork = resolveTimeframeRange('today', now, undefined, NEW_YORK)
		expect(newYork.start?.toISOString()).toBe('2026-08-24T04:00:00.000Z')
	})

	it('keeps whole local days across a spring-forward change', () => {
		// New York springs forward on 2026-03-08: the day is 23 hours long.
		const now = new Date('2026-03-09T12:00:00.000Z')
		const today = resolveTimeframeRange('today', now, undefined, NEW_YORK)
		expect(today.start?.toISOString()).toBe('2026-03-09T04:00:00.000Z')
		const week = resolveTimeframeRange('last_7_days', now, undefined, NEW_YORK)
		// Six days back is 2026-03-03 00:00 EST.
		expect(week.start?.toISOString()).toBe('2026-03-03T05:00:00.000Z')
		const springDay = resolveTimeframeRange(
			'today',
			new Date('2026-03-08T16:00:00.000Z'),
			undefined,
			NEW_YORK,
		)
		expect(springDay.start?.toISOString()).toBe('2026-03-08T05:00:00.000Z')
	})

	it('keeps whole local days across a fall-back change', () => {
		// New York falls back on 2026-11-01: the day is 25 hours long.
		const now = new Date('2026-11-01T18:00:00.000Z')
		const today = resolveTimeframeRange('today', now, undefined, NEW_YORK)
		expect(today.start?.toISOString()).toBe('2026-11-01T04:00:00.000Z')
		const next = resolveTimeframeRange(
			'today',
			new Date('2026-11-02T18:00:00.000Z'),
			undefined,
			NEW_YORK,
		)
		expect(next.start?.toISOString()).toBe('2026-11-02T05:00:00.000Z')
	})

	it('clamps month presets to the end of a shorter month', () => {
		const now = new Date('2026-05-31T15:00:00.000Z')
		const range = resolveTimeframeRange('last_3_months', now, undefined, 'UTC')
		expect(range.start?.toISOString()).toBe('2026-02-28T00:00:00.000Z')
		const year = resolveTimeframeRange(
			'last_12_months',
			new Date('2028-02-29T15:00:00.000Z'),
			undefined,
			'UTC',
		)
		expect(year.start?.toISOString()).toBe('2027-02-28T00:00:00.000Z')
	})

	it('leaves custom ranges and all time alone', () => {
		const custom = resolveTimeframeRange(
			'custom',
			new Date('2026-08-24T00:00:00.000Z'),
			{ start: '2026-08-01T10:00:00.000Z', end: '2026-08-02T10:00:00.000Z' },
			NEW_YORK,
		)
		expect(custom.start?.toISOString()).toBe('2026-08-01T10:00:00.000Z')
		expect(custom.end.toISOString()).toBe('2026-08-02T10:00:00.000Z')
		expect(
			resolveTimeframeRange('all_time', new Date(), undefined, RIYADH).start,
		).toBeNull()
	})

	it('widens the load window so no zone loses its first hours', () => {
		const now = new Date('2026-08-24T22:30:00.000Z')
		const window = timeframeLoadWindow('today', now)
		// Riyadh's today began at 21:00 UTC on the 24th; the window reaches back past it.
		expect(window.start!.getTime()).toBeLessThan(
			startOfLocalDay('2026-08-25', RIYADH).getTime(),
		)
		expect(window.start!.getTime()).toBeLessThanOrEqual(
			startOfLocalDay('2026-08-24', 'Pacific/Kiritimati').getTime(),
		)
	})

	it('reads local dates and day starts consistently', () => {
		const instant = new Date('2026-03-08T04:59:00.000Z')
		expect(localDateIn(instant, NEW_YORK)).toBe('2026-03-07')
		expect(startOfLocalDay('2026-03-08', NEW_YORK).toISOString()).toBe(
			'2026-03-08T05:00:00.000Z',
		)
	})
})

describe('time bucketing in a time zone', () => {
	const now = new Date('2026-03-10T15:00:00.000Z')
	const at = (iso: string) => ({ createdAt: iso, status: 'Todo' })

	it('cuts days at local midnight across a spring-forward change', () => {
		const records = [
			at('2026-03-08T04:59:00.000Z'), // 23:59 EST on the 7th
			at('2026-03-08T05:00:00.000Z'), // 00:00 EST on the 8th
			at('2026-03-09T03:59:00.000Z'), // 23:59 EDT on the 8th (a 23-hour day)
			at('2026-03-09T04:00:00.000Z'), // 00:00 EDT on the 9th
		]
		const result = ok(
			runReport(
				organizationCatalog,
				{
					...notesByDay('custom'),
					timeframe: {
						field: 'createdAt',
						preset: 'custom',
						start: '2026-03-07T00:00:00.000Z',
						end: '2026-03-10T00:00:00.000Z',
					},
				},
				records,
				now,
				{ timeZone: NEW_YORK },
			),
		)
		const byKey = Object.fromEntries(
			result.segments.map((segment) => [segment.key, segment.count]),
		)
		expect(byKey['2026-03-07']).toBe(1)
		expect(byKey['2026-03-08']).toBe(2)
		expect(byKey['2026-03-09']).toBe(1)
		expect(result.timeZone).toBe(NEW_YORK)
	})

	it('cuts days at local midnight across a fall-back change', () => {
		const records = [
			at('2026-11-01T03:59:00.000Z'), // 23:59 EDT on Halloween
			at('2026-11-01T04:00:00.000Z'), // 00:00 EDT on the 1st
			at('2026-11-02T04:59:00.000Z'), // 23:59 EST on the 1st (a 25-hour day)
			at('2026-11-02T05:00:00.000Z'), // 00:00 EST on the 2nd
		]
		const result = ok(
			runReport(
				organizationCatalog,
				{
					...notesByDay('custom'),
					timeframe: {
						field: 'createdAt',
						preset: 'custom',
						start: '2026-10-31T00:00:00.000Z',
						end: '2026-11-03T00:00:00.000Z',
					},
				},
				records,
				new Date('2026-11-03T12:00:00.000Z'),
				{ timeZone: NEW_YORK },
			),
		)
		const byKey = Object.fromEntries(
			result.segments.map((segment) => [segment.key, segment.count]),
		)
		expect(byKey['2026-10-31']).toBe(1)
		expect(byKey['2026-11-01']).toBe(2)
		expect(byKey['2026-11-02']).toBe(1)
	})

	it('fills quiet days and never repeats the change-over day', () => {
		const result = ok(
			runReport(
				organizationCatalog,
				notesByDay('last_7_days'),
				[at('2026-03-10T12:00:00.000Z')],
				now,
				{ timeZone: NEW_YORK },
			),
		)
		expect(result.segments.map((segment) => segment.key)).toEqual([
			'2026-03-04',
			'2026-03-05',
			'2026-03-06',
			'2026-03-07',
			'2026-03-08',
			'2026-03-09',
			'2026-03-10',
		])
		expect(result.segments.at(-1)?.count).toBe(1)
		expect(result.segments.at(-1)?.label).toBe('Tue, Mar 10')
	})

	it('puts the same instant on different days in different zones', () => {
		const record = at('2026-08-24T22:30:00.000Z')
		const now = new Date('2026-08-26T12:00:00.000Z')
		const definition = {
			...notesByDay('all_time'),
			timeBucket: 'day' as const,
		}
		const riyadh = ok(
			runReport(organizationCatalog, definition, [record], now, {
				timeZone: RIYADH,
			}),
		)
		const utc = ok(
			runReport(organizationCatalog, definition, [record], now, {
				timeZone: 'UTC',
			}),
		)
		expect(riyadh.segments.find((s) => s.count === 1)?.key).toBe('2026-08-25')
		expect(utc.segments.find((s) => s.count === 1)?.key).toBe('2026-08-24')
	})

	it('cuts weeks and months by local date', () => {
		// 03:00 UTC on 1 March is still 28 February in New York.
		const record = at('2026-03-01T03:00:00.000Z')
		const month = ok(
			runReport(
				organizationCatalog,
				{ ...notesByDay('all_time'), timeBucket: 'month' },
				[record],
				now,
				{ timeZone: NEW_YORK },
			),
		)
		expect(month.segments.find((s) => s.count === 1)?.key).toBe('2026-02')
		// 28 February 2026 is a Saturday; its week starts Monday the 23rd.
		const week = ok(
			runReport(
				organizationCatalog,
				{ ...notesByDay('all_time'), timeBucket: 'week' },
				[record],
				now,
				{ timeZone: NEW_YORK },
			),
		)
		expect(week.segments.find((s) => s.count === 1)?.key).toBe('2026-02-23')
	})

	it('lists dates in the report zone', () => {
		const definition = createReportDefinition({
			subject: 'notes',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			columns: ['title', 'createdAt'],
			visualization: { chartStyle: 'table', measure: 'count' },
			settings: { title: 'Notes', notes: '', timezone: 'user' },
		})
		const result = ok(
			runReport(
				organizationCatalog,
				definition,
				[{ createdAt: '2026-08-24T22:30:00.000Z', title: 'A' }],
				new Date('2026-08-26T12:00:00.000Z'),
				{ timeZone: RIYADH },
			),
		)
		expect(result.rows?.[0]?.createdAt).toBe('2026-08-25')
	})
})

describe('records that carry their own time zone', () => {
	const definition = (preset: ReportDefinition['timeframe']['preset']) =>
		createReportDefinition({
			subject: 'time_entries',
			timeframe: { field: 'clockInAt', preset },
			groupBy: ['clockInAt'],
			timeBucket: 'day',
			visualization: {
				chartStyle: 'bar',
				measure: 'sum',
				valueField: 'paidMinutes',
				sortBy: 'none',
			},
			settings: { title: 'Hours by day', notes: '', timezone: 'user' },
		})

	it('cuts each scope’s days in that scope’s zone, not the report’s', () => {
		const now = new Date('2026-08-25T02:00:00.000Z')
		const result = ok(
			runReport(
				organizationCatalog,
				definition('today'),
				[
					// 22:00 on the 24th in New York: still "today" there.
					{
						clockInAt: '2026-08-25T02:00:00.000Z',
						paidMinutes: 60,
						timeZone: NEW_YORK,
					},
					// 05:00 on the 25th in Riyadh: today there.
					{
						clockInAt: '2026-08-25T02:00:00.000Z',
						paidMinutes: 30,
						timeZone: RIYADH,
					},
					// 04:30 on the 24th in Riyadh: yesterday there, so outside "today".
					{
						clockInAt: '2026-08-24T01:30:00.000Z',
						paidMinutes: 500,
						timeZone: RIYADH,
					},
				],
				now,
				{ timeZone: 'UTC' },
			),
		)
		expect(result.total).toBe(2)
		expect(result.value).toBe(90)
		const keys = result.segments.filter((s) => s.count > 0).map((s) => s.key)
		expect(keys.sort()).toEqual(['2026-08-24', '2026-08-25'])
	})

	it('falls back to the report zone for a missing or invalid scope zone', () => {
		const now = new Date('2026-08-24T22:30:00.000Z')
		const result = ok(
			runReport(
				organizationCatalog,
				definition('all_time'),
				[
					{ clockInAt: '2026-08-24T22:30:00.000Z', paidMinutes: 10 },
					{
						clockInAt: '2026-08-24T22:30:00.000Z',
						paidMinutes: 20,
						timeZone: 'Nowhere/Land',
					},
				],
				now,
				{ timeZone: RIYADH },
			),
		)
		expect(result.segments.find((s) => s.count === 2)?.key).toBe('2026-08-25')
	})

	it('shows list times in the scope’s zone', () => {
		const list = createReportDefinition({
			subject: 'time_entries',
			timeframe: { field: 'clockInAt', preset: 'all_time' },
			columns: ['employee', 'clockInAt', 'paidMinutes'],
			visualization: { chartStyle: 'table', measure: 'count' },
			settings: { title: 'Time cards', notes: '', timezone: 'user' },
		})
		const result = ok(
			runReport(
				organizationCatalog,
				list,
				[
					{
						employee: 'A',
						clockInAt: '2026-08-24T22:30:00.000Z',
						paidMinutes: 510,
						timeZone: RIYADH,
					},
				],
				new Date('2026-08-26T00:00:00.000Z'),
			),
		)
		expect(result.rows?.[0]).toMatchObject({
			clockInAt: '2026-08-25 01:30',
			paidMinutes: '8h 30m',
		})
	})
})

describe('duration fields', () => {
	it('formats minutes as hours and minutes', () => {
		expect(formatDuration(0)).toBe('0m')
		expect(formatDuration(45)).toBe('45m')
		expect(formatDuration(60)).toBe('1h')
		expect(formatDuration(750)).toBe('12h 30m')
		expect(formatDuration(-90)).toBe('-1h 30m')
		expect(formatDuration(Number.NaN)).toBe('—')
		expect(
			formatMeasuredValue(
				150,
				{ measure: 'sum', field: 'x', label: 'Hours', type: 'duration' },
				{ locale: 'en-US' },
			),
		).toBe('2h 30m')
	})

	it('sums and averages durations as minutes', () => {
		const definition = (measure: 'sum' | 'average') =>
			createReportDefinition({
				subject: 'time_entries',
				timeframe: { field: 'clockInAt', preset: 'all_time' },
				groupBy: ['employee'],
				visualization: {
					chartStyle: 'bar',
					measure,
					valueField: 'paidMinutes',
					sortBy: 'value_desc',
				},
				settings: { title: 'Hours', notes: '', timezone: 'user' },
			})
		const records = [
			{ clockInAt: '2026-08-01T10:00:00Z', employee: 'A', paidMinutes: 480 },
			{ clockInAt: '2026-08-02T10:00:00Z', employee: 'A', paidMinutes: 300 },
			{ clockInAt: '2026-08-02T10:00:00Z', employee: 'B', paidMinutes: 100 },
		]
		const sum = ok(runReport(organizationCatalog, definition('sum'), records))
		expect(sum.valueInfo).toMatchObject({
			type: 'duration',
			label: 'Paid hours',
		})
		expect(sum.segments.map((s) => [s.label, s.value])).toEqual([
			['A', 780],
			['B', 100],
		])
		const average = ok(
			runReport(organizationCatalog, definition('average'), records),
		)
		expect(average.segments.find((s) => s.label === 'A')?.value).toBe(390)
	})

	it('offers no sum of minutes late', () => {
		const result = validateReportDefinition(
			organizationCatalog,
			createReportDefinition({
				subject: 'time_entries',
				timeframe: { field: 'clockInAt', preset: 'all_time' },
				groupBy: ['employee'],
				visualization: {
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'lateMinutes',
				},
				settings: { title: 'Late', notes: '', timezone: 'user' },
			}),
		)
		expect(result?.error).toBe('invalid_definition')
	})
})

describe('ratio of sums', () => {
	function labor(
		valueField: string,
		extra: Partial<ReportDefinition> = {},
		chartStyle: ReportDefinition['visualization']['chartStyle'] = 'single_number',
	) {
		return createReportDefinition({
			subject: 'labor_daily',
			timeframe: { field: 'date', preset: 'all_time' },
			visualization: {
				chartStyle,
				measure: 'ratio',
				valueField,
				sortBy: 'none',
			},
			settings: { title: 'Labor', notes: '', timezone: 'user' },
			...extra,
		})
	}
	const day = (
		date: string,
		laborCost: number | null,
		sales: number | null,
		more: Record<string, unknown> = {},
	) => ({
		date: `${date}T12:00:00.000Z`,
		scope: 'Main',
		currency: 'USD',
		timeZone: 'UTC',
		laborCost,
		sales,
		paidMinutes: 0,
		...more,
	})

	it('divides the sums, never averages the daily percentages', () => {
		// Day one is 100% of a tiny sale, day two is 11.1% of a big one. The
		// average of the two percentages is 55.6%; the real share is 200/1000.
		const records = [day('2026-08-01', 100, 100), day('2026-08-02', 100, 900)]
		const result = ok(
			runReport(organizationCatalog, labor('laborCostPercent'), records),
		)
		expect(result.value).toBeCloseTo(20, 10)
		expect(result.valueInfo).toMatchObject({
			measure: 'ratio',
			type: 'percent',
			excluded: 0,
		})
		expect(
			formatMeasuredValue(result.value!, result.valueInfo, { locale: 'en-US' }),
		).toBe('20%')
	})

	it('computes each bucket from that bucket’s own sums', () => {
		const records = [
			day('2026-08-03', 100, 1000), // Monday of week one
			day('2026-08-04', 300, 1000),
			day('2026-08-10', 50, 1000), // Monday of week two
		]
		const result = ok(
			runReport(
				organizationCatalog,
				labor(
					'laborCostPercent',
					{ groupBy: ['date'], timeBucket: 'week' },
					'bar',
				),
				records,
				new Date('2026-08-12T12:00:00.000Z'),
			),
		)
		expect(result.segments.map((s) => [s.key, s.value])).toEqual([
			['2026-08-03', 20],
			['2026-08-10', 5],
		])
		// The overall share is 450 of 3000, not the mean of 20 and 5.
		expect(result.value).toBeCloseTo(15, 10)
	})

	it('leaves out days without sales or wages and says how many', () => {
		const records = [
			day('2026-08-01', 100, 1000),
			day('2026-08-02', 500, null), // sales not entered
			day('2026-08-03', null, 800), // wages in another currency
		]
		const result = ok(
			runReport(organizationCatalog, labor('laborCostPercent'), records),
		)
		expect(result.value).toBeCloseTo(10, 10)
		expect(result.valueInfo?.excluded).toBe(2)
		expect(result.total).toBe(3)
	})

	it('has no value when nothing can be compared', () => {
		const result = ok(
			runReport(organizationCatalog, labor('laborCostPercent'), [
				day('2026-08-02', 500, null),
			]),
		)
		expect(result.value).toBeUndefined()
		expect(result.valueInfo?.excluded).toBe(1)
	})

	it('treats zero sales as no share rather than dividing by zero', () => {
		const result = ok(
			runReport(organizationCatalog, labor('laborCostPercent'), [
				day('2026-08-02', 500, 0),
			]),
		)
		expect(result.value).toBeUndefined()
	})

	it('never mixes currencies in one share', () => {
		const result = ok(
			runReport(organizationCatalog, labor('laborCostPercent'), [
				day('2026-08-01', 100, 1000),
				day('2026-08-02', 100, 1000, { currency: 'SAR' }),
			]),
		)
		expect(result.value).toBeUndefined()
		expect(result.valueInfo?.mixedCurrencies).toBe(true)
	})

	it('divides money by hours for sales per labor hour', () => {
		const result = ok(
			runReport(organizationCatalog, labor('salesPerLaborHour'), [
				day('2026-08-01', 0, 600, { paidMinutes: 120 }),
				day('2026-08-02', 0, 300, { paidMinutes: 60 }),
			]),
		)
		// 900 of sales over 3 paid hours.
		expect(result.value).toBe(300)
		expect(result.valueInfo).toMatchObject({
			type: 'currency',
			perHour: true,
			currency: 'USD',
		})
		expect(
			formatMeasuredValue(result.value!, result.valueInfo, { locale: 'en-US' }),
		).toBe('$300.00/h')
	})

	it('drops days with no paid hours from sales per labor hour', () => {
		const result = ok(
			runReport(organizationCatalog, labor('salesPerLaborHour'), [
				day('2026-08-01', 0, 600, { paidMinutes: 120 }),
				day('2026-08-02', 0, 5000, { paidMinutes: null }),
			]),
		)
		expect(result.value).toBe(300)
		expect(result.valueInfo?.excluded).toBe(1)
	})

	it('needs a ratio field and refuses pie charts', () => {
		expect(
			validateReportDefinition(organizationCatalog, labor('sales'))?.error,
		).toBe('invalid_definition')
		expect(
			validateReportDefinition(
				organizationCatalog,
				labor('laborCostPercent', { groupBy: ['scope'] }, 'pie'),
			)?.message,
		).toMatch(/pie chart/)
		const subject = getSubject(organizationCatalog, 'labor_daily')!
		expect(subject.fields.find((f) => f.id === 'laborCostPercent')?.type).toBe(
			'ratio',
		)
	})

	it('counts the two divided fields as read, so their permissions apply', () => {
		const subject = getSubject(organizationCatalog, 'labor_daily')!
		const ids = referencedFieldIds(subject, labor('laborCostPercent'))
		expect(ids).toEqual(
			new Set(['date', 'laborCostPercent', 'laborCost', 'sales']),
		)
	})

	it('reports a result error shape the same way as other measures', () => {
		const result = runReport(
			organizationCatalog,
			labor('laborCostPercent', { subject: 'nope' }),
			[],
		)
		expect(isReportRunError(result)).toBe(true)
	})
})
