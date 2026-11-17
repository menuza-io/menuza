import {
	posOrderCountsAsSale,
	posSaleMoney,
	restaurantSaleMoney,
	saleAmountMinor,
	type SalesBasis,
} from '@repo/common/sales-report-facts'
import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import {
	addDays,
	businessDateOf,
	localParts,
	parseDate,
	startOfLocalDay,
	zonedLocalToUtc,
} from '@repo/zoned-time'
import {
	posOrders,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	countedOrderCondition,
	customerIdsByPhone,
	loadCustomerOrderHistory,
	orderIdentity,
} from './report-records.ts'

/** A location and the zone its business day follows. */
export type TodayLocation = { id: string; timeZone: string }

export type TodayWindow = { start: number; end: number }

export type TodayWindows = {
	today: TodayWindow
	/** Yesterday from midnight to the same clock time as now. */
	yesterday: TodayWindow
	/** The same weekday last week, midnight to the same clock time. */
	lastWeek: TodayWindow
}

/** Money and order count for one currency over one window. */
export type CurrencyTotals = {
	currency: string
	/** Order totals in minor units, the way orders store them. */
	salesMinor: number
	orders: number
}

export type TodayTotals = {
	today: CurrencyTotals[]
	yesterday: CurrencyTotals[]
	lastWeek: CurrencyTotals[]
	/** Distinct guests who placed an order that counts toward sales today. */
	guests: { total: number; firstTime: number; returning: number }
}

/** Most locations one request may ask about; far above any real organization. */
export const TODAY_MAX_LOCATIONS = 50

function sameClockOn(date: string, now: number, timeZone: string) {
	const clock = localParts(now, timeZone)
	const { year, month, day } = parseDate(date)
	const start = startOfLocalDay(date, timeZone)
	const end = zonedLocalToUtc(
		year,
		month,
		day,
		clock.hour,
		clock.minute,
		timeZone,
	)
	return { start, end: Math.max(start, end + clock.second * 1000) }
}

/**
 * The three windows the Today block compares, in the location's own zone:
 * its business day so far, yesterday up to the same clock time, and the
 * same weekday last week up to the same clock time.
 */
export function todayWindows(now: number, timeZone: string): TodayWindows {
	const date = businessDateOf(now, timeZone)
	return {
		today: { start: startOfLocalDay(date, timeZone), end: now },
		yesterday: sameClockOn(addDays(date, -1), now, timeZone),
		lastWeek: sameClockOn(addDays(date, -7), now, timeZone),
	}
}

function windowCondition(
	locations: readonly TodayLocation[],
	pick: (windows: TodayWindows) => TodayWindow,
	windows: ReadonlyMap<string, TodayWindows>,
): SQL {
	const perLocation = locations.map((location) => {
		const window = pick(windows.get(location.id)!)
		return and(
			eq(restaurantOrders.locationId, location.id),
			gte(restaurantOrders.createdAt, new Date(window.start)),
			lte(restaurantOrders.createdAt, new Date(window.end)),
		)!
	})
	return sql.join(
		perLocation.map((condition) => sql`(${condition})`),
		sql` or `,
	)
}

function posWindowCondition(
	locations: readonly TodayLocation[],
	pick: (windows: TodayWindows) => TodayWindow,
	windows: ReadonlyMap<string, TodayWindows>,
): SQL {
	const perLocation = locations.map((location) => {
		const window = pick(windows.get(location.id)!)
		return and(
			eq(posOrders.locationId, location.id),
			inArray(posOrders.status, ['paid', 'refunded']),
			gte(posOrders.paidAt, window.start),
			lte(posOrders.paidAt, window.end),
		)!
	})
	return sql.join(
		perLocation.map((condition) => sql`(${condition})`),
		sql` or `,
	)
}

function addCurrencyTotals(
	merged: Map<string, CurrencyTotals>,
	currency: string,
	salesMinor: number,
	orders: number,
) {
	const key = currency.toUpperCase()
	const entry = merged.get(key) ?? { currency: key, salesMinor: 0, orders: 0 }
	entry.salesMinor += salesMinor
	entry.orders += orders
	merged.set(key, entry)
}

async function totalsByCurrency(
	db: TenantDatabase,
	orgId: string,
	locations: readonly TodayLocation[],
	windows: ReadonlyMap<string, TodayWindows>,
	pick: (windows: TodayWindows) => TodayWindow,
	salesBasis: SalesBasis,
): Promise<CurrencyTotals[]> {
	const [webRows, posRows] = await Promise.all([
		db
			.select({
				currency: restaurantOrders.currency,
				subtotalCents: restaurantOrders.subtotalCents,
				discountCents: restaurantOrders.discountCents,
				loyaltyDiscountCents: restaurantOrders.loyaltyDiscountCents,
				taxCents: restaurantOrders.taxCents,
				tipCents: restaurantOrders.tipCents,
				deliveryFeeCents: restaurantOrders.deliveryFeeCents,
				deliveryDiscountCents: restaurantOrders.deliveryDiscountCents,
				totalCents: restaurantOrders.totalCents,
				serviceFeeCents: restaurantOrders.serviceFeeCents,
				serviceFeeTaxCents: restaurantOrders.serviceFeeTaxCents,
			})
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					countedOrderCondition(),
					sql`(${windowCondition(locations, pick, windows)})`,
				),
			),
		db
			.select({
				currency: posOrders.currency,
				subtotalCents: posOrders.subtotalCents,
				adjustmentCents: posOrders.adjustmentCents,
				taxCents: posOrders.taxCents,
				tipCents: posOrders.tipCents,
				totalCents: posOrders.totalCents,
				taxInclusive: posOrders.taxInclusive,
				adjustments: posOrders.adjustments,
				status: posOrders.status,
			})
			.from(posOrders)
			.where(sql`(${posWindowCondition(locations, pick, windows)})`),
	])
	const merged = new Map<string, CurrencyTotals>()
	for (const row of webRows) {
		const money = restaurantSaleMoney({
			subtotalCents: row.subtotalCents,
			discountCents: row.discountCents,
			loyaltyDiscountCents: row.loyaltyDiscountCents,
			taxCents: row.taxCents,
			tipCents: row.tipCents ?? 0,
			deliveryFeeCents: row.deliveryFeeCents,
			deliveryDiscountCents: row.deliveryDiscountCents,
			totalCents: row.totalCents,
			serviceFeeCents: row.serviceFeeCents ?? undefined,
			serviceFeeTaxCents: row.serviceFeeTaxCents ?? undefined,
		})
		addCurrencyTotals(
			merged,
			row.currency,
			saleAmountMinor(money, salesBasis),
			1,
		)
	}
	for (const row of posRows) {
		if (!posOrderCountsAsSale(row.status)) continue
		const money = posSaleMoney({
			subtotalCents: row.subtotalCents,
			adjustmentCents: row.adjustmentCents,
			taxCents: row.taxCents,
			tipCents: row.tipCents,
			totalCents: row.totalCents,
			taxInclusive: row.taxInclusive,
			adjustments: row.adjustments,
		})
		addCurrencyTotals(
			merged,
			row.currency,
			saleAmountMinor(money, salesBasis),
			1,
		)
	}
	return [...merged.values()].sort((a, b) =>
		a.currency.localeCompare(b.currency),
	)
}

/**
 * Today's totals for the given locations, each location counted over its own
 * business day. Uses the reports' rule for what counts toward sales
 * (`countedOrderCondition`) and their way of telling first orders from
 * returning customers, so the numbers match the `sales-total`, `orders-total`
 * and customer-type reports for the same day. Returns totals only: no order,
 * customer or contact field leaves this function.
 */
export async function loadTodayTotals(
	db: TenantDatabase,
	orgId: string,
	locations: readonly TodayLocation[],
	now: number,
	salesBasis: SalesBasis = 'net',
): Promise<TodayTotals> {
	const empty: TodayTotals = {
		today: [],
		yesterday: [],
		lastWeek: [],
		guests: { total: 0, firstTime: 0, returning: 0 },
	}
	if (locations.length === 0) return empty
	const windows = new Map(
		locations.map((location) => [
			location.id,
			todayWindows(now, location.timeZone),
		]),
	)
	const [today, yesterday, lastWeek, todayOrders] = await Promise.all([
		totalsByCurrency(db, orgId, locations, windows, (w) => w.today, salesBasis),
		totalsByCurrency(
			db,
			orgId,
			locations,
			windows,
			(w) => w.yesterday,
			salesBasis,
		),
		totalsByCurrency(
			db,
			orgId,
			locations,
			windows,
			(w) => w.lastWeek,
			salesBasis,
		),
		db
			.select({
				customerId: restaurantOrders.customerId,
				contactPhone: restaurantOrders.contactPhone,
				locationId: restaurantOrders.locationId,
			})
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					countedOrderCondition(),
					sql`(${windowCondition(locations, (w) => w.today, windows)})`,
				),
			),
	])
	if (todayOrders.length === 0) return { ...empty, today, yesterday, lastWeek }

	const byPhone = await customerIdsByPhone(db)
	const history = await loadCustomerOrderHistory(db, orgId, byPhone)
	// Earliest start of "today" for each guest: the window of the location
	// they ordered at. A guest is first-time when their first order that
	// counts toward sales falls inside today.
	const guests = new Map<string, number>()
	let anonymous = 0
	for (const order of todayOrders) {
		const identity = orderIdentity(order, byPhone)
		const start = windows.get(order.locationId)!.today.start
		if (!identity) {
			// No account and no usable phone: one guest per order, and the
			// reports call such an order a first order.
			anonymous += 1
			continue
		}
		const previous = guests.get(identity)
		guests.set(identity, previous == null ? start : Math.min(previous, start))
	}
	let firstTime = anonymous
	for (const [identity, start] of guests) {
		const firstAt = history.get(identity)?.firstAt?.getTime()
		if (firstAt == null || firstAt >= start) firstTime += 1
	}
	const total = guests.size + anonymous
	return {
		today,
		yesterday,
		lastWeek,
		guests: { total, firstTime, returning: total - firstTime },
	}
}
