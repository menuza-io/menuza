import {
	type LaborCurrencyMismatch,
	type LaborDayView,
	type LaborMoneyView,
	type LaborSummaryView,
	type LaborTotalsView,
	type SalesSource,
	salesSourceCoversAllSales,
	salesSourceUsesOrders,
	targetColoringAllowed,
	type TargetStatus,
} from './labor-api.ts'
import { costUnitsToMinor } from './time-math.ts'
import { addDays } from './tz.ts'

/**
 * `labor_daily`: one row per scope and local day, derived from time cards
 * (hours and rate snapshots, priced by the same `computeEntryFigures` the
 * timesheets use) and sales (counted online orders, or sales the team entered).
 * Nothing here reads a database; tenant-api loads the facts and calls in.
 *
 * Rules the figures follow:
 * - Money is never added across currencies. Cost and sales are kept per
 *   currency; a wage currency with no sales in the same currency has no share
 *   and is surfaced as a mismatch instead of being converted.
 * - A share over a range is a ratio of sums (cost over sales across the days
 *   that have sales), never an average of daily percentages.
 * - Cost is rounded once per currency from exact cost units.
 * - A target is only judged when the sales cover everything the scope
 *   sells (manual sales, or online-only), and the result is a plain
 *   within/over status the screen may color.
 */

export type LaborCardFact = {
	staffId: string
	/** Business date of the card (the scope's workday rule already applied). */
	date: string
	paidMinutes: number
	/** Daily plus weekly overtime and double time. */
	overtimeMinutes: number
	/** Unrounded cost in `COST_UNITS_PER_MINOR` units; 0 when unpriced. */
	costUnits: number
	/** The pay currency of the card; null when it has no pay rate. */
	currency: string | null
	unpricedMinutes: number
	/** The card has no clock-out yet. */
	open: boolean
}

export type LaborSalesFact = {
	date: string
	currency: string
	/** Net sales (before tax, tips and fees) in minor units. */
	salesMinor: number
}

export type LaborSummaryInput = {
	scopeId: string
	timeZone: string
	from: string
	to: string
	salesSource: SalesSource
	targetBp: number | null
	cards: readonly LaborCardFact[]
	sales: readonly LaborSalesFact[]
	truncated?: boolean
}

/** Ratio of two amounts in basis points, rounded to the nearest. Null without a base. */
export function ratioBp(numerator: number, denominator: number): number | null {
	if (!(denominator > 0)) return null
	return Math.round((numerator * 10_000) / denominator)
}

/** Sales per paid labor hour in minor units. Null without sales or hours. */
export function salesPerLaborHour(
	salesMinor: number,
	paidMinutes: number,
): number | null {
	if (!(paidMinutes > 0) || !(salesMinor >= 0)) return null
	return Math.round((salesMinor * 60) / paidMinutes)
}

/**
 * Whether a labor share is within or over its target. Null (no judgement)
 * unless the sales source covers all sales, a target is set and the share
 * exists: a share built on partial sales must never read as met or missed.
 */
export function targetStatusOf(input: {
	source: SalesSource
	targetBp: number | null
	laborBp: number | null
}): TargetStatus | null {
	if (!targetColoringAllowed(input.source)) return null
	if (input.targetBp === null || input.laborBp === null) return null
	return input.laborBp <= input.targetBp ? 'within' : 'over'
}

/** Every date from `from` to `to`, inclusive. */
export function datesInRange(from: string, to: string): string[] {
	const dates: string[] = []
	for (let date = from, guard = 0; date <= to && guard < 400; guard++) {
		dates.push(date)
		date = addDays(date, 1)
	}
	return dates
}

type DayAccumulator = {
	paidMinutes: number
	overtimeMinutes: number
	cards: number
	people: Set<string>
	costUnits: Map<string, number>
	sales: Map<string, number>
	hasSalesRow: boolean
}

function newDay(): DayAccumulator {
	return {
		paidMinutes: 0,
		overtimeMinutes: 0,
		cards: 0,
		people: new Set(),
		costUnits: new Map(),
		sales: new Map(),
		hasSalesRow: false,
	}
}

function add(map: Map<string, number>, key: string, value: number) {
	map.set(key, (map.get(key) ?? 0) + value)
}

function sortedKeys(...maps: Array<Map<string, number>>): string[] {
	return [...new Set(maps.flatMap((map) => [...map.keys()]))].sort()
}

/**
 * The money rows of one day or one range. `salesKnown` says whether the sales
 * are known at all (an online source always knows: no orders means zero sales;
 * a manual source only knows the days that have an entry).
 */
function moneyRows(input: {
	currencies: readonly string[]
	costMinorOf: (currency: string) => number
	salesOf: (currency: string) => number
	salesKnown: boolean
	paidMinutes: number
	comparableCostMinorOf?: (currency: string) => number
	source: SalesSource
	targetBp: number | null
	matchedCurrencies: ReadonlySet<string>
}): LaborMoneyView[] {
	return input.currencies.map((currency) => {
		const costMinor = input.costMinorOf(currency)
		const matched = input.matchedCurrencies.has(currency)
		const salesMinor = input.salesKnown ? input.salesOf(currency) : null
		const comparableCost = input.comparableCostMinorOf
			? input.comparableCostMinorOf(currency)
			: costMinor
		const laborBp =
			salesMinor !== null && matched
				? ratioBp(comparableCost, salesMinor)
				: null
		const row: LaborMoneyView = {
			currency,
			costMinor,
			salesMinor,
			laborBp,
			salesPerLaborHourMinor:
				salesMinor !== null && matched
					? salesPerLaborHour(salesMinor, input.paidMinutes)
					: null,
		}
		const status = targetStatusOf({
			source: input.source,
			targetBp: input.targetBp,
			laborBp,
		})
		if (status) row.targetStatus = status
		return row
	})
}

export function computeLaborSummary(
	input: LaborSummaryInput,
): LaborSummaryView {
	const dates = datesInRange(input.from, input.to)
	const inRange = new Set(dates)
	const days = new Map<string, DayAccumulator>(
		dates.map((date) => [date, newDay()]),
	)
	const usesOrders = salesSourceUsesOrders(input.salesSource)

	let unpricedMinutes = 0
	let openCards = 0
	for (const card of input.cards) {
		const day = days.get(card.date)
		if (!day || !inRange.has(card.date)) continue
		day.paidMinutes += card.paidMinutes
		day.overtimeMinutes += card.overtimeMinutes
		day.cards += 1
		day.people.add(card.staffId)
		unpricedMinutes += card.unpricedMinutes
		if (card.open) openCards += 1
		if (card.currency !== null && card.costUnits > 0) {
			add(day.costUnits, card.currency, card.costUnits)
		}
	}
	for (const fact of input.sales) {
		const day = days.get(fact.date)
		if (!day) continue
		add(day.sales, fact.currency, fact.salesMinor)
		day.hasSalesRow = true
	}

	// Currencies across the whole range decide what can be compared.
	const costCurrencies = new Set<string>()
	const salesCurrencies = new Set<string>()
	for (const day of days.values()) {
		for (const currency of day.costUnits.keys()) costCurrencies.add(currency)
		for (const currency of day.sales.keys()) salesCurrencies.add(currency)
	}
	const matched = new Set(
		[...costCurrencies].filter((currency) => salesCurrencies.has(currency)),
	)
	let currencyMismatch: LaborCurrencyMismatch | null = null
	if (costCurrencies.size > 0 && salesCurrencies.size > 0) {
		const costOnly = [...costCurrencies].filter((c) => !salesCurrencies.has(c))
		const salesOnly = [...salesCurrencies].filter((c) => !costCurrencies.has(c))
		if (costOnly.length > 0 || salesOnly.length > 0) {
			currencyMismatch = {
				costOnly: costOnly.sort(),
				salesOnly: salesOnly.sort(),
			}
		}
	}
	// A currency with sales and nothing to compare still needs a row, so the
	// sales are not silently dropped from the screen.
	const rowCurrencies = [
		...new Set([...costCurrencies, ...salesCurrencies]),
	].sort()

	const dayViews: LaborDayView[] = dates.map((date) => {
		const day = days.get(date)!
		const salesKnown = usesOrders || day.hasSalesRow
		const currencies = sortedKeys(day.costUnits, day.sales)
		return {
			date,
			paidMinutes: day.paidMinutes,
			overtimeMinutes: day.overtimeMinutes,
			cards: day.cards,
			people: day.people.size,
			hasSales: salesKnown,
			money: moneyRows({
				currencies,
				costMinorOf: (c) => costUnitsToMinor(day.costUnits.get(c) ?? 0),
				salesOf: (c) => day.sales.get(c) ?? 0,
				salesKnown,
				paidMinutes: day.paidMinutes,
				source: input.salesSource,
				targetBp: input.targetBp,
				matchedCurrencies: matched,
			}),
		}
	})

	// Totals: ratio of sums over the days that have sales.
	let paidMinutes = 0
	let overtimeMinutes = 0
	let cards = 0
	let comparableMinutes = 0
	const totalUnits = new Map<string, number>()
	const comparableUnits = new Map<string, number>()
	const totalSales = new Map<string, number>()
	let salesDays = 0
	for (const date of dates) {
		const day = days.get(date)!
		paidMinutes += day.paidMinutes
		overtimeMinutes += day.overtimeMinutes
		cards += day.cards
		const salesKnown = usesOrders || day.hasSalesRow
		for (const [currency, units] of day.costUnits) {
			add(totalUnits, currency, units)
			if (salesKnown) add(comparableUnits, currency, units)
		}
		for (const [currency, minor] of day.sales) add(totalSales, currency, minor)
		if (salesKnown) {
			salesDays += 1
			comparableMinutes += day.paidMinutes
		}
	}
	const totalMoney = moneyRows({
		currencies: rowCurrencies,
		costMinorOf: (c) => costUnitsToMinor(totalUnits.get(c) ?? 0),
		comparableCostMinorOf: (c) => costUnitsToMinor(comparableUnits.get(c) ?? 0),
		salesOf: (c) => totalSales.get(c) ?? 0,
		salesKnown: salesDays > 0 || usesOrders,
		paidMinutes: comparableMinutes,
		source: input.salesSource,
		targetBp: input.targetBp,
		matchedCurrencies: matched,
	})
	const totals: LaborTotalsView = {
		paidMinutes,
		overtimeMinutes,
		cards,
		salesDays,
		daysWithoutSales: dates.length - salesDays,
		money: totalMoney,
	}

	return {
		estimate: true,
		scopeId: input.scopeId,
		timeZone: input.timeZone,
		from: input.from,
		to: input.to,
		salesSource: input.salesSource,
		salesComplete: salesSourceCoversAllSales(input.salesSource),
		targetBp: input.targetBp,
		targetColoring: targetColoringAllowed(input.salesSource),
		days: dayViews,
		totals,
		currencyMismatch,
		unpricedMinutes,
		openCards,
		truncated: input.truncated ?? false,
	}
}
