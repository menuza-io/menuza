import { type TimeWindow } from '@repo/common/ordering-windows'
import {
	averageMissed,
	type MissedEstimate,
	type WeekTotals,
} from '@repo/common/missed-sales'
import { restaurantOrderNetMinor } from '@repo/common/sales-report-facts'
import {
	qrTabs,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { countedOrderCondition } from './report-records.ts'

/**
 * Sales missed while online ordering was paused (#176): the average web and QR
 * sales that count toward sales in the same weekday and window over earlier
 * weeks at one location. The App decides the windows (it holds the hours and
 * the pause history); this only sums what the region holds, per window, and
 * says what it is: an estimate. Only the windows go in and only totals come
 * out: no order, name or contact leaves.
 *
 * Station sales are not estimated (the pause stops web and QR ordering only),
 * and a rung-up QR tab is a Station sale. Money is of one currency (the
 * location's): orders in another currency are not added.
 */

export type MissedWindowRequest = {
	id: string
	from: number
	to: number
	/** The usable earlier weeks the App chose. */
	weeks: TimeWindow[]
}

export type MissedWindowAnswer = { id: string } & (
	| { enough: true; orders: number; salesMinor: number; weeksUsed: number }
	| { enough: false; weeksUsed: number }
)

/** Orders and net sales inside each window, by window. */
export async function sumOnlineSalesInWindows(
	db: TenantDatabase,
	input: { orgId: string; locationId: string; currency: string },
	windows: readonly TimeWindow[],
): Promise<WeekTotals[]> {
	const totals = windows.map(() => ({ orders: 0, salesMinor: 0 }))
	if (windows.length === 0) return totals
	const from = Math.min(...windows.map((w) => w.from))
	const to = Math.max(...windows.map((w) => w.to))
	const conditions: SQL[] = [
		eq(restaurantOrders.orgId, input.orgId),
		eq(restaurantOrders.locationId, input.locationId),
		countedOrderCondition(),
		sql`lower(${restaurantOrders.currency}) = ${input.currency.toLowerCase()}`,
		// The columns hold epoch seconds.
		sql`${restaurantOrders.createdAt} >= ${Math.floor(from / 1000)}`,
		sql`${restaurantOrders.createdAt} <= ${Math.floor(to / 1000)}`,
		// A rung-up tab is a Station sale, read as that till sale.
		or(isNull(qrTabs.id), eq(qrTabs.rungUpOnStation, false))!,
	]
	const rows = await db
		.select({
			createdAt: restaurantOrders.createdAt,
			subtotalCents: restaurantOrders.subtotalCents,
			discountCents: restaurantOrders.discountCents,
			loyaltyDiscountCents: restaurantOrders.loyaltyDiscountCents,
			taxCents: restaurantOrders.taxCents,
			tipCents: restaurantOrders.tipCents,
			deliveryFeeCents: restaurantOrders.deliveryFeeCents,
			deliveryDiscountCents: restaurantOrders.deliveryDiscountCents,
			serviceFeeCents: restaurantOrders.serviceFeeCents,
			serviceFeeTaxCents: restaurantOrders.serviceFeeTaxCents,
			packagingFeeCents: restaurantOrders.packagingFeeCents,
			packagingFeeTaxCents: restaurantOrders.packagingFeeTaxCents,
			totalCents: restaurantOrders.totalCents,
		})
		.from(restaurantOrders)
		.leftJoin(qrTabs, eq(qrTabs.id, restaurantOrders.tabId))
		.where(and(...conditions))
	for (const row of rows) {
		if (!row.createdAt) continue
		const at = row.createdAt.getTime()
		const index = windows.findIndex((w) => at >= w.from && at < w.to)
		if (index < 0) continue
		totals[index]!.orders += 1
		totals[index]!.salesMinor += restaurantOrderNetMinor(row)
	}
	return totals
}

/** Estimates every requested window; fewer than two usable weeks is "not enough history". */
export async function estimateMissedSales(
	db: TenantDatabase,
	input: { orgId: string; locationId: string; currency: string },
	windows: readonly MissedWindowRequest[],
): Promise<MissedWindowAnswer[]> {
	const answers: MissedWindowAnswer[] = []
	for (const window of windows) {
		let estimate: MissedEstimate
		if (window.weeks.length < 2) {
			estimate = averageMissed(window.weeks.map(() => ({ orders: 0, salesMinor: 0 })))
		} else {
			estimate = averageMissed(
				await sumOnlineSalesInWindows(db, input, window.weeks),
			)
		}
		answers.push({ id: window.id, ...estimate })
	}
	return answers
}
