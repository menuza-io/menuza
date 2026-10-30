import {
	LoyaltyDomainError,
	loyaltyReportSchema,
	ratioToBp,
	type LoyaltyReport,
	type LoyaltyReportQuery,
} from '@repo/loyalty'
import {
	loyaltyBalances,
	loyaltyLedger,
	loyaltyMembers,
	loyaltyPurchases,
	loyaltyRedemptions,
	loyaltyRefunds,
	restaurantOrderRefunds,
} from '@repo/tenant-db'
import { addDays, startOfLocalDay } from '@repo/zoned-time'
import {
	and,
	eq,
	gte,
	inArray,
	lt,
	ne,
	sql,
	type SQLWrapper,
} from 'drizzle-orm'
import { type LoyaltyReader } from '../lib/loyalty-write.ts'
import { scopeCondition } from './loyalty-activity-service.ts'
import { readProgramInTx } from './loyalty-program-service.ts'

/**
 * Program figures for an operator window (`GET /operator/loyalty/reports`).
 * The window is org-local calendar days in the program's time zone, both ends
 * included. Definitions live on `loyaltyReportSchema` and in docs/loyalty.md;
 * differences between customers with and without accounts are never uplift (no causal claim).
 *
 * "Earning purchase" below is a completed purchase: it finished paid and was
 * evaluated (it may still have earned zero, e.g. below the minimum spend).
 * Open, review and excluded purchases never count.
 */

function toNumber(value: unknown): number {
	return Number(value ?? 0)
}

export async function getLoyaltyReport(
	db: LoyaltyReader,
	query: LoyaltyReportQuery,
	options: { locationIds?: readonly string[] | null; now?: number } = {},
): Promise<LoyaltyReport> {
	const program = await readProgramInTx(db)
	if (!program) throw new LoyaltyDomainError('program_not_found')
	const locationIds = options.locationIds ?? null
	const now = options.now ?? Date.now()
	const timeZone = program.current.config.timeZone
	const fromMs = startOfLocalDay(query.from, timeZone)
	const toMs = startOfLocalDay(addDays(query.to, 1), timeZone)
	const inWindow = (column: SQLWrapper) =>
		and(gte(column, fromMs), lt(column, toMs))
	// A member has no location; a scoped report counts the members with a
	// purchase at a visible location, like the member detail does per row.
	const memberScope =
		locationIds === null
			? undefined
			: sql`exists (select 1 from ${loyaltyPurchases} where ${loyaltyPurchases.memberId} = ${loyaltyMembers.id} and ${scopeCondition(loyaltyPurchases.locationId, locationIds)!})`

	// ---- Accounts (a customer's points account) ----------------------------
	const accounts = await db
		.select({
			total: sql<number>`count(*)`,
			opened: sql<number>`sum(case when ${loyaltyMembers.createdAt} >= ${fromMs} and ${loyaltyMembers.createdAt} < ${toMs} then 1 else 0 end)`,
		})
		.from(loyaltyMembers)
		.where(and(ne(loyaltyMembers.status, 'erased'), memberScope))
		.get()

	// ---- Purchases (completed in the window), grouped per member ----------
	// Summed in SQL: the report reads one row however many members bought.
	const perMember = db
		.select({
			purchases: sql<number>`count(*)`.as('purchases'),
			paid: sql<number>`sum(${loyaltyPurchases.totalPaidMinor})`.as('paid'),
			refunded: sql<number>`sum(${loyaltyPurchases.refundedMinor})`.as(
				'refunded',
			),
		})
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.state, 'completed'),
				inWindow(loyaltyPurchases.occurredAt),
				scopeCondition(loyaltyPurchases.locationId, locationIds),
			),
		)
		.groupBy(loyaltyPurchases.memberId)
		.as('per_member')
	const purchaseTotals = await db
		.select({
			members: sql<number>`count(*)`,
			purchases: sql<number>`sum(${perMember.purchases})`,
			revenue: sql<number>`sum(${perMember.paid} - ${perMember.refunded})`,
			repeatMembers: sql<number>`sum(case when ${perMember.purchases} >= 2 then 1 else 0 end)`,
		})
		.from(perMember)
		.get()
	const activeMembers = toNumber(purchaseTotals?.members)
	const purchaseCount = toNumber(purchaseTotals?.purchases)
	const customerRevenueMinor = toNumber(purchaseTotals?.revenue)
	const repeatMembers = toNumber(purchaseTotals?.repeatMembers)

	// ---- Points -----------------------------------------------------------
	const ledgerSums = await db
		.select({
			type: loyaltyLedger.type,
			total: sql<number>`sum(${loyaltyLedger.delta})`,
		})
		.from(loyaltyLedger)
		.where(
			and(
				inWindow(loyaltyLedger.at),
				scopeCondition(loyaltyLedger.locationId, locationIds),
			),
		)
		.groupBy(loyaltyLedger.type)
		.all()
	const pointsByType = new Map(
		ledgerSums.map((row) => [row.type, toNumber(row.total)]),
	)
	const balanceSums = await db
		.select({
			points: sql<number>`sum(${loyaltyBalances.points})`,
			reserved: sql<number>`sum(${loyaltyBalances.reserved})`,
		})
		.from(loyaltyBalances)
		.where(
			locationIds === null
				? undefined
				: sql`exists (select 1 from ${loyaltyPurchases} where ${loyaltyPurchases.memberId} = ${loyaltyBalances.memberId} and ${scopeCondition(loyaltyPurchases.locationId, locationIds)!})`,
		)
		.get()

	// ---- Redemptions -------------------------------------------------------
	// A reward counts in the window it was used in even once restored, and its
	// restore counts in the window of the restore: a later restore never
	// changes a past window, and one in the same window nets to zero.
	const consumed = await db
		.select({
			count: sql<number>`count(*)`,
			discount: sql<number>`sum(${loyaltyRedemptions.discountMinor})`,
			members: sql<number>`count(distinct ${loyaltyRedemptions.memberId})`,
		})
		.from(loyaltyRedemptions)
		.where(
			and(
				inArray(loyaltyRedemptions.state, ['consumed', 'restored']),
				inWindow(loyaltyRedemptions.consumedAt),
				scopeCondition(loyaltyRedemptions.locationId, locationIds),
			),
		)
		.get()
	const restored = await db
		.select({
			count: sql<number>`count(*)`,
			discount: sql<number>`sum(${loyaltyRedemptions.discountMinor})`,
		})
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.state, 'restored'),
				inWindow(loyaltyRedemptions.restoredAt),
				scopeCondition(loyaltyRedemptions.locationId, locationIds),
			),
		)
		.get()
	const released = await db
		.select({ count: sql<number>`count(*)` })
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.state, 'released'),
				inWindow(loyaltyRedemptions.releasedAt),
				scopeCondition(loyaltyRedemptions.locationId, locationIds),
			),
		)
		.get()
	const consumedCount = toNumber(consumed?.count)
	const consumedDiscount = toNumber(consumed?.discount)

	// ---- Operations --------------------------------------------------------
	const redemptionsInReview = await db
		.select({ count: sql<number>`count(*)` })
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.state, 'review'),
				scopeCondition(loyaltyRedemptions.locationId, locationIds),
			),
		)
		.get()
	const purchasesInReview = await db
		.select({ count: sql<number>`count(*)` })
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.state, 'review'),
				scopeCondition(loyaltyPurchases.locationId, locationIds),
			),
		)
		.get()
	const open = await db
		.select({
			count: sql<number>`count(*)`,
			oldest: sql<number>`min(${loyaltyRedemptions.createdAt})`,
		})
		.from(loyaltyRedemptions)
		.where(
			and(
				inArray(loyaltyRedemptions.state, ['reserved', 'bound']),
				scopeCondition(loyaltyRedemptions.locationId, locationIds),
			),
		)
		.get()
	// A refund row has no location of its own: it follows its purchase, and a
	// refund without one is organization-wide.
	const tabRefunds = await db
		.select({ count: sql<number>`count(*)` })
		.from(loyaltyRefunds)
		.where(
			and(
				inWindow(loyaltyRefunds.createdAt),
				locationIds === null
					? undefined
					: sql`(${loyaltyRefunds.purchaseId} is null or exists (select 1 from ${loyaltyPurchases} where ${loyaltyPurchases.id} = ${loyaltyRefunds.purchaseId} and ${scopeCondition(loyaltyPurchases.locationId, locationIds)!}))`,
			),
		)
		.get()
	// Refunds recorded on orders count when loyalty tracks the order.
	const purchaseLink =
		locationIds === null
			? sql`exists (select 1 from ${loyaltyPurchases} where ${loyaltyPurchases.sourceType} = 'restaurant_order' and ${loyaltyPurchases.sourceId} = ${restaurantOrderRefunds.orderId})`
			: sql`exists (select 1 from ${loyaltyPurchases} where ${loyaltyPurchases.sourceType} = 'restaurant_order' and ${loyaltyPurchases.sourceId} = ${restaurantOrderRefunds.orderId} and ${scopeCondition(loyaltyPurchases.locationId, locationIds)!})`
	const redemptionLink =
		locationIds === null
			? sql`exists (select 1 from ${loyaltyRedemptions} where ${loyaltyRedemptions.sourceType} = 'restaurant_order' and ${loyaltyRedemptions.sourceId} = ${restaurantOrderRefunds.orderId})`
			: sql`exists (select 1 from ${loyaltyRedemptions} where ${loyaltyRedemptions.sourceType} = 'restaurant_order' and ${loyaltyRedemptions.sourceId} = ${restaurantOrderRefunds.orderId} and ${scopeCondition(loyaltyRedemptions.locationId, locationIds)!})`
	const orderRefunds = await db
		.select({ count: sql<number>`count(*)` })
		.from(restaurantOrderRefunds)
		.where(
			and(
				inWindow(restaurantOrderRefunds.createdAt),
				sql`(${purchaseLink} or ${redemptionLink})`,
			),
		)
		.get()
	const refundsRecorded =
		toNumber(tabRefunds?.count) + toNumber(orderRefunds?.count)

	const oldest = open && open.oldest !== null ? toNumber(open.oldest) : null
	return loyaltyReportSchema.parse({
		window: { from: query.from, to: query.to, timeZone },
		currency: program.program.currency,
		customers: {
			accountsTotal: toNumber(accounts?.total),
			accountsOpened: toNumber(accounts?.opened),
			activeInWindow: activeMembers,
		},
		points: {
			earned: pointsByType.get('earn') ?? 0,
			reversed: -(pointsByType.get('earn_reversal') ?? 0),
			redeemed: -(pointsByType.get('redeem') ?? 0),
			restored: pointsByType.get('redeem_restore') ?? 0,
			adjustedNet: pointsByType.get('adjust') ?? 0,
			reservedNow: toNumber(balanceSums?.reserved),
			outstandingNow: toNumber(balanceSums?.points),
		},
		redemptions: {
			consumed: consumedCount,
			restored: toNumber(restored?.count),
			released: toNumber(released?.count),
			discountCostMinor: consumedDiscount - toNumber(restored?.discount),
			conversionBp: ratioToBp(toNumber(consumed?.members), activeMembers),
		},
		purchases: {
			count: purchaseCount,
			customerRevenueMinor,
			averageOrderValueMinor:
				purchaseCount > 0 ? Math.floor(customerRevenueMinor / purchaseCount) : 0,
			repeatPurchaseRateBp: ratioToBp(repeatMembers, activeMembers),
			frequencyHundredths:
				activeMembers > 0
					? Math.round((purchaseCount * 100) / activeMembers)
					: 0,
		},
		operations: {
			redemptionsInReview: toNumber(redemptionsInReview?.count),
			purchasesInReview: toNumber(purchasesInReview?.count),
			openRedemptions: toNumber(open?.count),
			oldestOpenRedemptionAgeMs:
				oldest !== null ? Math.max(0, now - oldest) : null,
			refundsRecorded,
		},
	})
}
