import { ORDER_PROBLEM_CREDIT_DISCOUNT_ID } from '@repo/common/order-problems'
import {
	normalizeDiscountCode,
	type DiscountCodeRecord,
	type DiscountRecord,
} from '@repo/discounts'
import {
	discountIssuedCodes,
	orderProblems,
	restaurantOrders,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'

/**
 * The credit a restaurant gave for an order problem (#191) is a single-use
 * code of `discount_issued_codes` (source `order_problem`), the same table
 * marketing and referral codes use. Checkout resolves it here, like the
 * referral code: one synthetic fixed-amount discount per code, worth the
 * credit the report recorded, usable once (`maxUses: 1`, uses counted as
 * redemptions with the code's id) and only for an order in the currency it
 * was given in. It needs no discount flag: a credit is a promise already made.
 */

type CreditDb = TenantDatabase | TenantTransaction

export type ResolvedProblemCredit = {
	syntheticRecord: DiscountRecord
	syntheticCode: DiscountCodeRecord
}

export async function resolveProblemCreditForOrder(
	db: CreditDb,
	input: {
		typedCode: string | null | undefined
		currency: string
		now: number
	},
): Promise<ResolvedProblemCredit | null> {
	const typed = input.typedCode?.trim()
	if (!typed) return null
	const normalized = normalizeDiscountCode(typed)
	if (normalized.length < 3 || normalized.length > 24) return null
	const [row] = await db
		.select({
			codeId: discountIssuedCodes.id,
			expiresAt: discountIssuedCodes.expiresAt,
			creditCents: orderProblems.creditCents,
			orderCurrency: restaurantOrders.currency,
		})
		.from(discountIssuedCodes)
		.innerJoin(
			orderProblems,
			and(
				eq(orderProblems.id, discountIssuedCodes.sourceId),
				eq(orderProblems.creditCodeId, discountIssuedCodes.id),
			),
		)
		.innerJoin(restaurantOrders, eq(restaurantOrders.id, orderProblems.orderId))
		.where(
			and(
				eq(discountIssuedCodes.normalizedCode, normalized),
				eq(discountIssuedCodes.sourceType, 'order_problem'),
			),
		)
		.limit(1)
	if (
		!row ||
		row.expiresAt <= input.now ||
		!row.creditCents ||
		row.creditCents < 1 ||
		row.orderCurrency !== input.currency
	) {
		return null
	}
	return {
		syntheticRecord: {
			id: ORDER_PROBLEM_CREDIT_DISCOUNT_ID,
			version: 1,
			createdAt: new Date(input.now).toISOString(),
			name: 'Credit',
			internalName: null,
			description: null,
			status: 'active',
			application: 'code',
			valueType: 'fixed',
			percentBp: null,
			amountMinor: row.creditCents,
			currency: input.currency,
			maxDiscountMinor: null,
			target: {
				scope: 'order',
				itemIds: [],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
			requirement: null,
			quantityRule: { kind: 'none' },
			maxDiscountedUnits: null,
			minSubtotalMinor: null,
			locationIds: null,
			channels: ['web', 'qr', 'app'],
			fulfillments: ['pickup', 'delivery'],
			includeDrops: true,
			schedule: null,
			startsAt: null,
			endsAt: null,
			eligibility: 'everyone',
			totalLimit: null,
			perCustomerLimit: null,
			combinable: true,
			priority: 100,
			promoteOnMenu: false,
			requireApproval: false,
		},
		syntheticCode: {
			id: row.codeId,
			discountId: ORDER_PROBLEM_CREDIT_DISCOUNT_ID,
			normalizedCode: normalized,
			maxUses: 1,
		},
	}
}
