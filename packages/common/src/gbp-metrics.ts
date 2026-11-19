/**
 * Google listing performance (#136): metric ids, labels and the 28-day
 * comparison the dashboard block shows. Pure: no I/O. Totals only; nothing
 * about individual people.
 */

/** Business Profile Performance API daily metrics Menuza stores. */
export const GBP_METRICS = [
	'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
	'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
	'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
	'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
	'CALL_CLICKS',
	'BUSINESS_DIRECTION_REQUESTS',
	'WEBSITE_CLICKS',
	'BUSINESS_FOOD_ORDERS',
	'BUSINESS_BOOKINGS',
	'BUSINESS_CONVERSATIONS',
] as const
export type GbpMetric = (typeof GBP_METRICS)[number]

export function isGbpMetric(value: string): value is GbpMetric {
	return (GBP_METRICS as readonly string[]).includes(value)
}

/** The figures the report and dashboard show, each a sum of daily metrics. */
export const GBP_FIGURES = [
	{ id: 'searchViews', label: 'Search views' },
	{ id: 'mapsViews', label: 'Maps views' },
	{ id: 'calls', label: 'Calls' },
	{ id: 'directions', label: 'Direction requests' },
	{ id: 'websiteClicks', label: 'Website clicks' },
	{ id: 'orderClicks', label: 'Order clicks' },
	{ id: 'bookingClicks', label: 'Booking clicks' },
	{ id: 'conversations', label: 'Conversations' },
] as const
export type GbpFigureId = (typeof GBP_FIGURES)[number]['id']

const FIGURE_METRICS: Record<GbpFigureId, readonly GbpMetric[]> = {
	searchViews: [
		'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
		'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
	],
	mapsViews: [
		'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
		'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
	],
	calls: ['CALL_CLICKS'],
	directions: ['BUSINESS_DIRECTION_REQUESTS'],
	websiteClicks: ['WEBSITE_CLICKS'],
	orderClicks: ['BUSINESS_FOOD_ORDERS'],
	bookingClicks: ['BUSINESS_BOOKINGS'],
	conversations: ['BUSINESS_CONVERSATIONS'],
}

export type DailyMetricRow = { date: string; metric: string; value: number }

/** The figure each metric adds to. */
export function figureOfMetric(metric: string): GbpFigureId | null {
	for (const [figure, metrics] of Object.entries(FIGURE_METRICS)) {
		if ((metrics as readonly string[]).includes(metric)) {
			return figure as GbpFigureId
		}
	}
	return null
}

/** Pivots daily metric rows into one row per day with a column per figure. */
export function pivotDailyFigures(
	rows: readonly DailyMetricRow[],
): Array<{ date: string } & Record<GbpFigureId, number>> {
	const byDate = new Map<string, Record<GbpFigureId, number>>()
	for (const row of rows) {
		const figure = figureOfMetric(row.metric)
		if (!figure) continue
		const entry =
			byDate.get(row.date) ??
			({
				searchViews: 0,
				mapsViews: 0,
				calls: 0,
				directions: 0,
				websiteClicks: 0,
				orderClicks: 0,
				bookingClicks: 0,
				conversations: 0,
			} satisfies Record<GbpFigureId, number>)
		entry[figure] += row.value
		byDate.set(row.date, entry)
	}
	return [...byDate]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, figures]) => ({ date, ...figures }))
}

export type PeriodTotals = Record<GbpFigureId, number>

function emptyTotals(): PeriodTotals {
	return {
		searchViews: 0,
		mapsViews: 0,
		calls: 0,
		directions: 0,
		websiteClicks: 0,
		orderClicks: 0,
		bookingClicks: 0,
		conversations: 0,
	}
}

function addDays(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00Z`)
	date.setUTCDate(date.getUTCDate() + days)
	return date.toISOString().slice(0, 10)
}

export type PerformanceComparison = {
	/** The last day with data; null when nothing is stored. */
	dataUntil: string | null
	current: PeriodTotals
	previous: PeriodTotals
	/** Daily total views (search + maps) for the small trend line. */
	trend: Array<{ date: string; views: number }>
}

/**
 * The last `days` days ending at the newest stored day, against the `days`
 * before. Google data runs a few days late, so the window ends at the data,
 * not at today; the screen labels that day.
 */
export function comparePeriods(
	rows: readonly DailyMetricRow[],
	days = 28,
): PerformanceComparison {
	let dataUntil: string | null = null
	for (const row of rows) {
		if (!dataUntil || row.date > dataUntil) dataUntil = row.date
	}
	const current = emptyTotals()
	const previous = emptyTotals()
	if (!dataUntil) return { dataUntil, current, previous, trend: [] }
	const currentStart = addDays(dataUntil, -(days - 1))
	const previousStart = addDays(currentStart, -days)
	const viewsByDate = new Map<string, number>()
	for (const row of rows) {
		const figure = figureOfMetric(row.metric)
		if (!figure) continue
		if (row.date >= currentStart && row.date <= dataUntil) {
			current[figure] += row.value
			if (figure === 'searchViews' || figure === 'mapsViews') {
				viewsByDate.set(row.date, (viewsByDate.get(row.date) ?? 0) + row.value)
			}
		} else if (row.date >= previousStart && row.date < currentStart) {
			previous[figure] += row.value
		}
	}
	const trend: PerformanceComparison['trend'] = []
	for (let index = 0; index < days; index++) {
		const date = addDays(currentStart, index)
		trend.push({ date, views: viewsByDate.get(date) ?? 0 })
	}
	return { dataUntil, current, previous, trend }
}

/** Change from the previous period as a whole percent; null with no baseline. */
export function percentChange(
	current: number,
	previous: number,
): number | null {
	if (previous === 0) return current === 0 ? 0 : null
	return Math.round(((current - previous) / previous) * 100)
}

/** Google's monthly window for the Performance API is 18 months. */
export const GBP_BACKFILL_MONTHS = 18

/** First day to ask for on a backfill, given `today`. */
export function backfillStart(today: Date): string {
	const date = new Date(
		Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
	)
	date.setUTCMonth(date.getUTCMonth() - GBP_BACKFILL_MONTHS)
	return date.toISOString().slice(0, 10)
}

/** Days re-fetched every day to catch late data. */
export const GBP_REFETCH_DAYS = 7

/** The last month with search phrases is the previous calendar month. */
export function lastSearchMonth(today: Date): string {
	const date = new Date(
		Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
	)
	return date.toISOString().slice(0, 7)
}

export type SearchKeywordValue = {
	value: number | null
	threshold: number | null
}

/** Shows a phrase count as Google gave it: `42` or `< 15`. */
export function formatKeywordValue(entry: SearchKeywordValue): string {
	if (entry.value !== null) return String(entry.value)
	if (entry.threshold !== null) return `< ${entry.threshold}`
	return ''
}
