import { describe, expect, it } from 'vitest'
import { getCatalog } from './catalog.ts'
import { isReportRunError, runReport } from './engine.ts'
import {
	DAILY_SUMMARY_FIGURES,
	DAILY_SUMMARY_PRESET,
	dailyAsOf,
	FIGURES,
	figureChangePercent,
	figureValue,
	keptByOrderingDirect,
	lastCompleteMonthKey,
	MONTHLY_FIGURES,
	MONTHLY_PRESET,
	monthlyAsOf,
	previousMonthKey,
	visibleFigures,
	type FigureId,
} from './summary-figures.ts'

const catalog = getCatalog('organization')

type Row = Record<string, unknown>
function sale(
	at: string,
	over: Row = {},
): Row {
	return {
		occurredAt: new Date(at),
		locationTimeZone: 'America/Chicago',
		currency: 'USD',
		channel: 'online_menu',
		customerType: 'new',
		entry: 'sale',
		netSales: 100,
		sales: 100,
		grossSales: 100,
		saleCount: 1,
		tips: 10,
		refunds: 0,
		loyaltyRewards: 0,
		...over,
	}
}

function run(id: FigureId, records: Row[], asOf: Date, zone = 'America/Chicago') {
	const spec = FIGURES[id]
	const preset = MONTHLY_FIGURES.includes(id) && !DAILY_SUMMARY_FIGURES.includes(id)
		? MONTHLY_PRESET
		: DAILY_SUMMARY_PRESET
	return runReport(catalog, spec.definition(preset), records as never, asOf, {
		timeZone: zone,
	})
}

function runPreset(
	id: FigureId,
	preset: typeof MONTHLY_PRESET | typeof DAILY_SUMMARY_PRESET,
	records: Row[],
	asOf: Date,
) {
	const result = runReport(
		catalog,
		FIGURES[id].definition(preset),
		records as never,
		asOf,
		{ timeZone: 'America/Chicago' },
	)
	if (isReportRunError(result)) throw new Error(result.message)
	return result
}

describe('summary figures (#121, #221)', () => {
	it('every figure is a valid report definition on the catalog', () => {
		for (const id of Object.keys(FIGURES) as FigureId[]) {
			for (const preset of [DAILY_SUMMARY_PRESET, MONTHLY_PRESET]) {
				const result = runReport(
					catalog,
					FIGURES[id].definition(preset),
					[],
					new Date('2026-11-27T12:00:00Z'),
					{ timeZone: 'UTC' },
				)
				expect(isReportRunError(result), `${id} ${preset}`).toBe(false)
			}
		}
	})

	it('reads yesterday and the same weekday last week', () => {
		const now = new Date('2026-11-27T14:00:00Z') // Friday; yesterday = Thu Nov 26
		const records = [
			sale('2026-11-26T18:00:00Z', { netSales: 100 }),
			sale('2026-11-26T19:00:00Z', { netSales: 50 }),
			sale('2026-11-19T18:00:00Z', { netSales: 80 }), // Thu a week earlier
			sale('2026-11-25T18:00:00Z', { netSales: 999 }), // another weekday
		]
		const asOf = dailyAsOf(now)
		const current = runPreset('netSales', DAILY_SUMMARY_PRESET, records, asOf.current)
		const previous = runPreset('netSales', DAILY_SUMMARY_PRESET, records, asOf.previous)
		const value = figureValue('netSales', current, previous)
		expect(value.entries).toEqual([{ currency: 'USD', value: 150 }])
		expect(value.previous).toEqual([{ currency: 'USD', value: 80 }])
		expect(figureChangePercent(value.entries[0]!, value.previous)).toBeCloseTo(87.5)
		const orders = figureValue(
			'orders',
			runPreset('orders', DAILY_SUMMARY_PRESET, records, asOf.current),
			runPreset('orders', DAILY_SUMMARY_PRESET, records, asOf.previous),
		)
		expect(orders.entries).toEqual([{ currency: null, value: 2 }])
		expect(orders.previous).toEqual([{ currency: null, value: 1 }])
	})

	it('cuts each location\'s own day and month in its own zone', () => {
		// 2026-11-01 03:00Z is Oct 31, 22:00 in Chicago but Nov 1, 06:00 in Riyadh.
		const records = [
			sale('2026-11-01T03:00:00Z', {
				locationTimeZone: 'America/Chicago',
				netSales: 10,
			}),
			sale('2026-11-01T03:00:00Z', {
				locationTimeZone: 'Asia/Riyadh',
				currency: 'SAR',
				netSales: 20,
			}),
			sale('2026-11-15T12:00:00Z', {
				locationTimeZone: 'America/Chicago',
				netSales: 100,
			}),
		]
		const nov = monthlyAsOf('2026-11')
		const current = runPreset('directSales', MONTHLY_PRESET, records, nov.current)
		const value = figureValue('directSales', current, null)
		// Chicago's Oct 31 sale is October's; Riyadh's is November's.
		expect(value.entries).toEqual([
			{ currency: 'SAR', value: 20 },
			{ currency: 'USD', value: 100 },
		])
		const oct = monthlyAsOf('2026-10')
		const october = figureValue(
			'directSales',
			runPreset('directSales', MONTHLY_PRESET, records, oct.current),
			null,
		)
		expect(october.entries).toEqual([{ currency: 'USD', value: 10 }])
	})

	it('never adds two currencies together', () => {
		const records = [
			sale('2026-11-10T12:00:00Z', { currency: 'USD', netSales: 100 }),
			sale('2026-11-11T12:00:00Z', { currency: 'SAR', netSales: 375 }),
		]
		const value = figureValue(
			'directSales',
			runPreset('directSales', MONTHLY_PRESET, records, monthlyAsOf('2026-11').current),
			null,
		)
		expect(value.entries).toHaveLength(2)
		expect(value.entries.map((e) => e.currency)).toEqual(['SAR', 'USD'])
	})

	it('counts the way the sales report counts: the orders figure equals the sale count', () => {
		const records = [
			sale('2026-11-10T12:00:00Z'),
			sale('2026-11-11T12:00:00Z', { customerType: 'returning' }),
			sale('2026-11-12T12:00:00Z', { customerType: 'station', channel: 'station_counter' }),
		]
		const asOf = monthlyAsOf('2026-11').current
		const at = (id: FigureId) =>
			figureValue(id, runPreset(id, MONTHLY_PRESET, records, asOf), null).entries[0]!.value
		expect(at('directOrders')).toBe(3)
		expect(at('newGuestOrders')).toBe(1)
		expect(at('returningGuestOrders')).toBe(1)
	})

	it('estimates what ordering direct kept from the owner\'s rate, per currency', () => {
		const online = [
			{ currency: 'USD', value: 1000 },
			{ currency: 'SAR', value: 400 },
		]
		expect(keptByOrderingDirect(online, 2500)).toEqual([
			{ currency: 'USD', value: 250 },
			{ currency: 'SAR', value: 100 },
		])
		expect(keptByOrderingDirect(online, 1850)[0]!.value).toBe(185)
	})

	it('only direct online channels count as direct online sales', () => {
		const records = [
			sale('2026-11-10T12:00:00Z', { channel: 'online_menu', netSales: 100 }),
			sale('2026-11-10T13:00:00Z', { channel: 'qr_table', netSales: 40 }),
			sale('2026-11-10T14:00:00Z', { channel: 'station_counter', netSales: 60 }),
			sale('2026-11-10T15:00:00Z', { channel: 'drop', netSales: 10 }),
		]
		const value = figureValue(
			'onlineSales',
			runPreset('onlineSales', MONTHLY_PRESET, records, monthlyAsOf('2026-11').current),
			null,
		)
		expect(value.entries).toEqual([{ currency: 'USD', value: 110 }])
	})

	it('hides a figure without its grant and reports modules that are off', () => {
		const grants = new Set(['sales', 'orders'])
		const result = visibleFigures(
			['directSales', 'bookings', 'callsAnswered', 'newReviews'],
			{ grants, modulesOn: new Set(['marketing']) },
		)
		expect(result.shown).toEqual(['directSales'])
		expect(result.off.sort()).toEqual(['phone_agent', 'reservations'])
		const noSales = visibleFigures(['directSales', 'directOrders'], {
			grants: new Set(),
			modulesOn: new Set(),
		})
		expect(noSales.shown).toEqual([])
		expect(noSales.off).toEqual([])
	})

	it('month helpers', () => {
		expect(previousMonthKey('2026-01')).toBe('2025-12')
		expect(previousMonthKey('2026-11')).toBe('2026-10')
		expect(lastCompleteMonthKey(new Date('2026-11-02T12:00:00Z'))).toBe('2026-10')
		expect(lastCompleteMonthKey(new Date('2026-01-02T12:00:00Z'))).toBe('2025-12')
	})
})
