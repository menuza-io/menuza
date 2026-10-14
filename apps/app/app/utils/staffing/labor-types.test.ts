import {
	type ForecastGapView,
	type LaborSettingsView,
	type LaborSummaryView,
	type SalesEntryView,
	type TipPoolReport,
} from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import {
	forecastSchema,
	salesEntrySchema,
	settingsSchema,
	summarySchema,
	tipReportSchema,
} from './labor-types.ts'

/**
 * Fixtures typed with the server's own types: if the wire shape drifts, these
 * stop compiling or stop parsing, and the screen never meets a surprise.
 */

const summary: LaborSummaryView = {
	estimate: true,
	scopeId: 'loc-1',
	timeZone: 'America/Chicago',
	from: '2026-03-02',
	to: '2026-03-03',
	salesSource: 'manual',
	salesComplete: true,
	targetBp: 2000,
	targetColoring: true,
	days: [
		{
			date: '2026-03-02',
			paidMinutes: 480,
			overtimeMinutes: 0,
			cards: 1,
			people: 1,
			hasSales: true,
			money: [
				{
					currency: 'USD',
					costMinor: 16_000,
					salesMinor: 100_000,
					laborBp: 1600,
					salesPerLaborHourMinor: 12_500,
					targetStatus: 'within',
				},
			],
		},
	],
	totals: {
		paidMinutes: 480,
		overtimeMinutes: 0,
		cards: 1,
		salesDays: 1,
		daysWithoutSales: 1,
		money: [
			{
				currency: 'USD',
				costMinor: 16_000,
				salesMinor: null,
				laborBp: null,
				salesPerLaborHourMinor: null,
			},
		],
	},
	currencyMismatch: { costOnly: ['SAR'], salesOnly: [] },
	unpricedMinutes: 0,
	openCards: 0,
	truncated: false,
}

describe('wire shapes', () => {
	it('parses a labor summary, with and without a target status', () => {
		expect(summarySchema.parse(summary)).toEqual(summary)
	})
	it('refuses a summary whose estimate flag was dropped', () => {
		expect(
			summarySchema.safeParse({ ...summary, estimate: false }).success,
		).toBe(false)
	})
	it('parses settings and sales entries', () => {
		const settings: LaborSettingsView = {
			scopeId: 'loc-1',
			salesSource: 'online_only',
			ordersPerLaborHour: { cook: 12.5 },
			configured: true,
			updatedAt: 1,
		}
		expect(settingsSchema.parse(settings)).toEqual(settings)
		const entry: SalesEntryView = {
			id: 'e1',
			scopeId: 'loc-1',
			date: '2026-03-02',
			netSalesMinor: 100_000,
			currency: 'USD',
			source: 'csv',
			note: null,
			updatedAt: 1,
		}
		expect(salesEntrySchema.parse(entry)).toEqual(entry)
	})
	it('refuses an unknown sales source rather than guessing', () => {
		expect(
			settingsSchema.safeParse({
				scopeId: 'l',
				salesSource: 'pos',
				ordersPerLaborHour: {},
				configured: true,
				updatedAt: null,
			}).success,
		).toBe(false)
	})
	it('parses a tip report that says it pays nobody', () => {
		const report: TipPoolReport = {
			estimate: true,
			payout: false,
			scopeId: 'loc-1',
			timeZone: 'UTC',
			from: '2026-03-02',
			to: '2026-03-03',
			settings: {
				scopeId: 'loc-1',
				splitBasis: 'hours',
				cadence: 'period',
				cardFeeBp: 300,
				fulfillment: ['pickup'],
				positionPercentBp: {},
				configured: false,
				updatedAt: null,
			},
			pools: [
				{
					currency: 'USD',
					onlineTipsMinor: 1500,
					cardFeeMinor: 45,
					cashTipsMinor: 2000,
					poolMinor: 3455,
					unallocatedMinor: 0,
					groups: [],
					people: [
						{
							staffId: 's1',
							firstName: 'Ana',
							lastName: 'Adams',
							firstNameAr: null,
							lastNameAr: null,
							employeeNumber: null,
							minutes: 480,
							shareMinor: 3455,
						},
					],
				},
			],
			undeclaredCurrencyCashTips: 0,
			openCards: 0,
			unapprovedCards: 0,
			ineligibleMinutes: 0,
			truncated: false,
		}
		expect(tipReportSchema.parse(report)).toEqual(report)
		expect(tipReportSchema.safeParse({ ...report, payout: true }).success).toBe(
			false,
		)
	})
	it('parses a forecast gap', () => {
		const forecast: ForecastGapView = {
			kind: 'forecast_gap',
			estimate: true,
			method: 'median_orders_per_labor_hour',
			source: 'online_orders',
			weeks: 8,
			windowStart: '2026-01-05',
			windowEnd: '2026-03-01',
			timeZone: 'America/Chicago',
			configured: true,
			days: [
				{
					date: '2026-03-09',
					hours: Array.from({ length: 24 }, (_, hour) => ({
						hour,
						orders: 0,
						booked: 0,
						needed: 0,
						scheduled: 0,
						short: 0,
						surplus: 0,
						status: 'quiet' as const,
					})),
					neededHours: 0,
					scheduledHours: 0,
					shortHours: 0,
					surplusHours: 0,
					unpositionedHours: 0,
					byPosition: [],
				},
			],
		}
		expect(forecastSchema.parse(forecast)).toEqual(forecast)
	})
})
