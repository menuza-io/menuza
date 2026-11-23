import { inventoryValueMinor } from '../cost.ts'
import { type DailyUse } from '../days-left.ts'
import { mulDiv } from '../money.ts'
import {
	MIN_HISTORY_DAYS,
	NEUTRAL_DEMAND_BP,
	PREP_HISTORY_DAYS,
	weekdayDemand,
} from '../prep.ts'
import { OPEN_ORDER_STATUSES, type OrderStatus } from '../records.ts'
import { priceChangeBp, PRICE_RISE_ALERT_BP } from './rules.ts'

/**
 * Pure rules for phase 2 (levels, suggested orders, receiving against an
 * order, credit, price alerts). The region computes with these and the App
 * and Station use the same functions to preview, so a card on screen and a
 * figure in the API can never disagree. No I/O, no strings.
 *
 * Quantities are base thousandths (see `units.ts`). Pack counts are carried
 * as integer THOUSANDTHS of a pack (`packsMilli`: 2.5 boxes = 2500) inside
 * the rules so rounding is exact, and as plain decimals (`packs`) on the
 * wire, which has at most three decimals.
 */

/** Thousandths of a pack in one pack. */
export const PACK_SCALE = 1000

/** A line holds at most this many packs (the wire's `packs` maximum). */
export const MAX_ORDER_PACKS = 100_000

/**
 * A pack that is "priced by weight" (meat by the kilo, a box whose weight
 * varies) may be ordered in halves: the supplier cuts or weighs to order.
 * Other packs are ordered whole.
 */
export const PRICED_BY_WEIGHT_PACK_STEP_MILLI = 500

/**
 * A priced-by-weight line counts as complete when at least this share of the
 * ordered weight arrived (the real weight on the invoice rarely equals the
 * nominal pack weight): 95%.
 */
export const WEIGHT_RECEIPT_TOLERANCE_BP = 500

function assertInt(value: number, name: string, min = 0): void {
	if (!Number.isSafeInteger(value) || value < min) {
		throw new RangeError(`${name} must be a safe integer >= ${min}`)
	}
}

function ceilDiv(numerator: number, divisor: number): number {
	return Math.floor((numerator + divisor - 1) / divisor)
}

/** Wire packs (a decimal with at most three decimals) to thousandths of a pack. */
export function packsToMilli(packs: number): number {
	if (!Number.isFinite(packs) || packs < 0) {
		throw new RangeError('packs must be a non-negative number')
	}
	return Math.round(packs * PACK_SCALE)
}

export function milliToPacks(packsMilli: number): number {
	return packsMilli / PACK_SCALE
}

/** Base thousandths in `packsMilli` thousandths of a pack of `packBase`, rounded to the nearest. */
export function packsQuantity(packsMilli: number, packBase: number): number {
	assertInt(packsMilli, 'packsMilli')
	assertInt(packBase, 'packBase', 1)
	const product = packsMilli * packBase
	if (!Number.isSafeInteger(product)) {
		throw new RangeError('Order quantity is out of range')
	}
	return Math.round(product / PACK_SCALE)
}

// ── Suggested order quantity ────────────────────────────────────────────────

export type SuggestOrderInput = {
	/** On hand at the location, base thousandths. May be negative (counted as none). */
	onHand: number
	/** Still to arrive on sent or partly received orders (default 0). Drafts do not count. */
	onOrder?: number
	/** "Order more when below", or null when not set. */
	orderBelow: number | null
	/** "Fill up to", or null when not set. */
	fillUpTo: number | null
	/** Base thousandths in one pack of the chosen supplier product. */
	packBase: number
	pricedByWeight?: boolean
	/** Override the fractional step (thousandths of a pack) for a priced-by-weight pack. */
	fractionalStep?: number
	/** Fewest packs per line (default one step). No column stores it yet; it is a rule input only. */
	minOrder?: number
}

export type SuggestedQuantity = {
	/** Thousandths of a pack, a multiple of the step (1000 whole, 500 for weight packs). */
	packsMilli: number
	/** Unrounded packs needed in thousandths before rounding up (`needed / packBase * 1000`). */
	rawPacksMilli: number
	packs: number
	/** Base thousandths that will arrive (packs × pack size). */
	quantity: number
	/** What was missing to reach "fill up to", before rounding up to packs. */
	needed: number
	/** True when the pack count hit `MAX_ORDER_PACKS`. */
	capped: boolean
}

/** Exact unrounded packs needed in thousandths before rounding up to whole/half packs. */
export function rawPacksMilli(
	neededQuantity: number,
	packBaseQuantity: number,
): number {
	assertInt(neededQuantity, 'neededQuantity')
	assertInt(packBaseQuantity, 'packBaseQuantity', 1)
	return Math.round((neededQuantity * PACK_SCALE) / packBaseQuantity)
}

export const ORDER_STALE_COUNT_DAYS = 10

/** Whether an item has not been counted within `days` (default 10) or was never counted. */
export function isOrderCountStale(
	lastCountedAt: number | null,
	now: number,
	days = ORDER_STALE_COUNT_DAYS,
): boolean {
	assertInt(days, 'days', 1)
	return lastCountedAt === null || now - lastCountedAt > days * 86_400_000
}

/**
 * Whether an item should be on a suggested order. Below "order more when
 * below" (the same `<` as the Low badge), or out with no such level but a
 * "fill up to". Stock already ordered (`onOrder`) counts as on hand, so a
 * sent order is never suggested twice. With neither level set, nothing is
 * suggested: the region cannot know how much.
 */
export function needsOrder(input: {
	onHand: number
	onOrder?: number
	orderBelow: number | null
	fillUpTo: number | null
}): boolean {
	const have = Math.max(input.onHand, 0) + Math.max(input.onOrder ?? 0, 0)
	const target = input.fillUpTo ?? input.orderBelow
	if (target === null || target <= 0) return false
	if (input.orderBelow !== null) return have < input.orderBelow || have <= 0
	return have <= 0
}

/**
 * Quantity to order to get from what is on hand (plus on order) up to "fill
 * up to", ROUNDED UP to whole packs (halves for priced-by-weight packs), and
 * at least one step once an order is needed. With no "fill up to", the
 * target is "order more when below" itself. Null when no order is needed.
 */
export function suggestOrderQuantity(
	input: SuggestOrderInput,
): SuggestedQuantity | null {
	assertInt(input.onHand, 'onHand', Number.MIN_SAFE_INTEGER)
	assertInt(input.packBase, 'packBase', 1)
	if (input.onOrder !== undefined) assertInt(input.onOrder, 'onOrder')
	if (input.orderBelow !== null) assertInt(input.orderBelow, 'orderBelow')
	if (input.fillUpTo !== null) assertInt(input.fillUpTo, 'fillUpTo')
	if (!needsOrder(input)) return null

	const have = Math.max(input.onHand, 0) + Math.max(input.onOrder ?? 0, 0)
	const target = (input.fillUpTo ?? input.orderBelow) as number
	const needed = Math.max(target - have, 0)

	const step = input.pricedByWeight
		? (input.fractionalStep ?? PRICED_BY_WEIGHT_PACK_STEP_MILLI)
		: PACK_SCALE
	assertInt(step, 'fractionalStep', 1)
	if (step > PACK_SCALE) throw new RangeError('A step is at most one pack')

	// Steps needed: ceil(needed / packBase / step) with packs in thousandths.
	let steps = ceilDiv(needed * PACK_SCALE, input.packBase * step)
	if (steps < 1) steps = 1
	if (input.minOrder !== undefined) {
		if (!Number.isFinite(input.minOrder) || input.minOrder < 0) {
			throw new RangeError('minOrder must be a non-negative number')
		}
		steps = Math.max(
			steps,
			ceilDiv(Math.ceil(input.minOrder * PACK_SCALE), step),
		)
	}
	let packsMilli = steps * step
	let capped = false
	if (packsMilli > MAX_ORDER_PACKS * PACK_SCALE) {
		packsMilli = MAX_ORDER_PACKS * PACK_SCALE
		capped = true
	}
	return {
		packsMilli,
		rawPacksMilli: rawPacksMilli(needed, input.packBase),
		packs: milliToPacks(packsMilli),
		quantity: packsQuantity(packsMilli, input.packBase),
		needed,
		capped,
	}
}

// ── Order money ─────────────────────────────────────────────────────────────

/** One line's money: packs × pack price, rounded half up. A priced-by-weight line is an estimate. */
export function orderLineTotalMinor(input: {
	packsMilli: number
	packPriceMinor: number
}): number {
	assertInt(input.packsMilli, 'packsMilli')
	assertInt(input.packPriceMinor, 'packPriceMinor')
	return mulDiv(input.packsMilli, input.packPriceMinor, PACK_SCALE, 'half_up')
}

export type OrderTotalLine = {
	/** Wire decimal packs. */
	packs: number
	/** Null when the supplier product has no price: the line is left out and counted. */
	packPriceMinor: number | null
}

/** Total of an order's priced lines and how many lines have no price. */
export function orderTotalMinor(lines: readonly OrderTotalLine[]): {
	totalMinor: number
	unpricedLines: number
} {
	let totalMinor = 0
	let unpricedLines = 0
	for (const line of lines) {
		if (line.packPriceMinor === null) {
			unpricedLines += 1
			continue
		}
		totalMinor += orderLineTotalMinor({
			packsMilli: packsToMilli(line.packs),
			packPriceMinor: line.packPriceMinor,
		})
	}
	return { totalMinor, unpricedLines }
}

/** Short of the supplier's minimum order by how much (0 when met or no minimum). */
export function shortOfMinimumMinor(
	totalMinor: number,
	minimumOrderMinor: number | null | undefined,
): number {
	if (!minimumOrderMinor || minimumOrderMinor <= 0) return 0
	return Math.max(minimumOrderMinor - totalMinor, 0)
}

// ── Receiving against an order ──────────────────────────────────────────────

export type OrderReceiptLine = {
	/** Ordered, base thousandths. */
	orderedQuantity: number
	/** Received so far over every delivery against the order, base thousandths. */
	receivedQuantity: number
	pricedByWeight?: boolean
}

function toleranceBp(line: { pricedByWeight?: boolean }): number {
	return line.pricedByWeight ? WEIGHT_RECEIPT_TOLERANCE_BP : 0
}

/** Still to arrive on a line (never negative). */
export function outstandingQuantity(
	orderedQuantity: number,
	receivedQuantity: number,
): number {
	return Math.max(orderedQuantity - receivedQuantity, 0)
}

/** A line is complete when what arrived covers what was ordered (within the weight tolerance). */
export function orderLineComplete(line: OrderReceiptLine): boolean {
	assertInt(line.orderedQuantity, 'orderedQuantity')
	assertInt(line.receivedQuantity, 'receivedQuantity')
	return (
		line.receivedQuantity * 10_000 >=
		line.orderedQuantity * (10_000 - toleranceBp(line))
	)
}

/**
 * The order's status after a delivery was recorded against it (the lines carry
 * cumulative received quantities). `closeOrder` ends it as `received` even
 * with short lines. A cancelled or received order is left as it is (the
 * region refuses to receive against those with 409 `order_closed`), and an
 * order nothing has arrived for keeps its status.
 */
export function orderStatusAfterReceipt(input: {
	status: OrderStatus
	lines: readonly OrderReceiptLine[]
	closeOrder?: boolean
}): OrderStatus {
	if (input.status === 'cancelled' || input.status === 'received') {
		return input.status
	}
	if (input.closeOrder) return 'received'
	if (input.lines.length === 0) return input.status
	if (input.lines.every(orderLineComplete)) return 'received'
	if (input.lines.some((line) => line.receivedQuantity > 0)) {
		return 'partly_received'
	}
	return input.status
}

/** Whether a delivery can still be received against an order in this status. */
export function orderAcceptsDelivery(status: OrderStatus): boolean {
	return (OPEN_ORDER_STATUSES as readonly string[]).includes(status)
}

// ── Credit ──────────────────────────────────────────────────────────────────

export type CreditInputLine = {
	itemId: string
	orderLineId?: string | null
	orderedQuantity: number
	receivedQuantity: number
	pricedByWeight?: boolean
	/** Cost per base unit (micro-minor) when the caller may see money. */
	costMicro?: number | null
}

export type CreditLine = {
	itemId: string
	orderLineId: string | null
	orderedQuantity: number
	receivedQuantity: number
	/** Ordered minus received, base thousandths. */
	shortQuantity: number
	/** `missing` when nothing arrived, `short` when some did. */
	kind: 'short' | 'missing'
	valueMinor?: number
}

/**
 * The lines to ask the supplier for credit on: ordered more than arrived,
 * beyond the priced-by-weight tolerance. Over-delivery and complete lines
 * are not listed. Keeps the order of the input.
 */
export function creditLines(lines: readonly CreditInputLine[]): CreditLine[] {
	const out: CreditLine[] = []
	for (const line of lines) {
		if (orderLineComplete(line)) continue
		const shortQuantity = outstandingQuantity(
			line.orderedQuantity,
			line.receivedQuantity,
		)
		if (shortQuantity <= 0) continue
		const credit: CreditLine = {
			itemId: line.itemId,
			orderLineId: line.orderLineId ?? null,
			orderedQuantity: line.orderedQuantity,
			receivedQuantity: line.receivedQuantity,
			shortQuantity,
			kind: line.receivedQuantity === 0 ? 'missing' : 'short',
		}
		if (line.costMicro !== undefined && line.costMicro !== null) {
			credit.valueMinor = inventoryValueMinor(shortQuantity, line.costMicro)
		}
		out.push(credit)
	}
	return out
}

/** Sum of the priced credit lines (lines without a cost are skipped). */
export function creditTotalMinor(lines: readonly CreditLine[]): number {
	return lines.reduce((sum, line) => sum + (line.valueMinor ?? 0), 0)
}

// ── Price rises ─────────────────────────────────────────────────────────────

/** A rise at or above this is a "big" rise (20%). */
export const PRICE_RISE_BIG_BP = 2000

export type PriceRise = { changeBp: number; severity: 'rise' | 'big' }

/**
 * A price rise worth an alert: the delivered cost per base unit went up by
 * MORE than the threshold (default 5%) against the previous delivery. Falls,
 * small rises and a missing previous price are not alerts.
 */
export function priceRiseAlert(input: {
	previousCostMicro: number | null
	costMicro: number
	thresholdBp?: number
}): PriceRise | null {
	const changeBp = priceChangeBp(input.previousCostMicro, input.costMicro)
	if (changeBp === null) return null
	if (changeBp <= (input.thresholdBp ?? PRICE_RISE_ALERT_BP)) return null
	return {
		changeBp,
		severity: changeBp >= PRICE_RISE_BIG_BP ? 'big' : 'rise',
	}
}

// ── Levels from use ─────────────────────────────────────────────────────────

export type SuggestedLevels = {
	/** About how much is used in a week, base thousandths. */
	weeklyUseQuantity: number
	orderBelowQuantity: number
	fillUpToQuantity: number
}

/**
 * "You use about 22 kg a week": suggested levels from what was used over
 * `days` days (sales, waste and counted differences, worked out by the
 * region). "Fill up to" covers `coverDays` of use (default a week), "order
 * more when below" covers `orderBelowDays` (default 3, about the wait for a
 * delivery), both rounded up to `roundTo` (a pack or a whole unit, default
 * no rounding) and never above fill up to. Null when nothing was used or the
 * window is empty.
 */
export function suggestLevelsFromUse(input: {
	usedQuantity: number
	days: number
	coverDays?: number
	orderBelowDays?: number
	roundTo?: number
}): SuggestedLevels | null {
	assertInt(input.usedQuantity, 'usedQuantity')
	assertInt(input.days, 'days')
	const coverDays = input.coverDays ?? 7
	const orderBelowDays = input.orderBelowDays ?? 3
	assertInt(coverDays, 'coverDays', 1)
	assertInt(orderBelowDays, 'orderBelowDays', 1)
	const roundTo = input.roundTo ?? 1
	assertInt(roundTo, 'roundTo', 1)
	if (input.days === 0 || input.usedQuantity === 0) return null
	const covering = (daysCovered: number) =>
		ceilDiv(ceilDiv(input.usedQuantity * daysCovered, input.days), roundTo) *
		roundTo
	const fillUpToQuantity = covering(coverDays)
	return {
		weeklyUseQuantity: Math.round((input.usedQuantity * 7) / input.days),
		orderBelowQuantity: Math.min(covering(orderBelowDays), fillUpToQuantity),
		fillUpToQuantity,
	}
}

/** Minimum days of positive use in the 28-day window before suggesting levels. */
export const MIN_LEVEL_SUGGESTION_DAYS = 14
/** Safety margin added on top of expected use until the delivery after next (20%). */
export const LEVEL_SAFETY_MARGIN_BP = 2000
/** Fallback delivery cycle in days when an item has no supplier delivery schedule. */
export const DEFAULT_DELIVERY_CYCLE_DAYS = 7

export type SuggestedLevelsFromHistory =
	| {
			state: 'ok'
			useDays: number
			usedQuantity: number
			dailyUseQuantity: number
			weeklyUseQuantity: number
			orderBelowQuantity: number
			fillUpToQuantity: number
			deliveryDays: number[]
			cycleDays: number | null
	  }
	| {
			state: 'not_enough_history'
			useDays: number
			usedQuantity: number
	  }

function daysBetweenIso(from: string, to: string): number {
	return Math.round((parseIso(to) - parseIso(from)) / 86_400_000)
}

function nextDeliveryDayAfter(
	afterDate: string,
	deliveryDays: readonly number[],
	lookaheadDays = 14,
): string | null {
	const days = new Set(deliveryDays)
	for (let offset = 1; offset <= lookaheadDays; offset++) {
		const date = addDaysIso(afterDate, offset)
		if (days.has(weekdayOf(date))) return date
	}
	return null
}

/**
 * Suggests "order more when below" and "fill up to" from the last 28 days of
 * daily use, shaped by prep's weekday & Ramadan demand factor (`weekdayDemand`).
 *
 * - Requires at least `minUseDays` (14) days of positive use; otherwise returns
 *   `state: 'not_enough_history'` with `useDays`.
 * - "Order more when below" covers expected use until the next orderable
 *   delivery (`nextOrderableDelivery`), or 7 days when unsourced / no delivery days.
 * - "Fill up to" covers expected use until the delivery after next plus a
 *   safety margin (`safetyMarginBp`, default 20%), or 14 days + safety margin
 *   under the 7-day fallback cycle.
 * - Both levels are rounded UP to `roundTo` (supplier pack size or count unit),
 *   and `orderBelowQuantity` never exceeds `fillUpToQuantity`.
 */
export function suggestLevelsFromHistory(input: {
	now: LocalMoment
	history: readonly DailyUse[]
	schedule: SupplierSchedule | null
	roundTo: number
	minUseDays?: number
	safetyMarginBp?: number
	fallbackCycleDays?: number
}): SuggestedLevelsFromHistory {
	assertInt(input.roundTo, 'roundTo', 1)
	const minUseDays = input.minUseDays ?? MIN_LEVEL_SUGGESTION_DAYS
	const safetyMarginBp = input.safetyMarginBp ?? LEVEL_SAFETY_MARGIN_BP
	const fallbackCycleDays =
		input.fallbackCycleDays ?? DEFAULT_DELIVERY_CYCLE_DAYS
	assertInt(minUseDays, 'minUseDays', 1)
	assertInt(safetyMarginBp, 'safetyMarginBp', 0)
	assertInt(fallbackCycleDays, 'fallbackCycleDays', 1)

	const from = addDaysIso(input.now.date, -PREP_HISTORY_DAYS)
	const days = input.history.filter(
		(day) => day.date >= from && day.date < input.now.date && day.quantity > 0,
	)
	const usedQuantity = days.reduce((sum, day) => sum + day.quantity, 0)
	if (days.length < minUseDays || usedQuantity <= 0) {
		return {
			state: 'not_enough_history',
			useDays: days.length,
			usedQuantity,
		}
	}

	const perDay = usedQuantity / days.length
	const dailyUseQuantity = Math.round(perDay)
	const weeklyUseQuantity = Math.round((usedQuantity * 7) / days.length)
	const units = days.map((day) => ({ date: day.date, units: day.quantity }))

	const normalizedDeliveryDays =
		input.schedule && input.schedule.deliveryDays.length > 0
			? [...new Set(input.schedule.deliveryDays)].sort((a, b) => a - b)
			: []

	let daysUntilNext = fallbackCycleDays
	let daysUntilAfterNext = fallbackCycleDays * 2
	let cycleDays: number | null = fallbackCycleDays
	let usedDeliveryDays: number[] = []

	if (normalizedDeliveryDays.length > 0 && input.schedule) {
		const first = nextOrderableDelivery(input.schedule, input.now)
		if (first) {
			const second = nextDeliveryDayAfter(
				first.expectedDate,
				normalizedDeliveryDays,
			)
			daysUntilNext = Math.max(
				1,
				daysBetweenIso(input.now.date, first.expectedDate),
			)
			daysUntilAfterNext = second
				? Math.max(daysUntilNext + 1, daysBetweenIso(input.now.date, second))
				: daysUntilNext + fallbackCycleDays
			cycleDays = null
			usedDeliveryDays = normalizedDeliveryDays
		}
	}

	const expectedUseForDays = (numDays: number): number => {
		let total = 0
		for (let offset = 0; offset < numDays; offset++) {
			const date = addDaysIso(input.now.date, offset)
			const factor = weekdayDemand({ date, history: units })
			total += (perDay * factor.bp) / NEUTRAL_DEMAND_BP
		}
		return total
	}

	const roundUpToPack = (qty: number): number =>
		Math.max(
			input.roundTo,
			ceilDiv(Math.ceil(qty), input.roundTo) * input.roundTo,
		)

	const fillWithMargin =
		(expectedUseForDays(daysUntilAfterNext) *
			(NEUTRAL_DEMAND_BP + safetyMarginBp)) /
		NEUTRAL_DEMAND_BP
	const fillUpToQuantity = roundUpToPack(fillWithMargin)
	const orderBelowQuantity = Math.min(
		roundUpToPack(expectedUseForDays(daysUntilNext)),
		fillUpToQuantity,
	)

	return {
		state: 'ok',
		useDays: days.length,
		usedQuantity,
		dailyUseQuantity,
		weeklyUseQuantity,
		orderBelowQuantity,
		fillUpToQuantity,
		deliveryDays: usedDeliveryDays,
		cycleDays,
	}
}

/**
 * Expected use from `today` up to `expectedDate` (base thousandths), using the
 * last 28 days of usage (`loadUseHistory`) and prep's `weekdayDemand` factor.
 * Returns null when `expectedDate` is null or there are fewer than
 * `MIN_HISTORY_DAYS` (7) days of positive use.
 */
export function expectedUseUntilDelivery(input: {
	today: string
	expectedDate: string | null
	history: readonly DailyUse[]
	minUseDays?: number
}): number | null {
	if (!input.expectedDate) return null
	const minUseDays = input.minUseDays ?? MIN_HISTORY_DAYS
	assertInt(minUseDays, 'minUseDays', 1)
	const from = addDaysIso(input.today, -PREP_HISTORY_DAYS)
	const days = input.history.filter(
		(day) => day.date >= from && day.date < input.today && day.quantity > 0,
	)
	if (days.length < minUseDays) return null
	const usedQuantity = days.reduce((sum, day) => sum + day.quantity, 0)
	if (usedQuantity <= 0) return null
	const numDays = Math.max(0, daysBetweenIso(input.today, input.expectedDate))
	if (numDays === 0) return 0
	const perDay = usedQuantity / days.length
	const units = days.map((day) => ({ date: day.date, units: day.quantity }))
	let total = 0
	for (let offset = 0; offset < numDays; offset++) {
		const date = addDaysIso(input.today, offset)
		const factor = weekdayDemand({ date, history: units })
		total += (perDay * factor.bp) / NEUTRAL_DEMAND_BP
	}
	return Math.round(total)
}

/** "Order more when below" must not exceed "fill up to" when both are set. */
export function levelsOrdered(
	orderBelow: number | null | undefined,
	fillUpTo: number | null | undefined,
): boolean {
	if (
		orderBelow === null ||
		orderBelow === undefined ||
		fillUpTo === null ||
		fillUpTo === undefined
	) {
		return true
	}
	return orderBelow <= fillUpTo
}

// ── Supplier schedule: delivery day and cut-off ─────────────────────────────

/** A location-local date (`YYYY-MM-DD`) and time (`HH:MM`). Time zones stay in the region. */
export type LocalMoment = { date: string; time: string }

export type SupplierSchedule = {
	/** 0 = Sunday … 6 = Saturday. */
	deliveryDays: readonly number[]
	/** Order by this local time (null: end of the cut-off day, 23:59). */
	cutoffTime: string | null
	/** … this many days before delivery (null: 1, the column's default). */
	cutoffDaysBefore: number | null
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseIso(date: string): number {
	const match = ISO_DATE.exec(date)
	if (!match) throw new RangeError('Invalid date')
	const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
	const check = new Date(ms).toISOString().slice(0, 10)
	if (check !== date) throw new RangeError('Invalid date')
	return ms
}

/** 0 = Sunday … 6 = Saturday, for a calendar date (no time zone involved). */
export function weekdayOf(date: string): number {
	return new Date(parseIso(date)).getUTCDay()
}

export function addDaysIso(date: string, days: number): string {
	assertInt(days, 'days', Number.MIN_SAFE_INTEGER)
	return new Date(parseIso(date) + days * 86_400_000).toISOString().slice(0, 10)
}

/** The local moment an order for `expectedDate` must be sent by. */
export function orderCutoffFor(
	expectedDate: string,
	schedule: Pick<SupplierSchedule, 'cutoffTime' | 'cutoffDaysBefore'>,
): LocalMoment {
	return {
		date: addDaysIso(expectedDate, -(schedule.cutoffDaysBefore ?? 1)),
		time: schedule.cutoffTime ?? '23:59',
	}
}

/** Whether `now` is later than the cut-off (equal is still in time). */
export function cutoffPassed(cutoff: LocalMoment, now: LocalMoment): boolean {
	if (now.date !== cutoff.date) return now.date > cutoff.date
	return now.time > cutoff.time
}

/**
 * The first delivery day an order sent at `now` can still make: a day the
 * supplier delivers on whose cut-off has not passed, looking ahead
 * `lookaheadDays` (default 14). Null when the supplier has no delivery days
 * (an order then has no expected date until the person types one).
 */
export function nextOrderableDelivery(
	schedule: SupplierSchedule,
	now: LocalMoment,
	lookaheadDays = 14,
): { expectedDate: string; cutoff: LocalMoment } | null {
	const days = new Set(schedule.deliveryDays)
	for (let offset = 0; offset <= lookaheadDays; offset++) {
		const date = addDaysIso(now.date, offset)
		if (!days.has(weekdayOf(date))) continue
		const cutoff = orderCutoffFor(date, schedule)
		if (!cutoffPassed(cutoff, now)) return { expectedDate: date, cutoff }
	}
	return null
}
