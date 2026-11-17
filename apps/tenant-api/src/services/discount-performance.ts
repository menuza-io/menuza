import {
	posOrderCountsAsSale,
	posSaleMoney,
	restaurantSaleMoney,
	saleAmountMinor,
	type SalesBasis,
} from '@repo/common/sales-report-facts'
import {
	type DiscountPerformanceEntry,
	type DiscountPerformanceResponse,
} from '@repo/discounts'
import {
	discountRedemptions,
	posOrders,
	qrTabs,
	restaurantOrders,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'
import {
	baseRedemptionSourceId,
	redemptionLocationScope,
	tabIdOfRedemption,
} from './discount-apply.ts'
import { countedOrderCondition } from './report-records.ts'

type DiscountDb = TenantDatabase | TenantTransaction

/**
 * Orders, sales and discount given for each discount over a period (#390).
 *
 * A use counts once its sale stands: a `consumed` redemption. A sale still
 * waiting on payment or pickup (`reserved`), a cancelled one (`released`) and
 * a fully refunded one (`refunded`) are not performance. Each use is read with
 * the whole sale it belongs to, so `salesMinor` is what the guests spent on
 * those orders, not just the discounted part, by the reports' gross or net
 * rule (`@repo/common/sales-report-facts`, the same functions the sales
 * reports use). The period is a window of instants in the caller's zone, on
 * the time the use was recorded.
 *
 * Sales are read from the sale itself: a web or QR order, a Station sale, or
 * a table tab (a tab holds its items before discounts, so its net takes this
 * discount and any loyalty reward off). The answer is ids and amounts; names
 * come from the App. Locations restrict every figure the same way.
 */
export async function readDiscountPerformance(
	db: DiscountDb,
	input: {
		ids: readonly string[]
		fromMs: number
		toMs: number
		basis: SalesBasis
		/** `null` = every location. */
		locationIds: readonly string[] | null
	},
): Promise<DiscountPerformanceResponse> {
	const ids = [...new Set(input.ids)]
	const { fromMs, toMs, basis, locationIds } = input
	if (locationIds !== null && locationIds.length === 0) {
		return {
			basis,
			entries: ids.map((discountId) => ({
				discountId,
				orders: 0,
				salesMinor: 0,
				discountMinor: 0,
			})),
			ordersTotal: 0,
			ordersWithDiscount: 0,
		}
	}
	const scope = redemptionLocationScope(db, locationIds)
	const inWindow = and(
		eq(discountRedemptions.state, 'consumed'),
		gte(discountRedemptions.createdAt, fromMs),
		lt(discountRedemptions.createdAt, toMs),
		scope,
	)

	const byDiscount = new Map<
		string,
		DiscountPerformanceEntry & { seen: Set<string> }
	>(
		ids.map((discountId) => [
			discountId,
			{ discountId, orders: 0, salesMinor: 0, discountMinor: 0, seen: new Set() },
		]),
	)
	if (ids.length > 0) {
		const baseSource = baseRedemptionSourceId()
		const rows = await db
			.select({
				discountId: discountRedemptions.discountId,
				sourceType: discountRedemptions.sourceType,
				sourceId: baseSource,
				amountMinor: discountRedemptions.amountMinor,
				deliveryAmountMinor: discountRedemptions.deliveryAmountMinor,
				// A web or QR order.
				orderId: restaurantOrders.id,
				oSubtotal: restaurantOrders.subtotalCents,
				oDiscount: restaurantOrders.discountCents,
				oLoyalty: restaurantOrders.loyaltyDiscountCents,
				oTax: restaurantOrders.taxCents,
				oTip: restaurantOrders.tipCents,
				oDeliveryFee: restaurantOrders.deliveryFeeCents,
				oDeliveryDiscount: restaurantOrders.deliveryDiscountCents,
				oTotal: restaurantOrders.totalCents,
				oServiceFee: restaurantOrders.serviceFeeCents,
				oServiceFeeTax: restaurantOrders.serviceFeeTaxCents,
				oPackagingFee: restaurantOrders.packagingFeeCents,
				oPackagingFeeTax: restaurantOrders.packagingFeeTaxCents,
				// A Station sale.
				posId: posOrders.id,
				pStatus: posOrders.status,
				pSubtotal: posOrders.subtotalCents,
				pAdjustment: posOrders.adjustmentCents,
				pTax: posOrders.taxCents,
				pTip: posOrders.tipCents,
				pTotal: posOrders.totalCents,
				pTaxInclusive: posOrders.taxInclusive,
				pAdjustments: posOrders.adjustments,
				// A table tab.
				tabRow: qrTabs.id,
				tSubtotal: qrTabs.subtotalCents,
				tServiceFee: qrTabs.serviceFeeCents,
				tLoyalty: qrTabs.loyaltyDiscountCents,
			})
			.from(discountRedemptions)
			.leftJoin(
				restaurantOrders,
				and(
					eq(discountRedemptions.sourceType, 'order'),
					sql`${baseSource} = ${restaurantOrders.id}`,
				),
			)
			.leftJoin(
				posOrders,
				and(
					eq(discountRedemptions.sourceType, 'pos'),
					sql`${baseSource} = ${posOrders.id}`,
				),
			)
			.leftJoin(
				qrTabs,
				and(
					eq(discountRedemptions.sourceType, 'tab'),
					sql`${tabIdOfRedemption()} = ${qrTabs.id}`,
				),
			)
			.where(and(inJsonList(discountRedemptions.discountId, ids), inWindow))
		for (const row of rows) {
			const entry = byDiscount.get(row.discountId)
			if (!entry) continue
			// One sale counts once per discount, however many rows it left (a sale
			// paid after its hold lapsed is re-recorded under a `:late` copy).
			const key = `${row.sourceType}:${row.sourceId}`
			if (entry.seen.has(key)) continue
			entry.seen.add(key)
			const given = row.amountMinor + row.deliveryAmountMinor
			let sale = 0
			if (row.sourceType === 'order' && row.orderId) {
				sale = saleAmountMinor(
					restaurantSaleMoney({
						subtotalCents: row.oSubtotal ?? 0,
						discountCents: row.oDiscount ?? 0,
						loyaltyDiscountCents: row.oLoyalty,
						taxCents: row.oTax ?? 0,
						tipCents: row.oTip ?? 0,
						deliveryFeeCents: row.oDeliveryFee ?? 0,
						deliveryDiscountCents: row.oDeliveryDiscount ?? 0,
						totalCents: row.oTotal ?? 0,
						serviceFeeCents: row.oServiceFee ?? 0,
						serviceFeeTaxCents: row.oServiceFeeTax ?? 0,
						packagingFeeCents: row.oPackagingFee ?? 0,
						packagingFeeTaxCents: row.oPackagingFeeTax ?? 0,
					}),
					basis,
				)
			} else if (row.sourceType === 'pos' && row.posId) {
				if (!posOrderCountsAsSale(row.pStatus ?? '')) continue
				sale = saleAmountMinor(
					posSaleMoney({
						subtotalCents: row.pSubtotal ?? 0,
						adjustmentCents: row.pAdjustment ?? 0,
						taxCents: row.pTax ?? 0,
						tipCents: row.pTip ?? 0,
						totalCents: row.pTotal ?? 0,
						taxInclusive: row.pTaxInclusive ?? false,
						adjustments: row.pAdjustments,
					}),
					basis,
				)
			} else if (row.sourceType === 'tab' && row.tabRow) {
				const gross = (row.tSubtotal ?? 0) + (row.tServiceFee ?? 0)
				const net = Math.max(
					0,
					gross - row.amountMinor - (row.tLoyalty ?? 0),
				)
				sale = basis === 'gross' ? gross : net
			}
			entry.orders += 1
			entry.salesMinor += sale
			entry.discountMinor += given
		}
	}

	// The share of sales that used a discount: every sale in the window, and
	// those that used at least one (of any discount, a till one included). A
	// table round is part of its tab, so a tab counts once, a Station sale once.
	const [webTotal, tabTotal, posTotal] = await Promise.all([
		db
			.select({ n: count() })
			.from(restaurantOrders)
			.where(
				and(
					countedOrderCondition(),
					sql`${restaurantOrders.tabId} is null`,
					gte(restaurantOrders.createdAt, new Date(fromMs)),
					lt(restaurantOrders.createdAt, new Date(toMs)),
					locationIds
						? inJsonList(restaurantOrders.locationId, [...locationIds])
						: undefined,
				),
			),
		db
			.select({ n: count() })
			.from(qrTabs)
			.where(
				and(
					eq(qrTabs.status, 'closed'),
					eq(qrTabs.rungUpOnStation, false),
					gte(qrTabs.paidAt, fromMs),
					lt(qrTabs.paidAt, toMs),
					locationIds
						? inJsonList(qrTabs.locationId, [...locationIds])
						: undefined,
				),
			),
		db
			.select({ n: count() })
			.from(posOrders)
			.where(
				and(
					sql`${posOrders.status} in ('paid', 'refunded')`,
					gte(posOrders.paidAt, fromMs),
					lt(posOrders.paidAt, toMs),
					locationIds
						? inJsonList(posOrders.locationId, [...locationIds])
						: undefined,
				),
			),
	])
	const [withDiscount] = await db
		.select({
			n: sql<number>`count(distinct ${discountRedemptions.sourceType} || ':' || ${baseRedemptionSourceId()})`,
		})
		.from(discountRedemptions)
		.where(inWindow)

	const ordersTotal =
		Number(webTotal[0]?.n ?? 0) +
		Number(tabTotal[0]?.n ?? 0) +
		Number(posTotal[0]?.n ?? 0)

	return {
		basis,
		entries: [...byDiscount.values()].map(
			({ seen: ignoredSeen, ...entry }) => entry,
		),
		ordersTotal,
		// A sale that is in the numerator but not the total (a use recorded on
		// the edge of the window) never makes the share pass 100%.
		ordersWithDiscount: Math.min(Number(withDiscount?.n ?? 0), ordersTotal),
	}
}
