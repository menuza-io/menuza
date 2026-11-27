import { getCatalog } from './catalog.ts'
import {
	createReportDefinition,
	type FilterCondition,
	type ReportDefinition,
	type ReportResult,
	type TimeframePreset,
} from './dsl.ts'

/**
 * The fixed figures of the daily summary (#121) and the monthly results page
 * and email (#221). Each figure is one report definition on an existing
 * subject, run by the same engine as every other report (`runReport`, in the
 * browser through `POST /analytics/query` or in-process in the region), so a
 * summary can never disagree with the matching report. Pure: no I/O.
 *
 * - Counts follow the subjects' own rules (`sales`: web and QR orders that
 *   count toward sales plus paid Station sales; bookings that took a table).
 * - Money is grouped by currency, one entry each, never added across them.
 * - Days and months are each location's own (the subjects carry a time-zone
 *   field), so "all locations" sums every location's own day or month.
 * - A figure is shown only to a viewer whose grants cover its subject.
 */

export type FigureFormat = 'currency' | 'number' | 'percent' | 'rating'

export type FigureId =
	| 'netSales'
	| 'orders'
	| 'averageSale'
	| 'tips'
	| 'refunds'
	| 'laborCost'
	| 'laborPercent'
	| 'covers'
	| 'newReviews'
	| 'averageRating'
	| 'directSales'
	| 'directOrders'
	| 'onlineSales'
	| 'newGuestOrders'
	| 'returningGuestOrders'
	| 'bookings'
	| 'callsAnswered'
	| 'callsHandled'
	| 'attributedSales'
	| 'attributedOrders'
	| 'loyaltyRewards'

/** The modules a figure can need switched on (their flag off hides the figure). */
export type FigureModule =
	| 'staffing_labor'
	| 'reservations'
	| 'phone_agent'
	| 'marketing'
	| 'loyalty'

export type FigureSpec = {
	id: FigureId
	/** English label; screens and emails translate it by `id`. */
	label: string
	format: FigureFormat
	/** The engine subject the viewer's grants must cover (`catalogForGrants`). */
	subject: string
	/** Where the rows come from: the region's analytics, or the control plane. */
	source: 'region' | 'control-plane'
	module?: FigureModule
	definition: (preset: TimeframePreset) => ReportDefinition
}

function timeField(subject: string): string {
	const found = getCatalog('organization')
		.subjects.find((s) => s.id === subject)
		?.fields.find((f) => f.timeframe)?.id
	if (!found) throw new Error(`No time field on subject ${subject}`)
	return found
}

function figure(input: {
	subject: string
	title: string
	preset: TimeframePreset
	measure: 'count' | 'sum' | 'ratio' | 'average'
	valueField?: string
	/** One entry per currency (money, and ratios over money). */
	byCurrency?: boolean
	filters?: FilterCondition[]
}): ReportDefinition {
	return createReportDefinition({
		subject: input.subject,
		timeframe: { field: timeField(input.subject), preset: input.preset },
		groupBy: input.byCurrency ? ['currency'] : [],
		visualization: {
			chartStyle: input.byCurrency ? 'table' : 'single_number',
			measure: input.measure,
			...(input.valueField ? { valueField: input.valueField } : {}),
			sortBy: 'label',
			hideCounts: false,
		},
		filters: input.filters?.length
			? { combinator: 'and', conditions: input.filters }
			: { combinator: 'and', conditions: [] },
		compare: 'none',
		settings: {
			title: input.title,
			notes: '',
			// The caller's zone (the schedule's, or the viewer's) only matters for
			// records that carry no location zone of their own.
			timezone: 'user',
			includeToday: false,
		},
	})
}

const DIRECT_ONLINE_CHANNELS = ['online_menu', 'drop', 'qr_poster']

const salesFigure = (
	id: FigureId,
	label: string,
	valueField: string,
	measure: 'sum' | 'ratio' = 'sum',
	extra: Partial<Parameters<typeof figure>[0]> = {},
): FigureSpec => ({
	id,
	label,
	format: 'currency',
	subject: 'sales',
	source: 'region',
	definition: (preset) =>
		figure({
			subject: 'sales',
			title: label,
			preset,
			measure,
			valueField,
			byCurrency: true,
			...extra,
		}),
})

const SALE_COUNT = (
	id: FigureId,
	label: string,
	filters?: FilterCondition[],
): FigureSpec => ({
	id,
	label,
	format: 'number',
	subject: 'sales',
	source: 'region',
	definition: (preset) =>
		figure({
			subject: 'sales',
			title: label,
			preset,
			measure: 'sum',
			valueField: 'saleCount',
			filters,
		}),
})

const COUNTED_ORDER: FilterCondition = {
	field: 'countsTowardSales',
	operator: 'eq',
	value: 'true',
}

export const FIGURES: Readonly<Record<FigureId, FigureSpec>> = {
	netSales: salesFigure('netSales', 'Net sales', 'netSales'),
	orders: SALE_COUNT('orders', 'Orders'),
	averageSale: salesFigure('averageSale', 'Average sale', 'averageSale', 'ratio'),
	tips: salesFigure('tips', 'Tips', 'tips'),
	refunds: salesFigure('refunds', 'Refunds', 'refunds'),
	laborCost: {
		id: 'laborCost',
		label: 'Labor cost',
		format: 'currency',
		subject: 'labor_daily',
		source: 'region',
		module: 'staffing_labor',
		definition: (preset) =>
			figure({
				subject: 'labor_daily',
				title: 'Labor cost',
				preset,
				measure: 'sum',
				valueField: 'laborCost',
				byCurrency: true,
			}),
	},
	laborPercent: {
		id: 'laborPercent',
		label: 'Labor cost percent',
		format: 'percent',
		subject: 'labor_daily',
		source: 'region',
		module: 'staffing_labor',
		definition: (preset) =>
			figure({
				subject: 'labor_daily',
				title: 'Labor cost percent',
				preset,
				measure: 'ratio',
				valueField: 'laborCostPercent',
				byCurrency: true,
			}),
	},
	covers: {
		id: 'covers',
		label: 'Covers',
		format: 'number',
		subject: 'bookings',
		source: 'region',
		module: 'reservations',
		definition: (preset) =>
			figure({
				subject: 'bookings',
				title: 'Covers',
				preset,
				measure: 'sum',
				valueField: 'covers',
				filters: [{ field: 'isBooked', operator: 'eq', value: '1' }],
			}),
	},
	bookings: {
		id: 'bookings',
		label: 'Table bookings',
		format: 'number',
		subject: 'bookings',
		source: 'region',
		module: 'reservations',
		definition: (preset) =>
			figure({
				subject: 'bookings',
				title: 'Table bookings',
				preset,
				measure: 'count',
				filters: [{ field: 'isBooked', operator: 'eq', value: '1' }],
			}),
	},
	newReviews: {
		id: 'newReviews',
		label: 'New reviews',
		format: 'number',
		subject: 'reviews',
		source: 'control-plane',
		definition: (preset) =>
			figure({ subject: 'reviews', title: 'New reviews', preset, measure: 'count' }),
	},
	averageRating: {
		id: 'averageRating',
		label: 'Average rating',
		format: 'rating',
		subject: 'reviews',
		source: 'control-plane',
		definition: (preset) =>
			figure({
				subject: 'reviews',
				title: 'Average rating',
				preset,
				measure: 'average',
				valueField: 'stars',
			}),
	},
	directSales: salesFigure('directSales', 'Direct sales', 'netSales'),
	directOrders: SALE_COUNT('directOrders', 'Direct orders'),
	onlineSales: salesFigure('onlineSales', 'Direct online sales', 'netSales', 'sum', {
		filters: [
			{ field: 'channel', operator: 'in', value: DIRECT_ONLINE_CHANNELS },
		],
	}),
	newGuestOrders: SALE_COUNT('newGuestOrders', 'Orders from new guests', [
		{ field: 'customerType', operator: 'eq', value: 'new' },
	]),
	returningGuestOrders: SALE_COUNT(
		'returningGuestOrders',
		'Orders from returning guests',
		[{ field: 'customerType', operator: 'eq', value: 'returning' }],
	),
	callsAnswered: {
		id: 'callsAnswered',
		label: 'Calls answered by the phone agent',
		format: 'number',
		subject: 'phone_calls',
		source: 'region',
		module: 'phone_agent',
		definition: (preset) =>
			figure({
				subject: 'phone_calls',
				title: 'Calls answered by the phone agent',
				preset,
				measure: 'count',
			}),
	},
	callsHandled: {
		id: 'callsHandled',
		label: 'Calls handled without staff',
		format: 'number',
		subject: 'phone_calls',
		source: 'region',
		module: 'phone_agent',
		definition: (preset) =>
			figure({
				subject: 'phone_calls',
				title: 'Calls handled without staff',
				preset,
				measure: 'count',
				filters: [{ field: 'resolvedByAssistant', operator: 'eq', value: 'true' }],
			}),
	},
	attributedSales: {
		id: 'attributedSales',
		label: 'Sales from your emails and texts',
		format: 'currency',
		subject: 'orders',
		source: 'region',
		module: 'marketing',
		definition: (preset) =>
			figure({
				subject: 'orders',
				title: 'Sales from your emails and texts',
				preset,
				measure: 'sum',
				valueField: 'total',
				byCurrency: true,
				filters: [
					COUNTED_ORDER,
					{ field: 'attributedChannel', operator: 'in', value: ['email', 'sms'] },
				],
			}),
	},
	attributedOrders: {
		id: 'attributedOrders',
		label: 'Orders from your emails and texts',
		format: 'number',
		subject: 'orders',
		source: 'region',
		module: 'marketing',
		definition: (preset) =>
			figure({
				subject: 'orders',
				title: 'Orders from your emails and texts',
				preset,
				measure: 'count',
				filters: [
					COUNTED_ORDER,
					{ field: 'attributedChannel', operator: 'in', value: ['email', 'sms'] },
				],
			}),
	},
	loyaltyRewards: {
		...salesFigure(
			'loyaltyRewards',
			'Loyalty rewards used',
			'loyaltyRewards',
			'sum',
		),
		module: 'loyalty',
	},
}

/** Yesterday's figures, set against the same weekday last week (#121). */
export const DAILY_SUMMARY_FIGURES: readonly FigureId[] = [
	'netSales',
	'orders',
	'averageSale',
	'tips',
	'refunds',
	'laborCost',
	'laborPercent',
	'covers',
	'newReviews',
]

/** The month's figures, set against the month before (#221), in screen order. */
export const MONTHLY_FIGURES: readonly FigureId[] = [
	'directSales',
	'directOrders',
	'newGuestOrders',
	'returningGuestOrders',
	'bookings',
	'covers',
	'callsAnswered',
	'callsHandled',
	'attributedOrders',
	'attributedSales',
	'loyaltyRewards',
	'newReviews',
	'averageRating',
	'onlineSales',
]

export const DAILY_SUMMARY_PRESET: TimeframePreset = 'yesterday'
export const MONTHLY_PRESET: TimeframePreset = 'last_complete_month'

const DAY_MS = 86_400_000

/**
 * The instants the engine's `now` takes to read a day and its comparison:
 * `yesterday` as of `now`, and `yesterday` as of a week earlier, which is the
 * same weekday last week.
 */
export function dailyAsOf(now: Date): { current: Date; previous: Date } {
	return { current: now, previous: new Date(now.getTime() - 7 * DAY_MS) }
}

/** `YYYY-MM` of the month before (`month` is `YYYY-MM`). */
export function previousMonthKey(month: string): string {
	const [y, m] = month.split('-').map(Number) as [number, number]
	const d = new Date(Date.UTC(y, m - 2, 1))
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * `last_complete_month` as of the 15th of the following month is exactly
 * `month` in every time zone (zones differ by less than a day), so a month is
 * read by moving the engine's `now`, never by naming instants.
 */
export function monthlyAsOf(month: string): { current: Date; previous: Date } {
	const at = (key: string) => {
		const [y, m] = key.split('-').map(Number) as [number, number]
		return new Date(Date.UTC(y, m, 15, 12, 0, 0))
	}
	return { current: at(month), previous: at(previousMonthKey(month)) }
}

/** The month (`YYYY-MM`) a `last_complete_month` run as of `now` reads. */
export function lastCompleteMonthKey(now: Date): string {
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export type FigureEntry = {
	/** Null for counts and ratings. */
	currency: string | null
	value: number
}

export type FigureValue = {
	id: FigureId
	format: FigureFormat
	entries: FigureEntry[]
	previous: FigureEntry[]
}

function entriesOf(spec: FigureSpec, result: ReportResult | null): FigureEntry[] {
	if (!result) return []
	if (spec.format === 'currency' || spec.format === 'percent') {
		// Grouped by currency: one segment each. The engine names the currency on
		// the segment when several appear and by the segment key when only one does.
		return result.segments
			.map((segment) => ({
				currency: segment.currency ?? segment.key,
				value: segment.value ?? 0,
			}))
			.sort((a, b) => (a.currency ?? '').localeCompare(b.currency ?? ''))
	}
	const value = result.valueInfo ? (result.value ?? 0) : result.total
	return [{ currency: null, value }]
}

/** One figure from its two runs (the period, and the one it is compared with). */
export function figureValue(
	id: FigureId,
	current: ReportResult | null,
	previous: ReportResult | null,
): FigureValue {
	const spec = FIGURES[id]
	return {
		id,
		format: spec.format,
		entries: entriesOf(spec, current),
		previous: entriesOf(spec, previous),
	}
}

/** Percent change of one entry against the earlier period; null when there is nothing to compare. */
export function figureChangePercent(
	entry: FigureEntry,
	previous: readonly FigureEntry[],
): number | null {
	const before = previous.find((p) => p.currency === entry.currency)
	if (!before || before.value === 0) return null
	return ((entry.value - before.value) / Math.abs(before.value)) * 100
}

/**
 * The figures a viewer sees: those whose subject their grants cover. A figure
 * without the grant is left out (hidden, not zero); one whose module is off is
 * reported in `off` so a screen can say so quietly (#221).
 */
export function visibleFigures(
	ids: readonly FigureId[],
	input: {
		/** Restricted subjects the viewer's token lists. */
		grants: ReadonlySet<string>
		/** Modules switched on for the organization. */
		modulesOn: ReadonlySet<FigureModule>
	},
): { shown: FigureId[]; off: FigureModule[] } {
	const shown: FigureId[] = []
	const off = new Set<FigureModule>()
	for (const id of ids) {
		const spec = FIGURES[id]
		if (spec.module && !input.modulesOn.has(spec.module)) {
			off.add(spec.module)
			continue
		}
		if (!input.grants.has(spec.subject)) continue
		shown.push(id)
	}
	return { shown, off: [...off] }
}

/**
 * Kept by ordering direct (#221): direct online sales times the delivery-app
 * commission rate the owner set (basis points). Always an estimate; the caller
 * labels it and shows the rate.
 */
export function keptByOrderingDirect(
	onlineSales: readonly FigureEntry[],
	commissionBp: number,
): FigureEntry[] {
	return onlineSales.map((entry) => ({
		currency: entry.currency,
		value: Math.round((entry.value * commissionBp) / 10_000 * 100) / 100,
	}))
}

export const DEFAULT_DELIVERY_COMMISSION_BP = 2500

