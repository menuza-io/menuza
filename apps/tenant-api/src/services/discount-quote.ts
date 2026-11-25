import {
	priceRestaurantOrder,
	type RestaurantOrderDiscountQuoteRequest,
	type VerifiedDeliveryQuote,
} from '@repo/common/restaurant-orders'
import { type GiftCardCheckoutQuote } from '@repo/common/gift-card-contract'
import { GiftCardDomainError } from '@repo/common/gift-cards'
import { type DiscountQuote } from '@repo/discounts'
import { LoyaltyDomainError } from '@repo/loyalty'
import { getTenantDb, type TenantTransaction } from '@repo/tenant-db'
import {
	toVerifiedDeliveryQuote,
	verifyDeliveryQuote,
} from '../lib/delivery-quote-token.ts'
import { isDiscountsKillSwitchOn } from '../lib/discount-switches.ts'
import { getLoyaltyFeatures } from '../lib/loyalty-context.ts'
import type { PublishedOrganization } from '../lib/origin.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	applyLoyaltyDiscountToTotals,
	loyaltyCartForPricedOrder,
} from '../restaurant/loyalty-checkout.ts'
import {
	buildDiscountQuote,
	prepareOrderDiscounts,
	totalsAfterDiscounts,
} from './discount-apply.ts'
import { prepareGiftCardForOrder } from './gift-card-orders.ts'
import { assertDailyDishCapacity } from './order-dish-daily-service.ts'
import { memberForCustomerInTx } from './loyalty-member-service.ts'
import {
	derivePublicOrderChannel,
	fetchOrderContext,
	loyaltyFailure,
	orderFailure,
	quotePlacementReward,
	type OrderServiceResult,
} from './order-service.ts'

/**
 * `POST /orders/quote`. Prices the order the way placement will, including
 * discounts and a loyalty reward when one was sent, and returns the quote.
 * Nothing is reserved.
 */
export async function quoteOrderDiscounts(input: {
	organization: PublishedOrganization
	request: RestaurantOrderDiscountQuoteRequest
	customerId: string | null
	client?: string | null
	now?: Date
}): Promise<
	OrderServiceResult<DiscountQuote & { giftCard?: GiftCardCheckoutQuote }>
> {
	const { organization, request, customerId } = input
	const now = input.now ?? new Date()
	const orgId = organization.id
	const contextResult = await fetchOrderContext(
		orgId,
		request.locationId,
		request.dropSlug ?? null,
	)
	if (!contextResult.ok) return contextResult
	const context = contextResult.data
	if (getNodeRegion() !== context.dataRegion) {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}

	// Automatic and coupon flags both off: the website must not wait on this
	// endpoint. 404 is the signal the checkout client treats as "feature off".
	const discountFeatures = context.discounts?.features
	const loyaltyFlags = await getLoyaltyFeatures(orgId).catch(() => null)
	const loyaltyReferralsOn = Boolean(
		loyaltyFlags?.enabled && loyaltyFlags.referrals,
	)
	const discountsOn =
		discountFeatures?.automatic === true ||
		discountFeatures?.coupons === true ||
		loyaltyReferralsOn
	if (!discountsOn && !request.discounts?.code && !request.giftCard) {
		return orderFailure(
			404,
			'discounts_disabled',
			'Discounts are not available.',
		)
	}
	if (
		isDiscountsKillSwitchOn() &&
		!request.discounts?.code &&
		!request.giftCard
	) {
		return orderFailure(
			404,
			'discounts_disabled',
			'Discounts are not available.',
		)
	}

	let deliveryQuote: VerifiedDeliveryQuote | null = null
	const quoteToken =
		request.fulfillment === 'delivery' ? request.delivery?.quoteToken : null
	if (quoteToken) {
		const verified = await verifyDeliveryQuote(quoteToken, {
			orgId,
			locationId: request.locationId,
			now,
		})
		if (!verified.ok) {
			return orderFailure(
				422,
				'delivery_quote_expired',
				'Your delivery address check has expired. Please confirm your address again.',
			)
		}
		deliveryQuote = toVerifiedDeliveryQuote(verified.payload)
	}

	const channel = derivePublicOrderChannel({
		fulfillment: request.fulfillment,
		source: request.source,
		qrOrdering: (context as { qrOrdering?: unknown }).qrOrdering,
		client: input.client,
	})
	const priced = priceRestaurantOrder(context, request, {
		now,
		deliveryQuote,
		channel,
	})
	if (!priced.ok) {
		const { status, code, message, details } = priced.error
		return {
			ok: false,
			failure: { status, code, message, ...(details ? { details } : {}) },
		}
	}

	// A dish or option that has sold out for today (#409) shows at quote time,
	// not only when the guest places the order. Placement checks again.
	const dailyCapacity = await assertDailyDishCapacity({
		db: await getTenantDb(orgId),
		context,
		locationId: request.locationId,
		lines: priced.result.lines,
		now,
	})
	if (!dailyCapacity.ok) return { ok: false, failure: dailyCapacity.failure }

	const prepared = await prepareOrderDiscounts(await getTenantDb(orgId), {
		priced: priced.result,
		context,
		discounts: request.discounts ?? {},
		fulfillment: request.fulfillment,
		source: request.source === 'qr_poster' ? 'qr_poster' : null,
		customerId,
		now,
		killed: isDiscountsKillSwitchOn(),
		orgId,
		phone: request.contact?.phone ?? null,
		deviceId: request.referralDeviceId ?? null,
	})
	if (!prepared.ok) {
		return {
			ok: false,
			failure: {
				status: prepared.failure.status,
				code: prepared.failure.code,
				message: prepared.failure.message,
				...(prepared.failure.reason ? { reason: prepared.failure.reason } : {}),
			},
		}
	}

	const after = totalsAfterDiscounts(priced.result, prepared.prepared)
	let loyaltyDiscountMinor = 0
	let taxMinor = after.taxCents
	let totalMinor = after.totalCents
	let serviceFeeMinor = after.serviceFeeCents
	let packagingFeeMinor = after.packagingFeeCents
	if (request.loyalty && customerId && request.fulfillment !== 'dine_in') {
		try {
			const db = await getTenantDb(orgId)
			const member = await memberForCustomerInTx(db, customerId)
			const cart = loyaltyCartForPricedOrder(
				priced.result,
				prepared.prepared?.evaluation.lineDiscounts ?? {},
			)
			const selected = await quotePlacementReward(
				db as unknown as TenantTransaction,
				{
					member,
					selection: request.loyalty,
					cart,
					currency: priced.result.currency,
				},
			)
			const withReward = applyLoyaltyDiscountToTotals(
				priced.result,
				selected.quote.lines,
				selected.quote.discountMinor,
				{
					lineDiscounts: prepared.prepared?.evaluation.lineDiscounts,
					deliveryDiscountMinor:
						prepared.prepared?.evaluation.deliveryDiscountMinor,
					packagingWaived:
						prepared.prepared?.evaluation.packagingWaived === true,
				},
			)
			loyaltyDiscountMinor = withReward.loyaltyDiscountCents
			taxMinor = withReward.taxCents
			totalMinor = withReward.totalCents
			serviceFeeMinor = withReward.serviceFeeCents
			packagingFeeMinor = withReward.packagingFeeCents
		} catch (error) {
			if (error instanceof LoyaltyDomainError) {
				return { ok: false, failure: loyaltyFailure(error) }
			}
			throw error
		}
	}

	const quote = buildDiscountQuote({
		priced: priced.result,
		prepared: prepared.prepared,
		loyaltyDiscountMinor,
		taxMinor,
		totalMinor,
		serviceFeeMinor,
		packagingFeeMinor,
		couponsEnabled: discountFeatures?.coupons === true || loyaltyReferralsOn,
	})
	if (!request.giftCard || request.fulfillment === 'dine_in') {
		return { ok: true, data: quote }
	}
	// The gift card, after discounts and loyalty: what it would take now.
	try {
		const gift = await prepareGiftCardForOrder(await getTenantDb(orgId), {
			giftCard: request.giftCard,
			customerId,
			totalMinor,
			currency: priced.result.currency,
			now: now.getTime(),
			enforceExpected: false,
		})
		return {
			ok: true,
			data: {
				...quote,
				giftCard: {
					cardId: gift.card.id,
					last4: gift.card.last4,
					appliedMinor: gift.appliedMinor,
					balanceMinor: gift.balanceMinor,
					remainingBalanceMinor: gift.balanceMinor - gift.appliedMinor,
					dueMinor: gift.dueMinor,
				},
			},
		}
	} catch (error) {
		if (error instanceof GiftCardDomainError) {
			return {
				ok: false,
				failure: {
					status: error.status,
					code: error.code,
					message: 'This gift card cannot be used for the order.',
					details: error.details,
				},
			}
		}
		throw error
	}
}
