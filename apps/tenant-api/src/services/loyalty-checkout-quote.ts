import {
	priceRestaurantOrder,
	type RestaurantOrderQuoteRequest,
	type VerifiedDeliveryQuote,
} from '@repo/common/restaurant-orders'
import {
	LoyaltyDomainError,
	normalizeCurrency,
	sameCurrency,
	type LoyaltyCart,
	type LoyaltyCheckoutQuote,
	type LoyaltyOrderReward,
	type LoyaltyRewardQuote,
} from '@repo/loyalty'
import { getTenantDb, qrTabs, type TenantDatabase } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'

import { verifyDeliveryQuote } from '../lib/delivery-quote-token.ts'
import { readTabToken } from '../lib/qr-tokens.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	applyLoyaltyDiscountToTotals,
	discountedTabTotals,
	loyaltyCartForPricedOrder,
} from '../restaurant/loyalty-checkout.ts'
import { tabLoyaltyCart } from '../restaurant/loyalty-sources.ts'
import { readBalanceViewInTx } from './loyalty-ledger.ts'
import {
	memberForCustomerInTx,
	ensureMemberForCustomer,
	type MemberRow,
} from './loyalty-member-service.ts'
import {
	activeRewardsInTx,
	readProgramInTx,
} from './loyalty-program-service.ts'
import { purchaseForSourceInTx } from './loyalty-purchase-service.ts'
import { quoteReward } from './loyalty-redemption-service.ts'
import {
	fetchOrderContext,
	orderFailure,
	type OrderServiceResult,
} from './order-service.ts'
import { listTabRounds, tabTotals } from './qr-dine-in.ts'

type MemberRewardQuotes = Pick<
	LoyaltyCheckoutQuote,
	'currency' | 'unitLabel' | 'balance'
> & {
	member: MemberRow
	rewards: LoyaltyRewardQuote[]
	/** The pick, when it still applies as seen and the member can afford it. */
	chosen: LoyaltyRewardQuote | null
}

/**
 * Every active reward priced on a cart for a signed-in member, and the one
 * they picked. Throws a loyalty error when the member cannot use rewards
 * here at all (no points account, inactive, no active program, wrong
 * currency). A verified customer who has no account yet gets one here (the
 * automatic link), so their first quote works.
 */
async function quoteMemberRewards(
	orgId: string,
	db: TenantDatabase,
	input: {
		customerId: string
		cart: LoyaltyCart
		currency: string
		selection: LoyaltyOrderReward | null
	},
): Promise<MemberRewardQuotes> {
	const { customerId, cart, selection } = input
	const member =
		(await memberForCustomerInTx(db, customerId)) ??
		(await ensureMemberForCustomer(orgId, { customerId }))
	if (!member) throw new LoyaltyDomainError('member_not_found')
	if (member.status !== 'active') {
		throw new LoyaltyDomainError('member_inactive')
	}
	const program = await readProgramInTx(db)
	if (!program || program.current.status !== 'active') {
		throw new LoyaltyDomainError('program_inactive')
	}
	const currency = normalizeCurrency(input.currency)
	if (!sameCurrency(program.current.currency, currency)) {
		throw new LoyaltyDomainError('currency_mismatch')
	}

	const balance = await readBalanceViewInTx(db, member.id)
	const rewards = (await activeRewardsInTx(db)).filter((reward) =>
		sameCurrency(reward.currency, currency),
	)
	const quotes = rewards.map((reward) =>
		quoteReward(
			reward,
			cart,
			balance.available,
			selection?.rewardId === reward.rewardId ? selection.targetLineId : null,
		),
	)
	// A pick that changed version, stopped applying or is not affordable is
	// not applied; the reward's own quote says why.
	const chosen = selection
		? (quotes.find(
				(quote) =>
					quote.rewardId === selection.rewardId &&
					quote.rewardVersion === selection.rewardVersion &&
					quote.applicable &&
					quote.affordable,
			) ?? null)
		: null
	return {
		member,
		currency,
		unitLabel: program.current.config.unitLabel,
		balance,
		rewards: quotes,
		chosen,
	}
}

/**
 * The checkout quote for a signed-in member: every active reward priced
 * against the cart as the region prices it, and the totals with the one they
 * picked. The cart is priced exactly like placement prices it (same context,
 * delivery check and engine), so the discount shown is the one placement
 * re-checks. Reads only: nothing is held until the order is placed.
 */
export async function quoteCheckout(input: {
	orgId: string
	customerId: string
	request: RestaurantOrderQuoteRequest
	selection: LoyaltyOrderReward | null
	now?: Date
}): Promise<OrderServiceResult<LoyaltyCheckoutQuote>> {
	const { orgId, customerId, request, selection } = input
	const now = input.now ?? new Date()
	if (request.fulfillment === 'dine_in') {
		return orderFailure(
			422,
			'loyalty_on_tab',
			'Rewards are chosen when the tab is paid, not per round.',
		)
	}

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
	const result = priced.result

	const quoted = await quoteMemberRewards(orgId, await getTenantDb(orgId), {
		customerId,
		cart: loyaltyCartForPricedOrder(result),
		currency: result.currency,
		selection,
	})
	const { chosen } = quoted
	const totals = chosen
		? applyLoyaltyDiscountToTotals(result, chosen.lines, chosen.discountMinor)
		: {
				loyaltyDiscountCents: 0,
				taxCents: result.taxCents,
				totalCents: result.totalCents,
			}

	return {
		ok: true,
		data: {
			currency: quoted.currency,
			unitLabel: quoted.unitLabel,
			balance: quoted.balance,
			rewards: quoted.rewards,
			totals: {
				subtotalMinor: result.subtotalCents,
				discountMinor: totals.loyaltyDiscountCents,
				taxMinor: totals.taxCents,
				taxInclusive: result.taxInclusive,
				tipMinor: result.tipCents,
				deliveryFeeMinor: result.deliveryFeeCents,
				totalMinor: totals.totalCents,
			},
			selectedRewardId: chosen?.rewardId ?? null,
			availableAfter: quoted.balance.available - (chosen?.pointsCost ?? 0),
		},
	}
}

/**
 * The same quote for an open QR tab, priced on its stored rounds the way the
 * tab payment re-checks it (the discount comes off before tax). The tip is a
 * share of the subtotal, like the payment's. Reads only.
 */
export async function quoteTab(input: {
	orgId: string
	customerId: string
	tabToken: string
	tipPercent: number
	selection: LoyaltyOrderReward | null
}): Promise<OrderServiceResult<LoyaltyCheckoutQuote>> {
	const { orgId, customerId, selection } = input
	const parsed = readTabToken(orgId, input.tabToken)
	if (!parsed) {
		return orderFailure(
			404,
			'tab_not_found',
			'This tab is no longer available.',
		)
	}
	const db = await getTenantDb(orgId)
	const tab = await db
		.select()
		.from(qrTabs)
		.where(eq(qrTabs.id, parsed.id))
		.get()
	if (!tab || tab.tabTokenVersion !== parsed.version) {
		return orderFailure(
			404,
			'tab_not_found',
			'This tab is no longer available.',
		)
	}
	if (tab.status !== 'open') {
		return orderFailure(409, 'tab_closed', 'This tab is already closed.')
	}
	if (tab.lockedAt != null) {
		return orderFailure(
			423,
			'tab_locked',
			'A team member is settling this tab. Please ask them for help.',
		)
	}

	const rounds = await listTabRounds(db, [tab.id])
	const quoted = await quoteMemberRewards(orgId, db, {
		customerId,
		cart: tabLoyaltyCart(tab, rounds),
		currency: tab.currency,
		selection,
	})
	// One member collects a shared tab: the first to order on it or pay it.
	const claimed = await purchaseForSourceInTx(db, {
		type: 'qr_tab',
		id: tab.id,
	})
	if (claimed && claimed.memberId !== quoted.member.id) {
		throw new LoyaltyDomainError('already_claimed')
	}

	const totals = tabTotals(tab, rounds)
	const rewarded = quoted.chosen
		? discountedTabTotals(rounds, quoted.chosen.lines)
		: null
	const chosen = rewarded ? quoted.chosen : null
	const tipCents = Math.round((totals.subtotalCents * input.tipPercent) / 100)
	return {
		ok: true,
		data: {
			currency: quoted.currency,
			unitLabel: quoted.unitLabel,
			balance: quoted.balance,
			rewards: quoted.rewards,
			totals: {
				subtotalMinor: totals.subtotalCents,
				discountMinor: rewarded?.loyaltyDiscountCents ?? 0,
				taxMinor: rewarded?.taxCents ?? totals.taxCents,
				taxInclusive: totals.taxInclusive,
				tipMinor: tipCents,
				deliveryFeeMinor: 0,
				totalMinor: (rewarded?.totalCents ?? totals.totalCents) + tipCents,
			},
			selectedRewardId: chosen?.rewardId ?? null,
			availableAfter: quoted.balance.available - (chosen?.pointsCost ?? 0),
		},
	}
}
