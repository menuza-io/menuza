import { z } from 'zod'
import { type CsvCell } from './csv.ts'
import { currencySchema, localDateSchema } from './schemas.ts'

/**
 * Wire contracts of `/operator/labor`: the labor summary (hours, estimated
 * cost, sales and the labor share, one row per local day), the per-scope
 * sales source, manual sales entries, the tip-pool report and the orders-based
 * forecast gap. Request schemas are shared by the App and tenant-api and are
 * `.strict()`; responses leave money out entirely (the keys are absent) when
 * the token lacks the grant. No UI strings: codes are keys the App translates.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** Earliest and latest date the labor views accept. */
export const LABOR_MIN_DATE = '2000-01-01'
export const LABOR_MAX_DATE = '2099-12-31'
/** Most days one labor or tip view may span (about one quarter). */
export const LABOR_MAX_RANGE_DAYS = 93
/** Most rows one bulk sales save may carry (a year of days). */
export const SALES_MAX_BULK_ROWS = 366
/** Largest sales file the browser parses (bytes of text). */
export const SALES_CSV_MAX_BYTES = 200_000

const dateSchema = localDateSchema.refine(
	(value) => value >= LABOR_MIN_DATE && value <= LABOR_MAX_DATE,
	`Date must be between ${LABOR_MIN_DATE} and ${LABOR_MAX_DATE}`,
)

/** Whole calendar days from `from` to `to`, inclusive of both ends. */
function spanDays(from: string, to: string): number {
	const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
	const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
	return (
		Math.round(
			(Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
		) + 1
	)
}

// ---------------------------------------------------------------------------
// Sales source
// ---------------------------------------------------------------------------

/**
 * Where a scope's sales for the labor share come from.
 *
 * - `online_orders`: counted online orders only. Sales made any other way are
 *   not in this number, so the share is overstated by an unknown factor and is
 *   never judged against a target.
 * - `online_only`: the scope sells through online orders only, so the
 *   orders are all of its sales and the share may be judged against a target.
 * - `manual`: sales the team enters by day or uploads as a file. They are the
 *   whole of the scope's sales; online orders are not added on top.
 */
export const SALES_SOURCES = ['online_orders', 'online_only', 'manual'] as const
export const salesSourceSchema = z.enum(SALES_SOURCES)
export type SalesSource = (typeof SALES_SOURCES)[number]

export const DEFAULT_SALES_SOURCE: SalesSource = 'manual'

/** Whether the sales behind a share cover everything the scope sells. */
export function salesSourceCoversAllSales(source: SalesSource): boolean {
	return source !== 'online_orders'
}

/** Whether the sales come from counted online orders (as opposed to typed in). */
export function salesSourceUsesOrders(source: SalesSource): boolean {
	return source !== 'manual'
}

/**
 * A "target met or missed" judgement is only fair when the sales are complete.
 * Online orders alone are not, unless the scope is flagged online-only.
 */
export function targetColoringAllowed(source: SalesSource): boolean {
	return salesSourceCoversAllSales(source)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const laborRangeQuerySchema = z
	.object({
		scopeId: idSchema,
		from: dateSchema,
		to: dateSchema,
	})
	.strict()
	.refine((q) => q.to >= q.from, {
		message: 'The end date must not be before the start date',
		path: ['to'],
	})
	.refine((q) => spanDays(q.from, q.to) <= LABOR_MAX_RANGE_DAYS, {
		message: `Choose at most ${LABOR_MAX_RANGE_DAYS} days`,
		path: ['to'],
	})
export type LaborRangeQuery = z.infer<typeof laborRangeQuerySchema>

export const laborScopeQuerySchema = z.object({ scopeId: idSchema }).strict()
export type LaborScopeQuery = z.infer<typeof laborScopeQuerySchema>

export function laborRangeDays(from: string, to: string): number {
	return spanDays(from, to)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Orders per labor hour a position is expected to handle (the staffing standard). */
export const ORDERS_PER_HOUR_MIN = 0.5
export const ORDERS_PER_HOUR_MAX = 200
export const MAX_STANDARD_POSITIONS = 60

const ordersPerHourSchema = z
	.number()
	.min(ORDERS_PER_HOUR_MIN)
	.max(ORDERS_PER_HOUR_MAX)
	.refine(
		(value) => Math.round(value * 10) / 10 === value,
		'At most one decimal place',
	)

const standardsSchema = z
	.record(idSchema, ordersPerHourSchema)
	.refine(
		(record) => Object.keys(record).length <= MAX_STANDARD_POSITIONS,
		'Too many positions',
	)

export const laborSettingsUpdateSchema = z
	.object({
		scopeId: idSchema,
		salesSource: salesSourceSchema.optional(),
		/** The full set of standards: positions left out have no standard. */
		ordersPerLaborHour: standardsSchema.optional(),
	})
	.strict()
	.refine(
		(body) =>
			body.salesSource !== undefined || body.ordersPerLaborHour !== undefined,
		'Nothing to change',
	)
export type LaborSettingsUpdate = z.infer<typeof laborSettingsUpdateSchema>

/** A position as the labor screens list it: a name to pick by, no pay. */
export type LaborPositionView = {
	id: string
	name: string
	nameAr: string | null
}

export type LaborSettingsView = {
	scopeId: string
	salesSource: SalesSource
	/** Positions with a standard; absent positions are not forecast. */
	ordersPerLaborHour: Record<string, number>
	/** False until someone saved a setting for the scope (defaults shown). */
	configured: boolean
	updatedAt: number | null
}

// ---------------------------------------------------------------------------
// Manual sales entries
// ---------------------------------------------------------------------------

/** Largest single day of net sales one entry may hold, in minor units. */
export const SALES_MAX_MINOR = 100_000_000_00

export const salesAmountSchema = z.number().int().min(0).max(SALES_MAX_MINOR)

const salesNoteSchema = z.string().trim().max(200)

export const salesEntryPutSchema = z
	.object({
		scopeId: idSchema,
		date: dateSchema,
		netSalesMinor: salesAmountSchema,
		currency: currencySchema,
		note: salesNoteSchema.nullable().optional(),
	})
	.strict()
export type SalesEntryPut = z.infer<typeof salesEntryPutSchema>

export const salesBulkSchema = z
	.object({
		scopeId: idSchema,
		currency: currencySchema,
		entries: z
			.array(
				z
					.object({
						date: dateSchema,
						netSalesMinor: salesAmountSchema,
						note: salesNoteSchema.nullable().optional(),
					})
					.strict(),
			)
			.min(1)
			.max(SALES_MAX_BULK_ROWS),
	})
	.strict()
	.refine(
		(body) =>
			new Set(body.entries.map((entry) => entry.date)).size ===
			body.entries.length,
		{ message: 'Each date may appear once', path: ['entries'] },
	)
export type SalesBulk = z.infer<typeof salesBulkSchema>

export const salesDeleteQuerySchema = z
	.object({ scopeId: idSchema, date: dateSchema })
	.strict()

export const SALES_ENTRY_SOURCES = ['manual', 'csv'] as const
export type SalesEntrySource = (typeof SALES_ENTRY_SOURCES)[number]

export type SalesEntryView = {
	id: string
	scopeId: string
	date: string
	netSalesMinor: number
	currency: string
	source: SalesEntrySource
	note: string | null
	updatedAt: number
}

export type SalesEntriesView = {
	scopeId: string
	from: string
	to: string
	entries: SalesEntryView[]
}

export type SalesBulkResult = {
	created: number
	updated: number
	unchanged: number
}

// ---------------------------------------------------------------------------
// Labor summary
// ---------------------------------------------------------------------------

export const TARGET_STATUSES = ['within', 'over'] as const
export type TargetStatus = (typeof TARGET_STATUSES)[number]

/** One currency of one day (or of the whole range). Never added across currencies. */
export type LaborMoneyView = {
	currency: string
	/** Estimated wages from rate snapshots and the shared time math. */
	costMinor: number
	/** Null when no sales are known for the day (manual sales not entered). */
	salesMinor: number | null
	/** Cost as a share of sales, in basis points. Null without sales. */
	laborBp: number | null
	/** Sales per paid labor hour, in minor units. Null without sales or hours. */
	salesPerLaborHourMinor: number | null
	/** Set only when the source covers all sales and a target exists. */
	targetStatus?: TargetStatus
}

export type LaborDayView = {
	date: string
	paidMinutes: number
	/** Daily plus weekly overtime and double time. */
	overtimeMinutes: number
	cards: number
	people: number
	/** Sales were recorded or counted for the day (always true for online sources). */
	hasSales: boolean
	money: LaborMoneyView[]
}

export type LaborTotalsView = {
	paidMinutes: number
	overtimeMinutes: number
	cards: number
	/** Days with sales behind them: the days the share is computed over. */
	salesDays: number
	/** Days in the range without sales (manual source only). */
	daysWithoutSales: number
	money: LaborMoneyView[]
}

export type LaborCurrencyMismatch = {
	/** Wage currencies with no sales in the same currency. */
	costOnly: string[]
	/** Sales currencies with no wages in the same currency. */
	salesOnly: string[]
}

export type LaborSummaryView = {
	/** Always true: figures are estimates, never payroll. */
	estimate: true
	scopeId: string
	timeZone: string
	from: string
	to: string
	salesSource: SalesSource
	/** Whether the sales behind the share are all of the scope's sales. */
	salesComplete: boolean
	targetBp: number | null
	/** Only when true may the screen color a share as met or missed. */
	targetColoring: boolean
	days: LaborDayView[]
	totals: LaborTotalsView
	/** Rows left out of a share because their currency has no matching sales. */
	currencyMismatch: LaborCurrencyMismatch | null
	/** Worked minutes with no pay rate, so no cost figure. */
	unpricedMinutes: number
	/** Cards still open: their minutes are measured up to now. */
	openCards: number
	/** The range held more cards than one view returns. */
	truncated: boolean
}

/** A table the browser saves as a file; the CSV text is formula-safe with a byte order mark. */
export type LaborExport = {
	filename: string
	kind: 'labor_summary' | 'tip_pool'
	rowCount: number
	headers: string[]
	rows: CsvCell[][]
	csv: string
}

// ---------------------------------------------------------------------------
// Tip pool
// ---------------------------------------------------------------------------

export const TIP_SPLIT_BASES = ['hours', 'position_percent'] as const
export const tipSplitBasisSchema = z.enum(TIP_SPLIT_BASES)
export type TipSplitBasis = (typeof TIP_SPLIT_BASES)[number]

export const TIP_CADENCES = ['period', 'daily'] as const
export const tipCadenceSchema = z.enum(TIP_CADENCES)
export type TipCadence = (typeof TIP_CADENCES)[number]

export const TIP_FULFILLMENTS = ['pickup', 'delivery'] as const
export const tipFulfillmentSchema = z.enum(TIP_FULFILLMENTS)
export type TipFulfillment = (typeof TIP_FULFILLMENTS)[number]

/** The largest card-fee deduction allowed: 10 percent, in basis points. */
export const TIP_CARD_FEE_MAX_BP = 1000

export const tipPoolSettingsUpdateSchema = z
	.object({
		scopeId: idSchema,
		splitBasis: tipSplitBasisSchema,
		cadence: tipCadenceSchema,
		/** Share of online-order tips withheld to cover card fees, in basis points. */
		cardFeeBp: z.number().int().min(0).max(TIP_CARD_FEE_MAX_BP),
		/** Which online orders' tips go into the pool. Empty means online tips stay out. */
		fulfillment: z
			.array(tipFulfillmentSchema)
			.max(TIP_FULFILLMENTS.length)
			.refine((list) => new Set(list).size === list.length, 'Duplicates'),
		/** Share of the pool each position takes, in basis points (position split only). */
		positionPercentBp: z
			.record(idSchema, z.number().int().min(0).max(10_000))
			.refine(
				(record) => Object.keys(record).length <= MAX_STANDARD_POSITIONS,
				'Too many positions',
			),
	})
	.strict()
	.refine(
		(body) =>
			body.splitBasis !== 'position_percent' ||
			Object.values(body.positionPercentBp).reduce((s, v) => s + v, 0) ===
				10_000,
		{
			message: 'Position percentages must add up to 100',
			path: ['positionPercentBp'],
		},
	)
export type TipPoolSettingsUpdate = z.infer<typeof tipPoolSettingsUpdateSchema>

export type TipPoolSettingsView = {
	scopeId: string
	splitBasis: TipSplitBasis
	cadence: TipCadence
	cardFeeBp: number
	fulfillment: TipFulfillment[]
	positionPercentBp: Record<string, number>
	/** False until someone saved a setting for the scope (defaults shown). */
	configured: boolean
	updatedAt: number | null
}

export type TipPoolPerson = {
	staffId: string
	firstName: string
	lastName: string
	firstNameAr: string | null
	lastNameAr: string | null
	employeeNumber: string | null
	/** Paid minutes of tip-eligible cards that went into the split. */
	minutes: number
	shareMinor: number
}

export type TipPoolGroup = {
	/** The day (`YYYY-MM-DD`) for a daily split, or `period` for the whole range. */
	key: string
	onlineTipsMinor: number
	cardFeeMinor: number
	cashTipsMinor: number
	poolMinor: number
	/** Pool left because nobody eligible worked, or no worked position has a share. */
	unallocatedMinor: number
}

export type TipPoolCurrency = {
	currency: string
	onlineTipsMinor: number
	cardFeeMinor: number
	cashTipsMinor: number
	poolMinor: number
	unallocatedMinor: number
	groups: TipPoolGroup[]
	people: TipPoolPerson[]
}

export type TipPoolReport = {
	/** A report to help a manager decide; it pays nobody. */
	estimate: true
	payout: false
	scopeId: string
	timeZone: string
	from: string
	to: string
	settings: TipPoolSettingsView
	pools: TipPoolCurrency[]
	/** Declared cash tips on cards with no pay currency, left out of every pool. */
	undeclaredCurrencyCashTips: number
	/** Cards still open or awaiting approval, whose hours may still change. */
	openCards: number
	unapprovedCards: number
	/** Tip-eligible minutes on cards with no tip-eligible pay row (not in any split). */
	ineligibleMinutes: number
	truncated: boolean
}

// ---------------------------------------------------------------------------
// Forecast gap
// ---------------------------------------------------------------------------

export const forecastQuerySchema = z
	.object({ scopeId: idSchema, date: dateSchema })
	.strict()
export type ForecastQuery = z.infer<typeof forecastQuerySchema>

export const FORECAST_SLOT_STATUSES = ['quiet', 'ok', 'short', 'over'] as const
export type ForecastSlotStatus = (typeof FORECAST_SLOT_STATUSES)[number]

export type ForecastSlot = {
	hour: number
	/** Expected orders this hour: the median of the same weekday, never below what is booked. */
	orders: number
	/** Paid and active orders already placed for this hour. */
	booked: number
	/** People the standards say this hour needs, summed over positions. */
	needed: number
	/** People scheduled this hour in the positions that have a standard. */
	scheduled: number
	short: number
	surplus: number
	status: ForecastSlotStatus
}

export type ForecastPositionTotal = {
	positionId: string
	ordersPerLaborHour: number
	neededHours: number
	scheduledHours: number
}

export type ForecastDay = {
	date: string
	hours: ForecastSlot[]
	neededHours: number
	scheduledHours: number
	shortHours: number
	surplusHours: number
	/** Scheduled hours of shifts with no position, which no standard can count. */
	unpositionedHours: number
	byPosition: ForecastPositionTotal[]
}

export type ForecastGapView = {
	kind: 'forecast_gap'
	estimate: true
	method: 'median_orders_per_labor_hour'
	source: 'online_orders'
	weeks: number
	windowStart: string
	windowEnd: string
	timeZone: string
	/** False until at least one position has a standard (nothing to compare). */
	configured: boolean
	days: ForecastDay[]
}
