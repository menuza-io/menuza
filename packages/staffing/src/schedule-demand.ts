import {
	DEFAULT_SALES_SOURCE,
	type SalesSource,
	salesSourceCoversAllSales,
	targetColoringAllowed,
} from './labor-api.ts'
import {
	DEMAND_TRAILING_WEEKS,
	type DemandDay,
	type DemandGuide,
	type ScheduleLaborTarget,
} from './schedule-api.ts'
import { localDateOf, startOfLocalDay } from './schedule-time.ts'
import { addDays, dayOfWeek, localParts } from './tz.ts'

/**
 * The orders-based demand guide behind the schedule's demand strip and its
 * labor-target footer. It is a GUIDE, not a forecast: for each weekday and hour
 * it reports the median number of counted online orders over the trailing eight
 * weeks. Online orders are only part of a the whole business's sales, and the response
 * says so. Deterministic: the same orders and the same week always give the
 * same strip.
 */

/** Orders are grouped into 15-minute buckets so every zone offset lines up. */
export const DEMAND_BUCKET_SECONDS = 900

export type DemandBucket = {
	/** `floor(created_at_seconds / 900)`. */
	bucket: number
	currency: string
	orders: number
	/** Net sales (subtotal) in minor units. */
	salesMinor: number
}

/** Median of a list; the mean of the two middle values for an even count. */
export function medianOf(values: readonly number[]): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2
}

function oneDecimal(value: number): number {
	return Math.round(value * 10) / 10
}

/**
 * The window of past days the guide learns from: the `weeks` full weeks before
 * `anchorDate` (inclusive start, exclusive end). The anchor is the requested
 * week's start, or today when that week lies in the future, so a future week is
 * guided by the most recent real weeks.
 */
export function demandWindow(
	anchorDate: string,
	weeks = DEMAND_TRAILING_WEEKS,
): { startDate: string; endDate: string; dates: string[] } {
	const startDate = addDays(anchorDate, -7 * weeks)
	const dates = Array.from({ length: 7 * weeks }, (_, i) =>
		addDays(startDate, i),
	)
	return { startDate, endDate: addDays(anchorDate, -1), dates }
}

/** Epoch-second bounds `[from, to)` of the window, for the orders query. */
export function demandWindowSeconds(
	anchorDate: string,
	timeZone: string,
	weeks = DEMAND_TRAILING_WEEKS,
): { fromSeconds: number; toSeconds: number } {
	const { startDate } = demandWindow(anchorDate, weeks)
	return {
		fromSeconds: Math.floor(startOfLocalDay(startDate, timeZone) / 1000),
		toSeconds: Math.ceil(startOfLocalDay(anchorDate, timeZone) / 1000),
	}
}

export function computeDemandGuide(input: {
	buckets: readonly DemandBucket[]
	/** The week being planned: its seven dates get a strip each. */
	weekDates: readonly string[]
	anchorDate: string
	timeZone: string
	weeks?: number
	/** Include sales (the labor grant); orders alone never carry money. */
	includeSales: boolean
}): DemandGuide {
	const weeks = input.weeks ?? DEMAND_TRAILING_WEEKS
	const window = demandWindow(input.anchorDate, weeks)
	const inWindow = new Set(window.dates)

	const ordersByDateHour = new Map<string, number[]>()
	const salesByDate = new Map<string, Map<string, number>>()
	const currencies = new Set<string>()
	for (const bucket of input.buckets) {
		const startMs = bucket.bucket * DEMAND_BUCKET_SECONDS * 1000
		const parts = localParts(startMs, input.timeZone)
		const date = localDateOf(startMs, input.timeZone)
		if (!inWindow.has(date)) continue
		const hours =
			ordersByDateHour.get(date) ?? Array.from({ length: 24 }, () => 0)
		hours[parts.hour] = (hours[parts.hour] ?? 0) + bucket.orders
		ordersByDateHour.set(date, hours)
		const sales = salesByDate.get(date) ?? new Map<string, number>()
		sales.set(
			bucket.currency,
			(sales.get(bucket.currency) ?? 0) + bucket.salesMinor,
		)
		salesByDate.set(date, sales)
		currencies.add(bucket.currency)
	}

	const days: DemandDay[] = input.weekDates.map((date) => {
		const weekday = dayOfWeek(date)
		const samples = window.dates.filter((d) => dayOfWeek(d) === weekday)
		const hours = Array.from({ length: 24 }, (_, hour) =>
			oneDecimal(
				medianOf(samples.map((d) => ordersByDateHour.get(d)?.[hour] ?? 0)),
			),
		)
		const totals = samples.map((d) =>
			(ordersByDateHour.get(d) ?? []).reduce((sum, n) => sum + n, 0),
		)
		const day: DemandDay = {
			date,
			weekday,
			hours,
			totalOrders: oneDecimal(medianOf(totals)),
		}
		if (input.includeSales) {
			const byCurrency: Record<string, number> = {}
			for (const currency of [...currencies].sort()) {
				byCurrency[currency] = Math.round(
					medianOf(samples.map((d) => salesByDate.get(d)?.get(currency) ?? 0)),
				)
			}
			day.salesMinorByCurrency = byCurrency
		}
		return day
	})

	return {
		kind: 'guide',
		estimate: true,
		source: 'online_orders',
		statistic: 'median',
		weeks,
		windowStart: window.startDate,
		windowEnd: window.endDate,
		daysWithOrders: ordersByDateHour.size,
		timeZone: input.timeZone,
		days,
	}
}

/**
 * Cost against the guide sales, per currency. A currency with cost and no sales
 * has no ratio, and currencies are never added together.
 */
export function computeLaborTarget(input: {
	targetBp: number | null
	costMinorByCurrency: Readonly<Record<string, number>>
	/** Guide sales (the sum of the week's median daily sales) by currency. */
	guideSalesMinorByCurrency: Readonly<Record<string, number>>
	/** Where the guide sales come from; defaults to online orders. */
	salesSource?: SalesSource
	/** The guide sales of each day of the week, by currency. */
	guideSalesByDate?: Readonly<Record<string, Readonly<Record<string, number>>>>
}): ScheduleLaborTarget {
	const salesSource = input.salesSource ?? DEFAULT_SALES_SOURCE
	const coloring = targetColoringAllowed(salesSource)
	const currencies = [
		...new Set([
			...Object.keys(input.costMinorByCurrency),
			...Object.keys(input.guideSalesMinorByCurrency),
		]),
	].sort()
	return {
		targetBp: input.targetBp,
		salesSource,
		salesComplete: salesSourceCoversAllSales(salesSource),
		targetColoring: coloring,
		days: Object.entries(input.guideSalesByDate ?? {})
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, guideSalesMinorByCurrency]) => ({
				date,
				guideSalesMinorByCurrency: { ...guideSalesMinorByCurrency },
			})),
		currencies: currencies.map((currency) => {
			const costMinor = input.costMinorByCurrency[currency] ?? 0
			const guideSalesMinor = input.guideSalesMinorByCurrency[currency] ?? 0
			const laborBp =
				guideSalesMinor > 0
					? Math.round((costMinor * 10_000) / guideSalesMinor)
					: null
			const row: ScheduleLaborTarget['currencies'][number] = {
				currency,
				costMinor,
				guideSalesMinor,
				laborBp,
				allowedCostMinor:
					input.targetBp !== null && guideSalesMinor > 0
						? Math.floor((guideSalesMinor * input.targetBp) / 10_000)
						: null,
			}
			if (coloring && input.targetBp !== null && laborBp !== null) {
				row.targetStatus = laborBp <= input.targetBp ? 'within' : 'over'
			}
			return row
		}),
	}
}

/**
 * The same weekday guide for sales a team enters by hand: for each day of the
 * week, the median of the entered sales on the same weekday over the trailing
 * weeks. A day nobody entered is unknown, not zero, so it does not drag the
 * median down; a weekday with no entry at all has no figure.
 */
export function manualSalesGuide(input: {
	entries: ReadonlyArray<{ date: string; currency: string; salesMinor: number }>
	weekDates: readonly string[]
	anchorDate: string
	weeks?: number
}): Record<string, Record<string, number>> {
	const window = demandWindow(input.anchorDate, input.weeks)
	const inWindow = new Set(window.dates)
	const byDate = new Map<string, Map<string, number>>()
	for (const entry of input.entries) {
		if (!inWindow.has(entry.date)) continue
		const day = byDate.get(entry.date) ?? new Map<string, number>()
		day.set(entry.currency, (day.get(entry.currency) ?? 0) + entry.salesMinor)
		byDate.set(entry.date, day)
	}
	const result: Record<string, Record<string, number>> = {}
	for (const date of input.weekDates) {
		const weekday = dayOfWeek(date)
		const samples = window.dates.filter(
			(d) => dayOfWeek(d) === weekday && byDate.has(d),
		)
		const currencies = new Set(
			samples.flatMap((d) => [...byDate.get(d)!.keys()]),
		)
		const day: Record<string, number> = {}
		for (const currency of [...currencies].sort()) {
			const values = samples
				.map((d) => byDate.get(d)!.get(currency))
				.filter((value): value is number => value !== undefined)
			day[currency] = Math.round(medianOf(values))
		}
		result[date] = day
	}
	return result
}
