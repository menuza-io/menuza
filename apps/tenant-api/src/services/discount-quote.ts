import {
	priceRestaurantOrder,
	type RestaurantOrderDiscountQuoteRequest,
	type VerifiedDeliveryQuote,
} from '@repo/common/restaurant-orders'
import { type DiscountQuote } from '@repo/discounts'
import { LoyaltyDomainError } from '@repo/loyalty'
import { getTenantDb, type TenantTransaction } from '@repo/tenant-db'
import { verifyDeliveryQuote } from '../lib/delivery-quote-token.ts'
import { isDiscountsKillSwitchOn } from '../lib/discount-switches.ts'
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
import { memberForCustomerInTx } from './loyalty-member-service.ts'
import {
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
	now?: Date
}): Promise<OrderServiceResult<DiscountQuote>> {
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
	const discountsOn =
		discountFeatures?.automatic === true || discountFeatures?.coupons === true
	if (!discountsOn && !request.discounts?.code) {
		return orderFailure(
			404,
			'discounts_disabled',
			'Discounts are not available.',
		)
	}
	if (isDiscountsKillSwitchOn() && !request.discounts?.code) {
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
		deliveryQuote = {
			lat: verified.payload.lat,
			lng: verified.payload.lng,
			formatted: verified.payload.formatted,
			line1: verified.payload.line1,
			city: verified.payload.city,
			postalCode: verified.payload.postalCode,
			unit: verified.payload.unit,
		}
	}

	const priced = priceRestaurantOrder(context, request, { now, deliveryQuote })
	if (!priced.ok) {
		const { status, code, message } = priced.error
		return { ok: false, failure: { status, code, message } }
	}

	const prepared = await prepareOrderDiscounts(await getTenantDb(orgId), {
		priced: priced.result,
		context,
		discounts: request.discounts ?? {},
		fulfillment: request.fulfillment,
		source: request.source === 'qr_poster' ? 'qr_poster' : null,
		customerId,
		now,
		killed: isDiscountsKillSwitchOn(),
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
				},
			)
			loyaltyDiscountMinor = withReward.loyaltyDiscountCents
			taxMinor = withReward.taxCents
			totalMinor = withReward.totalCents
		} catch (error) {
			if (error instanceof LoyaltyDomainError) {
				return { ok: false, failure: loyaltyFailure(error) }
			}
			throw error
		}
	}

	return {
		ok: true,
		data: buildDiscountQuote({
			priced: priced.result,
			prepared: prepared.prepared,
			loyaltyDiscountMinor,
			taxMinor,
			totalMinor,
			couponsEnabled: discountFeatures?.coupons === true,
		}),
	}
}
