import {
	buildLocationScorecard,
	type LocationMetricRow,
} from '@repo/common/location-scorecard'
import {
	posOrderCountsAsSale,
	posSaleMoney,
	restaurantSaleMoney,
	saleAmountMinor,
	type SalesBasis,
} from '@repo/common/sales-report-facts'
import {
	createReportDefinition,
	resolveTimeframeRange,
	type ReportDefinition,
} from '@repo/reports'
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { posOrders, restaurantOrders } from '@repo/tenant-db'
import { countedOrderCondition } from './report-records.ts'
import { type SalesReportContext } from './sales-report-records.ts'

type Window = { startMs: number | null; endMs: number }

function windowOf(definition: ReportDefinition, now: Date): Window {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	return {
		startMs: range.start ? range.start.getTime() : null,
		endMs: range.end.getTime(),
	}
}

function locationCondition(
	column: typeof restaurantOrders.locationId | typeof posOrders.locationId,
	locationIds: readonly string[] | null,
): SQL[] {
	if (locationIds === null) return []
	if (locationIds.length === 0) return [sql`0`]
	// bounded: analytics token locationIds mirror control-plane locations (well under 100).
	return [inArray(column, [...locationIds])]
}

function inWindow(expression: SQL, window: Window, unitMs: number): SQL[] {
	const conditions: SQL[] = [
		sql`${expression} <= ${Math.floor(window.endMs / unitMs)}`,
	]
	if (window.startMs !== null) {
		conditions.push(
			sql`${expression} >= ${Math.floor(window.startMs / unitMs)}`,
		)
	}
	return conditions
}

export async function loadLocationScorecardRows(
	ctx: SalesReportContext,
	preset: ReportDefinition['timeframe']['preset'],
	salesBasis: SalesBasis,
): Promise<LocationMetricRow[]> {
	const window = windowOf(
		createReportDefinition({
			subject: 'sales',
			timeframe: { field: 'occurredAt', preset },
			visualization: { chartStyle: 'table' },
			settings: { title: 'Sales', timezone: 'organization' },
		}),
		ctx.now,
	)
	const byLocation = new Map<string, LocationMetricRow>()
	const ensure = (locationId: string): LocationMetricRow => {
		const existing = byLocation.get(locationId)
		if (existing) return existing
		const row: LocationMetricRow = {
			locationId,
			salesMinor: 0,
			orderCount: 0,
			cancelledCount: 0,
			missedCount: 0,
			ratingSum: 0,
			ratingCount: 0,
		}
		byLocation.set(locationId, row)
		return row
	}

	const webRows = await ctx.db
		.select({
			locationId: restaurantOrders.locationId,
			subtotalCents: restaurantOrders.subtotalCents,
			taxCents: restaurantOrders.taxCents,
			deliveryFeeCents: restaurantOrders.deliveryFeeCents,
			tipCents: restaurantOrders.tipCents,
			serviceFeeCents: restaurantOrders.serviceFeeCents,
			serviceFeeTaxCents: restaurantOrders.serviceFeeTaxCents,
			packagingFeeCents: restaurantOrders.packagingFeeCents,
			packagingFeeTaxCents: restaurantOrders.packagingFeeTaxCents,
			totalCents: restaurantOrders.totalCents,
			discountCents: restaurantOrders.discountCents,
			deliveryDiscountCents: restaurantOrders.deliveryDiscountCents,
			loyaltyDiscountCents: restaurantOrders.loyaltyDiscountCents,
			giftCardCents: restaurantOrders.giftCardCents,
			refundedCents: restaurantOrders.refundedCents,
			refundReversedCents: restaurantOrders.refundReversedCents,
		})
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.orgId, ctx.orgId),
				countedOrderCondition(),
				...inWindow(sql`${restaurantOrders.createdAt}`, window, 1000),
				...locationCondition(restaurantOrders.locationId, ctx.locationIds),
			),
		)

	for (const row of webRows) {
		const money = restaurantSaleMoney(row)
		const amount = saleAmountMinor(money, salesBasis)
		const entry = ensure(row.locationId)
		entry.salesMinor += amount
		entry.orderCount += 1
	}

	const posRows = await ctx.db
		.select({
			locationId: posOrders.locationId,
			status: posOrders.status,
			subtotalCents: posOrders.subtotalCents,
			adjustmentCents: posOrders.adjustmentCents,
			taxCents: posOrders.taxCents,
			tipCents: posOrders.tipCents,
			totalCents: posOrders.totalCents,
			taxInclusive: posOrders.taxInclusive,
			adjustments: posOrders.adjustments,
		})
		.from(posOrders)
		.where(
			and(
				...inWindow(sql`${posOrders.rungUpAt}`, window, 1),
				...locationCondition(posOrders.locationId, ctx.locationIds),
			),
		)

	for (const row of posRows.filter((item) =>
		posOrderCountsAsSale(item.status),
	)) {
		const money = posSaleMoney(row)
		const amount = saleAmountMinor(money, salesBasis)
		const entry = ensure(row.locationId)
		entry.salesMinor += amount
		entry.orderCount += 1
	}

	const cancelledRows = await ctx.db
		.select({
			locationId: restaurantOrders.locationId,
			status: restaurantOrders.status,
			rejectedReason: restaurantOrders.rejectedReason,
			cancelReason: restaurantOrders.cancelReason,
		})
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.orgId, ctx.orgId),
				or(
					inArray(restaurantOrders.status, ['cancelled', 'expired']),
					eq(restaurantOrders.rejectedReason, 'not_accepted_in_time'),
				),
				...inWindow(sql`${restaurantOrders.createdAt}`, window, 1000),
				...locationCondition(restaurantOrders.locationId, ctx.locationIds),
			),
		)

	for (const row of cancelledRows) {
		const entry = ensure(row.locationId)
		entry.cancelledCount += 1
		if (row.rejectedReason === 'not_accepted_in_time') {
			entry.missedCount += 1
		}
	}

	return [...byLocation.values()]
}

export async function loadLocationScorecard(
	ctx: SalesReportContext,
	preset: ReportDefinition['timeframe']['preset'],
	salesBasis: SalesBasis,
) {
	return buildLocationScorecard(
		await loadLocationScorecardRows(ctx, preset, salesBasis),
	)
}

/** Net or gross sales minor units per location for the current calendar month. */
export async function loadMonthToDateSalesByLocation(
	ctx: SalesReportContext,
	salesBasis: SalesBasis,
): Promise<Map<string, number>> {
	const rows = await loadLocationScorecardRows(ctx, 'month_to_date', salesBasis)
	return new Map(rows.map((row) => [row.locationId, row.salesMinor]))
}
