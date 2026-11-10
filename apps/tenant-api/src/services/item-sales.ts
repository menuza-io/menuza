import { allocateProportionally } from '@repo/inventory'
import { currentBusinessDate, isValidTimeZone } from '@repo/reservations'
import {
	posOrders,
	qrTabs,
	restaurantOrders,
	rsvLocationSettings,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { countedOrderCondition } from './report-records.ts'

/**
 * Items sold, from every channel: web and QR orders (`restaurant_orders`) and
 * Station sales (`pos_orders`). One reader for stock used by sales, expected
 * use, "dishes without a recipe", food cost sales and the prep demand nudge.
 * Counts and money only, never a customer.
 *
 * What counts as sold
 * - Web/QR orders: the reports' "counted" rule (`countedOrderCondition`:
 *   open or completed, and payable: handoff at once, online once paid or
 *   free). Cancelled, expired, unpaid and payment-review orders sell nothing.
 *   A refund does not un-sell: the food was made. The rounds of a QR tab
 *   that staff closed at the counter and rang up on a Station till
 *   (`qr_tabs.rung_up_on_station`) are left out, because that till sale
 *   records the same food and is read below.
 * - Station sales: paid and refunded sales (refunds never return stock);
 *   open and cancelled (`void`) sales sell nothing. A sale's `lines` are what
 *   is on the bill now: the till takes removed items out of `lines` and
 *   records them in `lineVoids` (append-only history), so voided items are
 *   already absent and are not subtracted a second time.
 *
 * Business date
 * - Station sales carry the till's `businessDate`.
 * - Web/QR orders are dated from their placement time (`created_at`, as the
 *   reports and the staffing demand use) in the location's business day:
 *   the time zone and day start passed in `clocks`, else the location's
 *   reservations settings (`rsv_location_settings`, the only per-location
 *   time zone kept in the region), else the order's own pickup time zone,
 *   else UTC; the day start defaults to 04:00 (240 minutes), as on the till.
 *   Callers that know the location time zone from the App should pass it.
 *
 * Net sales (money per item line)
 * - Before tax, after discounts and loyalty rewards, without tips, delivery
 *   fees or delivery discounts. Per sale: subtotal - item discounts - loyalty
 *   reward - tax when prices include tax (web/QR: `discount_cents` and
 *   `loyalty_discount_cents`; Station: `adjustmentCents`, which holds both).
 * - That net is spread over the sale's lines in proportion to each line's
 *   own total (options included) with a largest-remainder split, so the
 *   lines of a sale add up to its net exactly. Per line this is an
 *   approximation when a discount targeted one line (the per-line discount
 *   allocations live with the discount and loyalty records); per location
 *   and day, which is what food cost reads, it is exact.
 * - Web/QR orders do not store whether prices included tax; it is read from
 *   the totals (`total = net + tip + delivery`, tax not added, means
 *   inclusive). A sale whose totals fit neither shape is treated as tax
 *   exclusive.
 * - Money is kept per currency (rows are keyed by it) and never added
 *   across currencies.
 */

/** Minutes after local midnight when the business day turns over. */
export const DEFAULT_SALES_DAY_START_MIN = 240

/** Caps one read: about a year of a very busy location. */
export const ITEM_SALES_MAX_ORDERS = 200_000

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

export type LocationClock = { timeZone: string; dayStartMin: number }

export type ItemSalesQuery = {
	/** One location, or every location when left out. */
	locationId?: string | null
	/** First and last business date, inclusive (`YYYY-MM-DD`). */
	fromDate: string
	toDate: string
	/** The location's time zone and day start, by location id (web/QR dating). */
	clocks?: Readonly<Record<string, LocationClock>>
}

export type ItemSalesRow = {
	locationId: string
	businessDate: string
	itemId: string
	variantId: string | null
	currency: string
	/** Units sold. */
	quantity: number
	/** Net sales in minor units of `currency` (see the module note). */
	netSalesMinor: number
}

export type OptionSalesRow = {
	locationId: string
	businessDate: string
	optionId: string
	/** Times the option was sold (line quantity x option quantity). */
	quantity: number
	/** The part of `quantity` put on one half of a split item (pizza halves). */
	halfQuantity: number
}

export type ItemSales = {
	items: ItemSalesRow[]
	options: OptionSalesRow[]
	/** True when a channel hit `ITEM_SALES_MAX_ORDERS` and the rest was not read. */
	truncated: boolean
}

type Reader = TenantDatabase | TenantTransaction

type SoldOption = { optionId: string; quantity: number; half: boolean }
type SoldLine = {
	itemId: string
	variantId: string | null
	quantity: number
	totalMinor: number
	options: SoldOption[]
}

function nonNegativeInt(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0
}

function idOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function parseJsonArray(raw: unknown): unknown[] {
	let value = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return []
		}
	}
	return Array.isArray(value) ? value : []
}

/**
 * Lines of a web/QR order (`PricedOrderLine[]`) or a Station sale
 * (`PosOrderLine[]`), read defensively: a line without an item id or a
 * positive quantity is skipped. A Station line carries no total, so it is
 * worked out as the till does (base plus options, times quantity).
 */
export function parseSoldLines(
	raw: unknown,
	kind: 'restaurant' | 'pos',
): SoldLine[] {
	const lines: SoldLine[] = []
	for (const entry of parseJsonArray(raw)) {
		if (!entry || typeof entry !== 'object') continue
		const line = entry as Record<string, unknown>
		const itemId = idOrNull(line.itemId)
		const quantity = nonNegativeInt(line.quantity)
		if (!itemId || quantity === 0) continue
		const options: SoldOption[] = []
		let optionUnitMinor = 0
		for (const optionEntry of Array.isArray(line.options) ? line.options : []) {
			if (!optionEntry || typeof optionEntry !== 'object') continue
			const option = optionEntry as Record<string, unknown>
			const optionId = idOrNull(option.optionId)
			const optionQuantity = nonNegativeInt(option.quantity)
			if (!optionId || optionQuantity === 0) continue
			optionUnitMinor += nonNegativeInt(option.unitCents) * optionQuantity
			options.push({
				optionId,
				quantity: optionQuantity * quantity,
				half: option.half === 'left' || option.half === 'right',
			})
		}
		const totalMinor =
			kind === 'pos'
				? (nonNegativeInt(line.baseCents) + optionUnitMinor) * quantity
				: nonNegativeInt(line.totalCents)
		lines.push({
			itemId,
			variantId: idOrNull(line.variantId),
			quantity,
			totalMinor,
			options,
		})
	}
	return lines
}

/**
 * Spreads a sale's net over its lines in proportion to the line totals; the
 * shares add up to `netMinor` exactly.
 */
export function allocateSaleNet(
	netMinor: number,
	lines: readonly Pick<SoldLine, 'totalMinor'>[],
): number[] {
	if (lines.length === 0) return []
	return allocateProportionally(
		Math.max(0, Math.trunc(netMinor)),
		lines.map((line) => line.totalMinor),
	)
}

/**
 * Net item sales of a web/QR order: subtotal less item discounts and the
 * loyalty reward, less tax when prices include it (read from the totals).
 */
export function restaurantOrderNetMinor(order: {
	subtotalCents: number
	discountCents: number
	loyaltyDiscountCents: number | null
	taxCents: number
	tipCents: number
	deliveryFeeCents: number
	deliveryDiscountCents: number
	totalCents: number
}): number {
	const afterDiscounts =
		order.subtotalCents -
		order.discountCents -
		(order.loyaltyDiscountCents ?? 0)
	const delivery = order.deliveryFeeCents - order.deliveryDiscountCents
	const inclusive =
		order.taxCents > 0 &&
		order.totalCents === afterDiscounts + order.tipCents + delivery
	return Math.max(0, afterDiscounts - (inclusive ? order.taxCents : 0))
}

/** Net item sales of a Station sale (adjustments hold discounts and rewards). */
export function posOrderNetMinor(order: {
	subtotalCents: number
	adjustmentCents: number
	taxCents: number
	taxInclusive: boolean
}): number {
	return Math.max(
		0,
		order.subtotalCents -
			order.adjustmentCents -
			(order.taxInclusive ? order.taxCents : 0),
	)
}

function addDays(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number]
	return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
		.toISOString()
		.slice(0, 10)
}

function utcMidnightMs(date: string): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number]
	return Date.UTC(y, m - 1, d)
}

class SalesAccumulator {
	private readonly items = new Map<string, ItemSalesRow>()
	private readonly options = new Map<string, OptionSalesRow>()

	add(
		sale: { locationId: string; businessDate: string; currency: string },
		lines: SoldLine[],
		netMinor: number,
	): void {
		const shares = allocateSaleNet(netMinor, lines)
		lines.forEach((line, index) => {
			const key = JSON.stringify([
				sale.locationId,
				sale.businessDate,
				line.itemId,
				line.variantId,
				sale.currency,
			])
			const row = this.items.get(key) ?? {
				locationId: sale.locationId,
				businessDate: sale.businessDate,
				itemId: line.itemId,
				variantId: line.variantId,
				currency: sale.currency,
				quantity: 0,
				netSalesMinor: 0,
			}
			row.quantity += line.quantity
			row.netSalesMinor += shares[index] ?? 0
			this.items.set(key, row)
			for (const option of line.options) {
				const optionKey = JSON.stringify([
					sale.locationId,
					sale.businessDate,
					option.optionId,
				])
				const optionRow = this.options.get(optionKey) ?? {
					locationId: sale.locationId,
					businessDate: sale.businessDate,
					optionId: option.optionId,
					quantity: 0,
					halfQuantity: 0,
				}
				optionRow.quantity += option.quantity
				if (option.half) optionRow.halfQuantity += option.quantity
				this.options.set(optionKey, optionRow)
			}
		})
	}

	result(truncated: boolean): ItemSales {
		const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
		return {
			items: [...this.items.values()].sort(
				(a, b) =>
					order(a.locationId, b.locationId) ||
					order(a.businessDate, b.businessDate) ||
					order(a.itemId, b.itemId) ||
					order(a.variantId ?? '', b.variantId ?? '') ||
					order(a.currency, b.currency),
			),
			options: [...this.options.values()].sort(
				(a, b) =>
					order(a.locationId, b.locationId) ||
					order(a.businessDate, b.businessDate) ||
					order(a.optionId, b.optionId),
			),
			truncated,
		}
	}
}

async function loadLocationClocks(
	db: Reader,
	locationIds: readonly string[],
): Promise<Map<string, LocationClock>> {
	const rows = await queryInChunks(locationIds, (chunk) =>
		db
			.select({
				locationId: rsvLocationSettings.locationId,
				timeZone: rsvLocationSettings.timeZone,
				dayStartMin: rsvLocationSettings.dayStartMin,
			})
			.from(rsvLocationSettings)
			.where(inArray(rsvLocationSettings.locationId, chunk)),
	)
	const clocks = new Map<string, LocationClock>()
	for (const row of rows) {
		if (!isValidTimeZone(row.timeZone)) continue
		clocks.set(row.locationId, {
			timeZone: row.timeZone,
			dayStartMin: row.dayStartMin,
		})
	}
	return clocks
}

async function addRestaurantOrders(
	db: Reader,
	query: ItemSalesQuery,
	sales: SalesAccumulator,
): Promise<boolean> {
	// Any time zone (UTC-12 to UTC+14) and any day start (up to 24 hours)
	// puts an order's business date within these instants; the exact date is
	// worked out per order below.
	const from = new Date(utcMidnightMs(query.fromDate) - DAY_MS)
	const to = new Date(utcMidnightMs(addDays(query.toDate, 1)) + 2 * DAY_MS)
	const conditions: SQL[] = [
		countedOrderCondition(),
		gte(restaurantOrders.createdAt, from),
		lte(restaurantOrders.createdAt, to),
		// Rounds of a tab rung up on a Station till are read as that till sale.
		or(isNull(qrTabs.id), eq(qrTabs.rungUpOnStation, false))!,
	]
	if (query.locationId) {
		conditions.push(eq(restaurantOrders.locationId, query.locationId))
	}
	const rows = await db
		.select({
			locationId: restaurantOrders.locationId,
			currency: restaurantOrders.currency,
			subtotalCents: restaurantOrders.subtotalCents,
			discountCents: restaurantOrders.discountCents,
			loyaltyDiscountCents: restaurantOrders.loyaltyDiscountCents,
			taxCents: restaurantOrders.taxCents,
			tipCents: restaurantOrders.tipCents,
			deliveryFeeCents: restaurantOrders.deliveryFeeCents,
			deliveryDiscountCents: restaurantOrders.deliveryDiscountCents,
			totalCents: restaurantOrders.totalCents,
			pickupTimezone: restaurantOrders.pickupTimezone,
			createdAt: restaurantOrders.createdAt,
			lines: restaurantOrders.lines,
		})
		.from(restaurantOrders)
		.leftJoin(qrTabs, eq(qrTabs.id, restaurantOrders.tabId))
		.where(and(...conditions))
		.limit(ITEM_SALES_MAX_ORDERS + 1)
	const truncated = rows.length > ITEM_SALES_MAX_ORDERS
	const kept = truncated ? rows.slice(0, ITEM_SALES_MAX_ORDERS) : rows

	const locationIds = [...new Set(kept.map((row) => row.locationId))].filter(
		(id) => !query.clocks?.[id],
	)
	const stored = await loadLocationClocks(db, locationIds)

	for (const row of kept) {
		if (!row.createdAt) continue
		const clock =
			query.clocks?.[row.locationId] ??
			stored.get(row.locationId) ??
			(row.pickupTimezone && isValidTimeZone(row.pickupTimezone)
				? {
						timeZone: row.pickupTimezone,
						dayStartMin: DEFAULT_SALES_DAY_START_MIN,
					}
				: { timeZone: 'UTC', dayStartMin: DEFAULT_SALES_DAY_START_MIN })
		const businessDate = currentBusinessDate(
			row.createdAt.getTime(),
			clock.timeZone,
			clock.dayStartMin,
		)
		if (businessDate < query.fromDate || businessDate > query.toDate) continue
		const lines = parseSoldLines(row.lines, 'restaurant')
		if (lines.length === 0) continue
		sales.add(
			{
				locationId: row.locationId,
				businessDate,
				// Orders store lower-case codes; everything else is upper case.
				currency: row.currency.toUpperCase(),
			},
			lines,
			restaurantOrderNetMinor(row),
		)
	}
	return truncated
}

async function addPosOrders(
	db: Reader,
	query: ItemSalesQuery,
	sales: SalesAccumulator,
): Promise<boolean> {
	const conditions: SQL[] = [
		inArray(posOrders.status, ['paid', 'refunded']),
		gte(posOrders.businessDate, query.fromDate),
		lte(posOrders.businessDate, query.toDate),
	]
	if (query.locationId) {
		conditions.push(eq(posOrders.locationId, query.locationId))
	}
	const rows = await db
		.select({
			locationId: posOrders.locationId,
			businessDate: posOrders.businessDate,
			currency: posOrders.currency,
			subtotalCents: posOrders.subtotalCents,
			adjustmentCents: posOrders.adjustmentCents,
			taxCents: posOrders.taxCents,
			taxInclusive: posOrders.taxInclusive,
			lines: posOrders.lines,
		})
		.from(posOrders)
		.where(and(...conditions))
		.limit(ITEM_SALES_MAX_ORDERS + 1)
	const truncated = rows.length > ITEM_SALES_MAX_ORDERS
	for (const row of truncated ? rows.slice(0, ITEM_SALES_MAX_ORDERS) : rows) {
		const lines = parseSoldLines(row.lines, 'pos')
		if (lines.length === 0) continue
		sales.add(
			{
				locationId: row.locationId,
				businessDate: row.businessDate,
				currency: row.currency.toUpperCase(),
			},
			lines,
			posOrderNetMinor(row),
		)
	}
	return truncated
}

/**
 * Items, variants and options sold per location and business date, from web,
 * QR and Station sales (see the module note for every rule).
 */
export async function readItemSales(
	db: Reader,
	query: ItemSalesQuery,
): Promise<ItemSales> {
	if (
		!BUSINESS_DATE.test(query.fromDate) ||
		!BUSINESS_DATE.test(query.toDate)
	) {
		throw new RangeError('fromDate and toDate must be YYYY-MM-DD')
	}
	const sales = new SalesAccumulator()
	if (query.fromDate > query.toDate) return sales.result(false)
	const restaurantTruncated = await addRestaurantOrders(db, query, sales)
	const posTruncated = await addPosOrders(db, query, sales)
	return sales.result(restaurantTruncated || posTruncated)
}
