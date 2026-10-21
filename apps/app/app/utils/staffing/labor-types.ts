import {
	FORECAST_SLOT_STATUSES,
	SALES_ENTRY_SOURCES,
	salesSourceSchema,
	TARGET_STATUSES,
	TIP_CADENCES,
	TIP_FULFILLMENTS,
	TIP_SPLIT_BASES,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/labor` (and the forecast under
 * `/operator/schedule`), parsed in the browser. They mirror the response types
 * in `@repo/staffing` (`labor-api.ts`); `labor-types.test.ts` parses fixtures
 * typed with those types so a drift fails there. Money keys that the server
 * leaves out without the grant stay optional.
 */

export const moneyRowSchema = z.object({
	currency: z.string(),
	costMinor: z.number(),
	salesMinor: z.number().nullable(),
	laborBp: z.number().nullable(),
	salesPerLaborHourMinor: z.number().nullable(),
	targetStatus: z.enum(TARGET_STATUSES).optional(),
})
export type LaborMoneyRow = z.infer<typeof moneyRowSchema>

export const dayRowSchema = z.object({
	date: z.string(),
	paidMinutes: z.number(),
	overtimeMinutes: z.number(),
	cards: z.number(),
	people: z.number(),
	hasSales: z.boolean(),
	money: z.array(moneyRowSchema),
})
export type LaborDayRow = z.infer<typeof dayRowSchema>

export const summarySchema = z.object({
	estimate: z.literal(true),
	scopeId: z.string(),
	timeZone: z.string(),
	from: z.string(),
	to: z.string(),
	salesSource: salesSourceSchema,
	salesComplete: z.boolean(),
	targetBp: z.number().nullable(),
	targetColoring: z.boolean(),
	days: z.array(dayRowSchema),
	totals: z.object({
		paidMinutes: z.number(),
		overtimeMinutes: z.number(),
		cards: z.number(),
		salesDays: z.number(),
		daysWithoutSales: z.number(),
		money: z.array(moneyRowSchema),
	}),
	currencyMismatch: z
		.object({ costOnly: z.array(z.string()), salesOnly: z.array(z.string()) })
		.nullable(),
	unpricedMinutes: z.number(),
	openCards: z.number(),
	truncated: z.boolean(),
})
export type LaborSummary = z.infer<typeof summarySchema>

export const positionsSchema = z.object({
	positions: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			nameAr: z.string().nullable(),
		}),
	),
})
export type LaborPosition = z.infer<typeof positionsSchema>['positions'][number]

export const settingsSchema = z.object({
	scopeId: z.string(),
	salesSource: salesSourceSchema,
	ordersPerLaborHour: z.record(z.string(), z.number()),
	/** Standards by demand unit (`orders`, `visits`), then position id. */
	demandPerLaborHour: z
		.record(z.string(), z.record(z.string(), z.number()))
		.default({}),
	configured: z.boolean(),
	updatedAt: z.number().nullable(),
})
export type LaborSettings = z.infer<typeof settingsSchema>

export const salesEntrySchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	date: z.string(),
	netSalesMinor: z.number(),
	currency: z.string(),
	source: z.enum(SALES_ENTRY_SOURCES),
	note: z.string().nullable(),
	updatedAt: z.number(),
})
export type SalesEntry = z.infer<typeof salesEntrySchema>

export const salesEntriesSchema = z.object({
	scopeId: z.string(),
	from: z.string(),
	to: z.string(),
	entries: z.array(salesEntrySchema),
})

export const bulkResultSchema = z.object({
	created: z.number(),
	updated: z.number(),
	unchanged: z.number(),
})
export type BulkResult = z.infer<typeof bulkResultSchema>

export const tipSettingsSchema = z.object({
	scopeId: z.string(),
	splitBasis: z.enum(TIP_SPLIT_BASES),
	cadence: z.enum(TIP_CADENCES),
	cardFeeBp: z.number(),
	fulfillment: z.array(z.enum(TIP_FULFILLMENTS)),
	positionPercentBp: z.record(z.string(), z.number()),
	configured: z.boolean(),
	updatedAt: z.number().nullable(),
})
export type TipSettings = z.infer<typeof tipSettingsSchema>

const tipPersonSchema = z.object({
	staffId: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	firstNameAr: z.string().nullable(),
	lastNameAr: z.string().nullable(),
	employeeNumber: z.string().nullable(),
	minutes: z.number(),
	shareMinor: z.number(),
})
export type TipPerson = z.infer<typeof tipPersonSchema>

const tipGroupSchema = z.object({
	key: z.string(),
	onlineTipsMinor: z.number(),
	cardFeeMinor: z.number(),
	cashTipsMinor: z.number(),
	poolMinor: z.number(),
	unallocatedMinor: z.number(),
})

const tipPoolSchema = z.object({
	currency: z.string(),
	onlineTipsMinor: z.number(),
	cardFeeMinor: z.number(),
	cashTipsMinor: z.number(),
	poolMinor: z.number(),
	unallocatedMinor: z.number(),
	groups: z.array(tipGroupSchema),
	people: z.array(tipPersonSchema),
})
export type TipPool = z.infer<typeof tipPoolSchema>

export const tipReportSchema = z.object({
	estimate: z.literal(true),
	payout: z.literal(false),
	scopeId: z.string(),
	timeZone: z.string(),
	from: z.string(),
	to: z.string(),
	settings: tipSettingsSchema,
	pools: z.array(tipPoolSchema),
	undeclaredCurrencyCashTips: z.number(),
	openCards: z.number(),
	unapprovedCards: z.number(),
	ineligibleMinutes: z.number(),
	truncated: z.boolean(),
})
export type TipReport = z.infer<typeof tipReportSchema>

export const exportSchema = z.object({
	filename: z.string(),
	kind: z.string(),
	rowCount: z.number(),
	headers: z.array(z.string()),
	rows: z.array(
		z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
	),
	csv: z.string(),
})

export const forecastSchema = z.object({
	kind: z.literal('forecast_gap'),
	estimate: z.literal(true),
	method: z.string(),
	source: z.string(),
	/** The demand sources read, orders first (older servers send none). */
	sources: z.array(z.object({ id: z.string(), unit: z.string() })).default([]),
	weeks: z.number(),
	windowStart: z.string(),
	windowEnd: z.string(),
	timeZone: z.string(),
	configured: z.boolean(),
	days: z.array(
		z.object({
			date: z.string(),
			hours: z.array(
				z.object({
					hour: z.number(),
					orders: z.number(),
					booked: z.number(),
					/** Units already booked per demand source: counts only. */
					bookedBySource: z.record(z.string(), z.number()).default({}),
					unitsBySource: z.record(z.string(), z.number()).default({}),
					needed: z.number(),
					scheduled: z.number(),
					short: z.number(),
					surplus: z.number(),
					status: z.enum(FORECAST_SLOT_STATUSES),
				}),
			),
			neededHours: z.number(),
			scheduledHours: z.number(),
			shortHours: z.number(),
			surplusHours: z.number(),
			unpositionedHours: z.number(),
			byPosition: z.array(
				z.object({
					positionId: z.string(),
					ordersPerLaborHour: z.number(),
					standards: z.record(z.string(), z.number()).default({}),
					neededHours: z.number(),
					scheduledHours: z.number(),
				}),
			),
		}),
	),
})
export type Forecast = z.infer<typeof forecastSchema>
export type ForecastDayRow = Forecast['days'][number]
