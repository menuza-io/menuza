import crypto from 'node:crypto'
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	sql,
	sum,
} from 'drizzle-orm'
import { ENV } from 'varlock/env'

import {
	DEFAULT_PREP_MINUTES,
	localDateAndTimeToUtc,
} from '@repo/common/location-availability'
import {
	foldUtensilsRequested,
	parseUtensilsSettings,
} from '@repo/common/checkout-utensils'
import { resolvePickupInstructions } from '@repo/common/pickup-instructions'
import { largeOrderExtraMinutes } from '@repo/common/promised-time'
import {
	acceptanceDeadline,
	buildOrderLimitCatalog,
	buildPublicOrderingOptions,
	canonicalOrderRequest,
	computePromisedTime,
	disputeBlocksRefund,
	guestVisibleCancelReason,
	orderDishUnits,
	orderLimitExemptFromCatalog,
	ORDER_ACCEPTANCE_TIMEOUT_CHOICES,
	orderNeedsAcceptance,
	priceRestaurantOrder,
	readOrderAcceptancePolicy,
	readGuestMessagesPolicy,
	readLargeOrderRule,
	type PromisedDelayMinutes,
	restaurantOrderContextSchema,
	type OrderCapacitySpec,
	type PricedOrderLine,
	type PricedRestaurantOrder,
	type PublicOrderingOptions,
	type ReadySlotCapacitySpec,
	type RestaurantOrderContext,
	type OrderLoyaltySelection,
	type OrderProviderRefund,
	type OrderRefundOrigin,
	type OrderRefundSummaryStatus,
	type OrderStoredCancelReason,
	type RestaurantOrderError,
	type RestaurantOrderRequest,
	type VerifiedDeliveryQuote,
} from '@repo/common/restaurant-orders'
import { wouldExceedSlotLimit } from '@repo/common/slot-usage'
import {
	businessDayDate,
	businessDayStartUtc,
	formatAllocatedOrderNumber,
	parseOrderNumberFormat,
	type OrderNumberFormat,
} from '@repo/common/pos-orders'
import { type OrderMarketingConsentResult } from '@repo/common/marketing-consent'
import { type MenuChannel } from '@repo/common/menu-channels'
import { readQrOrderingFeatures } from '@repo/common/qr-ordering'
import {
	hashLoyaltyCart,
	LOYALTY_REFERRAL_DISCOUNT_ID,
	LoyaltyDomainError,
	sameCurrency,
	type LoyaltyCart,
	type LoyaltyErrorCode,
	type LoyaltyRewardQuote,
} from '@repo/loyalty'
import {
	getTenantDb,
	posOrders,
	qrTabs,
	RESTAURANT_ORDER_ACTIVE_STATUSES,
	runTenantTransaction,
	restaurantOrderRefunds,
	restaurantOrders,
	restaurantOrderReservations,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { verifyDeliveryQuote } from '../lib/delivery-quote-token.ts'
import { isGeocodingAvailable } from '../lib/geocoder.ts'
import type { PublishedOrganization } from '../lib/origin.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	getInternalCommandToken,
	hmacHash,
	syncEnvFromProcess,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { kickOrderRefundExecute } from '../lib/order-refund-kick.ts'
import { deriveTabToken } from '../lib/qr-tokens.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { createOrgLock } from '../lib/concurrency.ts'
import { insertRowsInChunks, inJsonList } from '../lib/chunked-in.ts'
import {
	getLoyaltyFlagState,
	loyaltyCreditsSales,
	rewardRefusal,
} from '../lib/loyalty-context.ts'
import { GiftCardDomainError } from '@repo/common/gift-cards'
import { getGiftCardFlagState } from '../lib/gift-card-context.ts'
import { isGiftCardsKillSwitchOn } from '../lib/gift-card-switches.ts'
import {
	prepareGiftCardForOrder,
	redeemOrderGiftCardInTx,
	restoreOrderGiftCardsInTx,
	type OrderGiftCard,
} from './gift-card-orders.ts'
import { type LoyaltyTx } from '../lib/loyalty-write.ts'
import { isDiscountsKillSwitchOn } from '../lib/discount-switches.ts'
import {
	applyLoyaltyDiscountToTotals,
	loyaltyCartForPricedOrder,
	type LoyaltyDiscountedTotals,
} from '../restaurant/loyalty-checkout.ts'
import { notifyDiscountBudgets } from '../lib/discount-notify.ts'
import {
	buildDiscountQuote,
	consumeDiscountRedemptions,
	type DiscountBudgetCrossing,
	interpretPlacement,
	orderDiscountSnapshots,
	prepareOrderDiscounts,
	refundDiscountRedemptions,
	releaseDiscountRedemptions,
	reReserveReleasedDiscounts,
	reserveOrderDiscounts,
	totalsAfterDiscounts,
} from './discount-apply.ts'
import { releaseTabDiscounts } from './discount-tab.ts'
import { qrTabPayableUntil } from '../restaurant/loyalty-sources.ts'
import { readBalanceViewInTx } from './loyalty-ledger.ts'
import {
	ensureMemberForCustomerInTx,
	memberForCustomerInTx,
	type MemberRow,
} from './loyalty-member-service.ts'
import { inventorySaleQueue } from './inventory-sales-service.ts'
import {
	orderMessageBatch,
	queueOrderMessage,
	queueOrderPaidMessages,
	queueOrderPlacedMessages,
	queueOrderStatusMessages,
} from './order-messages.ts'
import {
	assertDailyDishCapacity,
	readDailyDishAvailability,
	recordDailyDishClaims,
} from './order-dish-daily-service.ts'
import { applyPromisedDelay } from './order-promised-time.ts'
import {
	bookOrderProviderRefundInTx,
	cancelRefundKey,
	cancelRefundStaysOwed,
	orderCarriesLoyalty,
	orderPaidCents,
	orderProviderRefundView,
	orderRefundedNetCents,
	orderRefundSummary,
	orderServiceFeeChargeCents,
	owedCancelRefundKey,
} from './order-refund-book.ts'
import {
	readProgramInTx,
	readRewardInTx,
	type CurrentReward,
} from './loyalty-program-service.ts'
import {
	queueOrderConsentConfirmation,
	recordOrderMarketingConsentInTx,
	type OrderConsentConfirmation,
} from './order-marketing-consent.ts'
import { clearCartSnapshot } from './cart-reminders.ts'
import { scheduleOrderJourneys } from './order-journeys.ts'
import { orderCountsTowardSales } from './report-records.ts'
import {
	claimPurchaseIfUnclaimedInTx,
	claimPurchaseInTx,
	loyaltySettleQueue,
	type LoyaltySettleQueue,
} from './loyalty-purchase-service.ts'
import {
	quoteReward,
	reserveRedemptionInTx,
	setAsideSourceRedemptionInTx,
} from './loyalty-redemption-service.ts'
import {
	bindReferralToOrderInTx,
	onReferralOrderCancelledOrRefundedInTx,
	onReferralOrderCompletedInTx,
} from './loyalty-referral-service.ts'
import {
	isTabPaymentOpen,
	openTab,
	readQrSettings,
	resolveDineIn,
	tableRoundsInLastHour,
	type DineInCapability,
} from './qr-dine-in.ts'

/** Tenant database + transaction handle types. */
type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
export type OrderTx = Parameters<
	Parameters<TenantDatabase['transaction']>[0]
>[0]

// ---------------------------------------------------------------------------
// Failure shape shared by all order operations
// ---------------------------------------------------------------------------

export type OrderServiceFailure = {
	status: number
	code: string
	message: string
	/** Machine-readable extras for the client (e.g. the corrected discount). */
	details?: Record<string, unknown>
	/** A fresh discount quote, when the one the customer saw no longer holds. */
	quote?: unknown
	/** Why a coupon code was refused. */
	reason?: string
}

export type OrderServiceResult<T> =
	{ ok: true; data: T } | { ok: false; failure: OrderServiceFailure }

export function orderFailure(
	status: number,
	code: string,
	message: string,
	extra?: {
		details?: Record<string, unknown>
		quote?: unknown
		reason?: string
	},
): { ok: false; failure: OrderServiceFailure } {
	return {
		ok: false,
		failure: {
			status,
			code,
			message,
			...(extra?.details ? { details: extra.details } : {}),
			...(extra?.quote !== undefined ? { quote: extra.quote } : {}),
			...(extra?.reason ? { reason: extra.reason } : {}),
		},
	}
}

function fromEngineError(error: RestaurantOrderError): OrderServiceFailure {
	return {
		status: error.status,
		code: error.code,
		message: error.message,
		...(error.details ? { details: error.details } : {}),
	}
}

// ---------------------------------------------------------------------------
// Loyalty at placement
// ---------------------------------------------------------------------------

/** Fixed messages: a failure never echoes reward names or balances. */
const LOYALTY_PLACEMENT_MESSAGES: Partial<Record<LoyaltyErrorCode, string>> = {
	loyalty_unavailable:
		'Rewards are not available right now. Please try again in a moment.',
	loyalty_disabled: 'Loyalty is not available.',
	redemption_disabled: 'Redeeming rewards is not available.',
	member_not_found: 'Join the loyalty program to use rewards.',
	member_inactive: 'This loyalty membership is not active.',
	program_inactive: 'The loyalty program is not active.',
	reward_not_found: 'That reward is no longer available.',
	stale_version: 'That reward changed. Review the new offer and try again.',
	currency_mismatch: 'That reward is not valid for this menu.',
	reward_not_applicable: 'That reward does not apply to this order.',
	zero_value: 'That reward does not apply to this order.',
	insufficient_points: 'Not enough points for that reward.',
	tier_required: 'This reward is reserved for a higher loyalty tier.',
	referrals_disabled: 'Referrals are not available.',
	referral_invalid: 'That referral code was not found.',
	referral_self: 'You cannot use your own referral code.',
	referral_already_claimed: 'You have already claimed a referral.',
	referral_existing_customer: 'Referral rewards are for new customers only.',
	referral_cap_reached: 'This referral offer is no longer available.',
	cart_changed: 'Your order changed. Review the new total and try again.',
	one_reward_per_order: 'This order already has a reward.',
	already_claimed: 'Another member is collecting the points for this tab.',
}

/** An order failure for a loyalty error: mapped status, fixed message. */
export function loyaltyFailure(error: LoyaltyDomainError): OrderServiceFailure {
	return {
		status: error.status,
		code: error.code,
		message:
			LOYALTY_PLACEMENT_MESSAGES[error.code] ??
			'The reward could not be applied.',
		...(error.details ? { details: error.details } : {}),
	}
}

/**
 * Re-quotes the reward the customer picked against the priced cart and the
 * member's balance now. Throws a loyalty error when it cannot be used as
 * shown: the order is then refused, never placed without it.
 */
export async function quotePlacementReward(
	tx: LoyaltyTx,
	input: {
		member: MemberRow | null
		selection: OrderLoyaltySelection
		cart: LoyaltyCart
		currency: string
	},
): Promise<{ reward: CurrentReward; quote: LoyaltyRewardQuote }> {
	const { member, selection, cart, currency } = input
	if (!member) throw new LoyaltyDomainError('member_not_found')
	if (member.status !== 'active') {
		throw new LoyaltyDomainError('member_inactive')
	}
	const program = await readProgramInTx(tx)
	if (!program || program.current.status !== 'active') {
		throw new LoyaltyDomainError('program_inactive')
	}
	if (!sameCurrency(program.current.currency, currency)) {
		throw new LoyaltyDomainError('currency_mismatch')
	}
	const reward = await readRewardInTx(tx, selection.rewardId)
	if (!reward || reward.status !== 'active') {
		throw new LoyaltyDomainError('reward_not_found')
	}
	if (reward.snapshot.version !== selection.rewardVersion) {
		throw new LoyaltyDomainError('stale_version', {
			rewardVersion: reward.snapshot.version,
		})
	}
	if (!sameCurrency(reward.snapshot.currency, currency)) {
		throw new LoyaltyDomainError('currency_mismatch')
	}
	const balance = await readBalanceViewInTx(tx, member.id)
	const quote = quoteReward(
		reward.snapshot,
		cart,
		balance.available,
		selection.targetLineId,
		{
			memberTierId: member.tierId,
			tiersConfig: program.current.config.tiers,
		},
	)
	if (!quote.applicable) {
		throw new LoyaltyDomainError(quote.code ?? 'reward_not_applicable')
	}
	if (!quote.affordable) {
		throw new LoyaltyDomainError('insufficient_points', {
			available: balance.available,
			pointsCost: quote.pointsCost,
		})
	}
	if (quote.discountMinor !== selection.expectedDiscountMinor) {
		throw new LoyaltyDomainError('cart_changed', {
			discountMinor: quote.discountMinor,
		})
	}
	return { reward, quote }
}

function loyaltyTx(tx: OrderTx): LoyaltyTx {
	return tx as unknown as LoyaltyTx
}

// ---------------------------------------------------------------------------
// Per-org serialization
// ---------------------------------------------------------------------------

// Its own lock, separate from `lib/concurrency.ts`'s: orders, QR tabs and
// loyalty share this one. Re-entering it throws (`OrgLockReentryError`).
const orderLock = createOrgLock()

/**
 * Serializes write operations for one org inside this process. Durable Object
 * orgs are single-threaded already; on the Node/OCI runtime this keeps order
 * placement and payment events from racing each other, and SQLite busy
 * handling covers any cross-process writer.
 */
export async function runExclusive<T>(
	orgId: string,
	operation: () => Promise<T>,
): Promise<T> {
	return orderLock(orgId, operation)
}

// ---------------------------------------------------------------------------
// Secret capability tokens (receipt + payment), derived deterministically
// from AUTH_HMAC_SECRET so idempotent retries return the same capabilities.
// Only SHA-256 hashes are stored; verification re-derives the HMAC.
// ---------------------------------------------------------------------------

export function deriveReceiptToken(orgId: string, orderId: string): string {
	return hmacHash(`restaurant-receipt:${orgId}:${orderId}`)
}

export function derivePaymentToken(orgId: string, orderId: string): string {
	return hmacHash(`restaurant-payment:${orgId}:${orderId}`)
}

export function verifyReceiptToken(
	orgId: string,
	orderId: string,
	presented: string,
): boolean {
	if (!presented) return false
	return timingSafeEqualString(presented, deriveReceiptToken(orgId, orderId))
}

export function verifyPaymentToken(
	orgId: string,
	orderId: string,
	presented: string,
): boolean {
	if (!presented) return false
	return timingSafeEqualString(presented, derivePaymentToken(orgId, orderId))
}

function sha256Hex(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// App catalog context fetch (fresh, fail closed, never browser-supplied URL)
// ---------------------------------------------------------------------------

function appOrderContextUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

/**
 * Automatic and manual till rules. Null when App cannot be reached; the till
 * keeps the rules it already stored. An empty list is a real answer.
 */
export async function fetchTillDiscountRules(
	orgId: string,
): Promise<unknown[] | null> {
	const appUrl = appOrderContextUrl()
	const internalToken = getInternalCommandToken()
	if (!appUrl || internalToken.length < 16) return null
	try {
		const response = await fetch(
			`${appUrl}/resources/discount-rules?${new URLSearchParams({ orgId }).toString()}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${internalToken}`,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) return null
		const body: unknown = await response.json()
		if (!body || typeof body !== 'object' || !('discountRules' in body)) {
			return null
		}
		const rules = (body as { discountRules: unknown }).discountRules
		return Array.isArray(rules) ? rules : null
	} catch {
		return null
	}
}

export async function fetchOrderContext(
	orgId: string,
	locationId: string,
	dropSlug: string | null,
): Promise<OrderServiceResult<RestaurantOrderContext>> {
	const appUrl = appOrderContextUrl()
	const internalToken = getInternalCommandToken()
	if (!appUrl || internalToken.length < 16) {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}
	const params = new URLSearchParams({ orgId, locationId })
	if (dropSlug) params.set('drop', dropSlug)

	try {
		const response = await fetch(
			`${appUrl}/resources/order-context?${params.toString()}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${internalToken}`,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) {
			return orderFailure(
				503,
				'ordering_unavailable',
				'Ordering is temporarily unavailable. Please try again shortly.',
			)
		}
		const parsed = restaurantOrderContextSchema.safeParse(await response.json())
		if (!parsed.success) {
			return orderFailure(
				503,
				'ordering_unavailable',
				'Ordering is temporarily unavailable. Please try again shortly.',
			)
		}
		if (parsed.data.orgId !== orgId) {
			return orderFailure(
				503,
				'ordering_unavailable',
				'Ordering is temporarily unavailable. Please try again shortly.',
			)
		}
		return { ok: true, data: parsed.data }
	} catch {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}
}

// ---------------------------------------------------------------------------
// Expiry sweep: online holds stop consuming capacity the moment they lapse.
// Runs inside the same transaction as capacity counting.
// ---------------------------------------------------------------------------

async function expireHolds(
	db: OrderTx,
	now: Date,
	loyalty: LoyaltySettleQueue,
): Promise<void> {
	const expired = await db
		.update(restaurantOrders)
		.set({
			status: 'expired',
			paymentStatus: 'expired',
			updatedAt: now,
		})
		.where(
			and(
				eq(restaurantOrders.paymentMethod, 'online'),
				eq(restaurantOrders.status, 'accepted'),
				eq(restaurantOrders.paymentStatus, 'pending'),
				lt(restaurantOrders.holdExpiresAt, now),
			),
		)
		.returning({ id: restaurantOrders.id })
	// A lapsed hold gives the discount use back. Loyalty hears about every
	// hold that actually lapsed (a no-op for orders loyalty does not track).
	if (expired.length > 0) {
		await releaseDiscountRedemptions(
			db,
			expired.map((row) => row.id),
		)
		// What a gift card paid of an order that was never paid goes back.
		await restoreOrderGiftCardsInTx(
			db,
			expired.map((row) => row.id),
			now.getTime(),
			'payment hold expired',
		)
	}
	for (const row of expired) {
		await loyalty.queue(
			loyaltyTx(db),
			{ type: 'restaurant_order', id: row.id },
			now.getTime(),
		)
	}
}

/**
 * Opportunistic sweep used by read paths: expires lapsed online holds for the
 * org so receipts, quotes, and availability reflect reality.
 */
export async function sweepExpiredHolds(orgId: string, now = new Date()) {
	const db = await getTenantDb(orgId)
	const loyalty = loyaltySettleQueue()
	await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => expireHolds(tx, now, loyalty)),
		),
	)
	await loyalty.settle(orgId, { now: now.getTime() })
}

// ---------------------------------------------------------------------------
// Capacity assertions (run inside the placement transaction, after sweeping)
// ---------------------------------------------------------------------------

async function assertReadySlotCapacity(
	tx: OrderTx,
	spec: ReadySlotCapacitySpec,
): Promise<OrderServiceFailure | null> {
	if (spec.units <= 0) return null
	const slotAt = new Date(spec.readySlotAtMs)
	const [row] = await tx
		.select({ value: sum(restaurantOrders.readySlotUnits) })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.locationId, spec.locationId),
				eq(restaurantOrders.readySlotAt, slotAt),
				isNotNull(restaurantOrders.readySlotUnits),
				inArray(restaurantOrders.status, [...RESTAURANT_ORDER_ACTIVE_STATUSES]),
				sql`${restaurantOrders.dropId} IS NULL`,
			),
		)
	const used = Number(row?.value ?? 0)
	if (
		wouldExceedSlotLimit({
			used,
			incoming: spec.units,
			limit: spec.limit,
			allowOneLargeOrderPerSlot: spec.allowOneLargeOrderPerSlot,
		})
	) {
		return {
			status: 409,
			code: 'slot_full',
			message:
				'That time is fully booked. Please choose another pickup or delivery time.',
		}
	}
	return null
}

async function assertSlotCapacity(
	tx: OrderTx,
	capacity: OrderCapacitySpec,
): Promise<OrderServiceFailure | null> {
	if (capacity.maxOrdersPerSlot == null) return null
	const [row] = await tx
		.select({ value: count() })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.pickupWindowId, capacity.windowId),
				eq(restaurantOrders.pickupTime, capacity.slotTime),
				inArray(restaurantOrders.status, [...RESTAURANT_ORDER_ACTIVE_STATUSES]),
			),
		)
	const used = Number(row?.value ?? 0)
	if (used >= capacity.maxOrdersPerSlot) {
		return {
			status: 422,
			code: 'slot_full',
			message: 'That pickup time is fully booked. Please choose another time.',
		}
	}
	return null
}

async function reservedQuantity(
	tx: OrderTx,
	entity: { kind: 'item' | 'category'; entityId: string },
	scope: { dropId: string; windowId?: string; slotTime?: string },
): Promise<number> {
	const conditions = [
		eq(restaurantOrderReservations.kind, entity.kind),
		eq(restaurantOrderReservations.entityId, entity.entityId),
		// Inventory caps belong to a drop: never count other drops' usage.
		eq(restaurantOrders.dropId, scope.dropId),
		inArray(restaurantOrders.status, [...RESTAURANT_ORDER_ACTIVE_STATUSES]),
	]
	if (scope.windowId && scope.slotTime) {
		conditions.push(eq(restaurantOrderReservations.windowId, scope.windowId))
		conditions.push(eq(restaurantOrderReservations.slotTime, scope.slotTime))
	}
	const [row] = await tx
		.select({ value: sum(restaurantOrderReservations.quantity) })
		.from(restaurantOrderReservations)
		.innerJoin(
			restaurantOrders,
			eq(restaurantOrders.id, restaurantOrderReservations.orderId),
		)
		.where(and(...conditions))
	return Number(row?.value ?? 0)
}

async function assertEntityCapacity(
	tx: OrderTx,
	capacity: OrderCapacitySpec,
): Promise<OrderServiceFailure | null> {
	for (const entity of capacity.entities) {
		if (entity.inventory != null) {
			const used = await reservedQuantity(tx, entity, {
				dropId: capacity.dropId,
			})
			if (used + entity.quantity > entity.inventory) {
				return {
					status: 422,
					code: 'sold_out',
					message:
						'Some items in your order just sold out. Please review your order.',
				}
			}
		}
		if (entity.maxPerPickupSlot != null) {
			const usedInSlot = await reservedQuantity(tx, entity, {
				dropId: capacity.dropId,
				windowId: capacity.windowId,
				slotTime: capacity.slotTime,
			})
			if (usedInSlot + entity.quantity > entity.maxPerPickupSlot) {
				return {
					status: 422,
					code: 'sold_out',
					message:
						'Some items in your order are fully booked for that time. Please choose another time.',
				}
			}
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Order numbers (per-org, per-UTC-day sequence)
// ---------------------------------------------------------------------------

function dayKeyOf(now: Date): string {
	const year = now.getUTCFullYear()
	const month = String(now.getUTCMonth() + 1).padStart(2, '0')
	const day = String(now.getUTCDate()).padStart(2, '0')
	return `${year}${month}${day}`
}

async function nextOrderNumber(
	tx: OrderTx,
	now: Date,
	usedKeys: Set<string>,
	options: {
		locationId?: string | null
		timeZone?: string | null
		orderNumberFormat?: OrderNumberFormat | null
	} = {},
): Promise<string> {
	if (options.orderNumberFormat) {
		const fmt = options.orderNumberFormat
		const tz = options.timeZone || 'UTC'
		const dayStart = businessDayStartUtc(now, tz, fmt.resetTime)
		const bDate = businessDayDate(now, tz, fmt.resetTime)
		const webRows = await tx
			.select({ number: restaurantOrders.number })
			.from(restaurantOrders)
			.where(
				options.locationId
					? and(
							eq(restaurantOrders.locationId, options.locationId),
							gte(restaurantOrders.createdAt, dayStart),
						)
					: gte(restaurantOrders.createdAt, dayStart),
			)
		const posRows = options.locationId
			? await tx
					.select({ number: posOrders.number })
					.from(posOrders)
					.where(
						and(
							eq(posOrders.locationId, options.locationId),
							eq(posOrders.businessDate, bDate),
						),
					)
			: []
		const taken = new Set([
			...webRows.map((r) => r.number),
			...posRows.map((r) => r.number),
		])
		const escapedPrefix = fmt.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		const seqPattern = new RegExp(`^${escapedPrefix}(\\d+)$`)
		let highest = 0
		for (const num of taken) {
			const match = seqPattern.exec(num)
			if (match) highest = Math.max(highest, Number(match[1]))
		}
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const candidate = formatAllocatedOrderNumber(highest + 1 + attempt, fmt)
			if (!usedKeys.has(candidate) && !taken.has(candidate)) {
				usedKeys.add(candidate)
				return candidate
			}
		}
		const candidate = `${fmt.prefix}${crypto.randomUUID().slice(0, 8)}`
		usedKeys.add(candidate)
		return candidate
	}
	const dayStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	)
	const [row] = await tx
		.select({ value: count() })
		.from(restaurantOrders)
		.where(gte(restaurantOrders.createdAt, dayStart))
	const base = Number(row?.value ?? 0)
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const candidate = `${dayKeyOf(now)}-${String(base + 1 + attempt).padStart(4, '0')}`
		if (!usedKeys.has(candidate)) {
			usedKeys.add(candidate)
			return candidate
		}
	}
	const candidate = `${dayKeyOf(now)}-${crypto.randomUUID().slice(0, 8)}`
	usedKeys.add(candidate)
	return candidate
}

export const allocateNextOrderNumber = nextOrderNumber

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes('UNIQUE constraint failed')
	)
}

// ---------------------------------------------------------------------------
// Manual acceptance (#107)
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const MAX_ACCEPTANCE_TIMEOUT_MS =
	Math.max(...ORDER_ACCEPTANCE_TIMEOUT_CHOICES) * MINUTE_MS

/**
 * Whether a new order waits for a person to accept it, and until when. The
 * location's policy comes from the order context (`acceptance`, only present
 * while `ordering.manual_acceptance` is on; anything else reads as Automatic,
 * so `deadline` is null and the order is placed exactly as before). A
 * scheduled order (a chosen time, or a drop's pickup slot) is decided by 30
 * minutes before the kitchen should start it (`acceptanceDeadline`).
 */
export function placementAcceptance(input: {
	context: RestaurantOrderContext
	locationId: string
	totalCents: number
	fulfillment: string
	source: string | null
	tabId: string | null
	scheduledFor: string | null
	pickup: { date: string; time: string; timezone: string } | null
	prepMinutes: number | null
	now: Date
}): { deadline: Date | null } {
	const policy = readOrderAcceptancePolicy(
		(input.context as { acceptance?: unknown }).acceptance,
		input.locationId,
	)
	let scheduledAt: Date | null = null
	if (input.scheduledFor) {
		scheduledAt = new Date(input.scheduledFor)
	} else if (input.pickup) {
		try {
			scheduledAt = localDateAndTimeToUtc(
				input.pickup.date,
				input.pickup.time,
				input.pickup.timezone,
			)
		} catch {
			scheduledAt = null
		}
	}
	if (scheduledAt && !Number.isFinite(scheduledAt.getTime())) scheduledAt = null
	const waits = orderNeedsAcceptance(policy, {
		totalCents: input.totalCents,
		scheduled: scheduledAt !== null,
		fulfillment: input.fulfillment,
		source: input.source,
		tabId: input.tabId,
	})
	if (!waits) return { deadline: null }
	const prep = (input.prepMinutes || DEFAULT_PREP_MINUTES) * MINUTE_MS
	return {
		deadline: acceptanceDeadline(policy, {
			now: input.now,
			scheduledFireAt: scheduledAt
				? new Date(scheduledAt.getTime() - prep)
				: null,
		}),
	}
}

/**
 * The deadline of an online order that starts waiting at its paid event. At
 * placement it got `max(placed + timeout, fire - 30 min)`; the restaurant's
 * minutes start when the order is paid, so it becomes `max(that, paid +
 * timeout)`. The timeout is what placement added (at most the longest
 * choice): exact for an as-soon-as-possible order, and never shorter than the
 * configured minutes for a scheduled one.
 */
function paidAcceptanceDeadline(order: RestaurantOrder, paidAt: Date): Date {
	const placedDeadline = order.acceptanceDeadlineAt!.getTime()
	const placedAt = order.createdAt?.getTime() ?? paidAt.getTime()
	const timeout = Math.min(
		Math.max(0, placedDeadline - placedAt),
		MAX_ACCEPTANCE_TIMEOUT_MS,
	)
	return new Date(Math.max(placedDeadline, paidAt.getTime() + timeout))
}

/**
 * An online order placed while its location wanted manual acceptance and
 * not decided yet: its paid event makes it wait (`pending_acceptance`).
 */
function waitsForAcceptanceWhenPaid(order: RestaurantOrder): boolean {
	return order.acceptanceDeadlineAt !== null && order.acceptedAt === null
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export type PlaceOrderSuccess = {
	status: 200 | 201
	order: RestaurantOrder
	receiptToken: string
	paymentToken: string | null
	/** Dine-in rounds only: the tab the round joined or opened. */
	tab: { id: string; tabNumber: string; tabToken: string } | null
	/**
	 * What became of the marketing boxes a signed-in customer ticked, per
	 * ticked channel. Absent for a guest, when nothing was ticked, and on an
	 * idempotent replay (nothing is recorded again).
	 */
	marketingConsent?: OrderMarketingConsentResult
}

export type PlaceOrderResult =
	| { ok: true; data: PlaceOrderSuccess }
	| { ok: false; failure: OrderServiceFailure }

export function isNativeAppClientHeader(
	value: string | null | undefined,
): boolean {
	const raw = value?.trim().toLowerCase()
	return raw === 'ios' || raw === 'android'
}

export function derivePublicOrderChannel(input: {
	fulfillment: 'pickup' | 'delivery' | 'dine_in'
	source?: string | null
	qrOrdering?: unknown
	client?: string | null
}): MenuChannel {
	const qrFeatures = readQrOrderingFeatures(input.qrOrdering)
	if (input.fulfillment === 'dine_in') {
		return 'qr'
	}
	if (input.source === 'qr_poster' && qrFeatures.enabled) {
		return 'qr'
	}
	if (isNativeAppClientHeader(input.client)) {
		return 'app'
	}
	return 'web'
}

export async function placeOrder(input: {
	organization: PublishedOrganization
	request: RestaurantOrderRequest
	customerId: string | null
	/** Dine-in only: the `X-Table-Token` / `X-Tab-Token` the browser sent. */
	dineIn?: DineInCapability | null
	/** Trusted client platform header (`X-Client: ios | android`). */
	client?: string | null
	now?: Date
}): Promise<PlaceOrderResult> {
	const { organization, request, customerId } = input
	const now = input.now ?? new Date()
	const orgId = organization.id
	const isDineIn = request.fulfillment === 'dine_in'
	const dineIn = input.dineIn ?? null
	const hasDineInToken = Boolean(dineIn?.tableToken || dineIn?.tabToken)
	if (isDineIn !== hasDineInToken) {
		return orderFailure(
			400,
			'invalid_request',
			isDineIn
				? 'Scan the table code to order at the table.'
				: 'Table codes are only valid for table orders.',
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

	// The App folds the org's QR flags into the context; anything missing or
	// malformed reads as off, so a dine-in round fails closed.
	const qrFeatures = readQrOrderingFeatures(
		(context as { qrOrdering?: unknown }).qrOrdering,
	)
	if (isDineIn && !qrFeatures.dineIn) {
		return orderFailure(
			404,
			'dine_in_unavailable',
			'Ordering at the table is not available.',
		)
	}
	const orderSource: RestaurantOrder['source'] = isDineIn
		? 'qr_table'
		: request.source === 'qr_poster' && qrFeatures.enabled
			? 'qr_poster'
			: null

	if (
		request.paymentMethod === 'online' &&
		(!context.onlinePayment.enabled || !context.onlinePayment.processor)
	) {
		return orderFailure(
			400,
			'online_payment_disabled',
			'Online payment is not available for this menu. Choose pay at handoff.',
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
		return { ok: false, failure: fromEngineError(priced.error) }
	}
	const result: PricedRestaurantOrder = priced.result

	const requestHash = sha256Hex(canonicalOrderRequest(request))
	const db = await getTenantDb(orgId)

	const replayOrConflict = async (
		existing: RestaurantOrder,
		reader: Pick<TenantDatabase, 'select'> | OrderTx = db,
	): Promise<PlaceOrderResult> => {
		if (existing.requestHash !== requestHash) {
			return orderFailure(
				409,
				'idempotency_conflict',
				'This checkout was already completed with different details.',
			)
		}
		let tab: PlaceOrderSuccess['tab'] = null
		if (existing.tabId) {
			const [row] = await reader
				.select()
				.from(qrTabs)
				.where(eq(qrTabs.id, existing.tabId))
				.limit(1)
			if (row) {
				tab = {
					id: row.id,
					tabNumber: row.tabNumber,
					tabToken: deriveTabToken(orgId, row.id, row.tabTokenVersion),
				}
			}
		}
		return {
			ok: true,
			data: {
				status: 200,
				order: existing,
				receiptToken: deriveReceiptToken(orgId, existing.id),
				paymentToken:
					existing.paymentMethod === 'online'
						? derivePaymentToken(orgId, existing.id)
						: null,
				tab,
			},
		}
	}

	// The replay answer comes before every pre-check that can change after
	// the first attempt: a retried checkout must see the order it placed,
	// not a refusal (a member suspended in between, a price that moved).
	const [existing] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.idempotencyKey, request.idempotencyKey))
		.limit(1)
	if (existing) return replayOrConflict(existing)

	// Loyalty pre-checks, before the org lock: a reward on a tab round, a
	// guest, or an organization without loyalty never reaches the transaction.
	const loyaltyFlags =
		customerId || request.loyalty ? await getLoyaltyFlagState(orgId) : null
	if (request.loyalty) {
		if (isDineIn) {
			return orderFailure(
				422,
				'loyalty_on_tab',
				'Rewards are chosen when the tab is paid, not per round.',
			)
		}
		if (!customerId || !loyaltyFlags) {
			return orderFailure(401, 'unauthorized', 'Sign in to use rewards.')
		}
		const refusal = rewardRefusal(loyaltyFlags)
		if (refusal) {
			return {
				ok: false,
				failure: loyaltyFailure(new LoyaltyDomainError(refusal)),
			}
		}
	}

	// Gift card pre-checks, before the org lock: a card on a tab round, with
	// the node switched off or with the organization's gift cards off never
	// reaches the transaction. A card that cannot be applied is refused here,
	// never silently dropped: the guest was shown a smaller total.
	if (request.giftCard) {
		if (isDineIn) {
			return orderFailure(
				422,
				'gift_card_on_tab',
				'A gift card is used when the tab is paid, not per round.',
			)
		}
		if (isGiftCardsKillSwitchOn()) {
			return orderFailure(
				503,
				'gift_cards_unavailable',
				'Gift cards are temporarily unavailable. Please try again shortly.',
			)
		}
		const giftFlags = await getGiftCardFlagState(orgId)
		if (giftFlags.status === 'unknown') {
			return orderFailure(
				503,
				'gift_cards_unavailable',
				'Gift cards are temporarily unavailable. Please try again shortly.',
			)
		}
		if (!giftFlags.features.enabled || !giftFlags.features.online) {
			return orderFailure(
				403,
				'gift_cards_disabled',
				'Gift cards are not available here.',
			)
		}
	}

	// Signed-in pickup and delivery orders earn; a tab round never does (the
	// tab is the purchase), but a signed-in member's round claims the tab's
	// points when nobody has yet. The cart a reward is quoted on is hashed
	// here, outside the lock, because hashing is async.
	const loyaltyCredits = Boolean(
		customerId && loyaltyFlags && loyaltyCreditsSales(loyaltyFlags),
	)
	const loyaltyEarning = loyaltyCredits && !isDineIn
	const loyaltyTabClaim = loyaltyCredits && isDineIn

	const orderId = crypto.randomUUID()
	const receiptToken = deriveReceiptToken(orgId, orderId)
	const paymentToken =
		request.paymentMethod === 'online'
			? derivePaymentToken(orgId, orderId)
			: null

	// Fail fast on a bad table code before taking the org lock; the same
	// checks run again inside the transaction against fresh rows.
	if (isDineIn) {
		const precheck = await resolveDineIn(db, orgId, dineIn!, request.locationId)
		if (!precheck.ok) return { ok: false, failure: precheck.failure }
	}

	// Guest order messages: the policy is stored with the order (fail closed),
	// and update texts only with a phone, off table rounds, on the US node.
	const guestMessages = readGuestMessagesPolicy(context.guestMessages)
	const orderGuestMessages =
		guestMessages.enabled && !isDineIn
			? {
					receipt: guestMessages.receipt,
					ready: guestMessages.ready,
					cancelled: guestMessages.cancelled,
				}
			: null
	const smsUpdatesOptIn =
		request.smsUpdates === true &&
		orderGuestMessages !== null &&
		Boolean(request.contact.phone) &&
		context.dataRegion === 'us'

	// The promised ready (pickup) or arrival (delivery) time (#109): the same
	// estimate the ordering page shows, plus large-order prep. None for table
	// rounds and drops. Not personal data.
	const promiseLocation = context.menu.locations.find(
		(location) => location.id === request.locationId,
	)
	const limitCatalog = buildOrderLimitCatalog(context)
	const { catalog, categoryExempt } = limitCatalog
	const largeRule = readLargeOrderRule(
		(context as { largeOrder?: unknown }).largeOrder,
		request.locationId,
	)
	const limitItemCount = orderDishUnits(
		result.lines.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			categoryIds: line.categoryIds,
		})),
		orderLimitExemptFromCatalog(catalog, categoryExempt),
	)
	const largeOrderExtra = largeOrderExtraMinutes(largeRule, {
		subtotalCents: result.subtotalCents,
		itemCount: limitItemCount,
	})
	const promised = promiseLocation
		? computePromisedTime({
				now,
				fulfillment: request.fulfillment,
				scheduledFor: result.scheduledFor,
				drop: Boolean(result.drop),
				location: promiseLocation,
				largeOrder: largeRule,
				subtotalCents: result.subtotalCents,
				itemCount: limitItemCount,
			})
		: { promisedAt: null, promisedUntil: null }
	const utensilsContext = (
		context as {
			utensils?: Record<string, { enabled: boolean; defaultRequested: boolean }>
		}
	).utensils
	const utensilsSettings = parseUtensilsSettings(
		utensilsContext?.[request.locationId],
	)
	const utensilsRequested = foldUtensilsRequested(
		utensilsSettings,
		request.fulfillment,
		request.utensilsRequested,
	)
	const pickupRaw = (context as { pickupInstructions?: Record<string, string> })
		.pickupInstructions?.[request.locationId]
	// A drop order has its own pickup location and windows: those win over the
	// location's instructions, so none is stored for it.
	const pickupInstructionsCopy =
		request.fulfillment === 'pickup' && !context.drop && pickupRaw
			? resolvePickupInstructions(
					pickupRaw,
					request.locale,
					context.menu.organization.defaultLocale ?? 'en',
				)
			: null

	const loyalty = loyaltySettleQueue()
	const inventory = inventorySaleQueue()
	const messages = orderMessageBatch()
	// Set only by the attempt that inserted the order (a busy retry resets it).
	let consentConfirmation: OrderConsentConfirmation | null = null
	// The weekly budgets (#392) this order's discount use spent; the owner is told
	// once it has committed. Reset by a busy retry like the consent above.
	let budgetCrossings: DiscountBudgetCrossing[] = []
	try {
		const placed: PlaceOrderResult = await runExclusive(orgId, () =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					consentConfirmation = null
					budgetCrossings = []
					const [existingInTx] = await tx
						.select()
						.from(restaurantOrders)
						.where(eq(restaurantOrders.idempotencyKey, request.idempotencyKey))
						.limit(1)
					if (existingInTx) return replayOrConflict(existingInTx, tx)

					await expireHolds(tx, now, loyalty)

					let tabRow: typeof qrTabs.$inferSelect | null = null
					let tableRow: { id: string; label: string } | null = null
					if (isDineIn) {
						const resolved = await resolveDineIn(
							tx,
							orgId,
							dineIn!,
							request.locationId,
						)
						if (!resolved.ok) return { ok: false, failure: resolved.failure }
						const settings = await readQrSettings(tx)
						const existingTab = resolved.data.tab
						if (
							settings.requireGuestName &&
							!request.contact.name &&
							!existingTab?.guestName
						) {
							return orderFailure(
								422,
								'contact_name_required',
								'Enter your name to order at the table.',
							)
						}
						if (
							settings.requireGuestPhone &&
							!request.contact.phone &&
							!existingTab?.guestPhone
						) {
							return orderFailure(
								422,
								'contact_phone_required',
								'Enter your phone number to order at the table.',
							)
						}
						const recent = await tableRoundsInLastHour(
							tx,
							resolved.data.table.id,
							now,
						)
						if (recent >= settings.perTableLimitPerHour) {
							return orderFailure(
								429,
								'table_rate_limited',
								'This table has sent many orders. Please ask a team member for help.',
							)
						}
						tableRow = resolved.data.table
						if (existingTab && isTabPaymentOpen(existingTab, now)) {
							// A payment was started: the total is frozen until it ends, so
							// a round can never ride along on an older, smaller amount.
							return orderFailure(
								409,
								'tab_paying',
								'This tab is being paid. Order again after payment, or ask a team member.',
							)
						}
						let openTabRow = existingTab
						if (
							existingTab &&
							existingTab.paymentAmountCents != null &&
							(existingTab.paymentStatus === 'unpaid' ||
								existingTab.paymentStatus === 'pending')
						) {
							// A payment started long ago and never finished: forget it,
							// binding and reward included, so the table can keep ordering
							// and pay again. Money that still arrives for it is kept for
							// review, and so is the reward while its page can still be
							// paid.
							await setAsideSourceRedemptionInTx(
								loyaltyTx(tx),
								{ type: 'qr_tab', id: existingTab.id },
								{
									reason: 'tab_changed',
									at: now.getTime(),
									payableUntil:
										existingTab.loyaltyDiscountCents > 0
											? qrTabPayableUntil(existingTab)
											: null,
								},
							)
							// An abandoned phone payment reserved a code. A new
							// round ends that payment, so the reservation goes too.
							await releaseTabDiscounts(tx, existingTab.id)
							const [cleared] = await tx
								.update(qrTabs)
								.set({
									paymentStatus: 'unpaid',
									paymentSessionId: null,
									paymentProcessor: null,
									paymentAmountCents: null,
									paymentTipCents: null,
									paymentServiceFeeCents: null,
									paymentServiceFeeTaxCents: null,
									paymentServiceFeeLabel: null,
									paymentTokenHash: null,
									loyaltyDiscountCents: 0,
									updatedAt: now.getTime(),
								})
								.where(eq(qrTabs.id, existingTab.id))
								.returning()
							openTabRow = cleared ?? existingTab
						}
						if (openTabRow) {
							const existingTab = openTabRow
							tabRow = existingTab
							const fill: Partial<typeof qrTabs.$inferInsert> = {}
							if (!existingTab.guestName && request.contact.name) {
								fill.guestName = request.contact.name
							}
							if (!existingTab.guestPhone && request.contact.phone) {
								fill.guestPhone = request.contact.phone
							}
							if (Object.keys(fill).length > 0) {
								const [updated] = await tx
									.update(qrTabs)
									.set({ ...fill, updatedAt: now.getTime() })
									.where(eq(qrTabs.id, existingTab.id))
									.returning()
								tabRow = updated ?? existingTab
							}
						} else {
							tabRow = await openTab(tx, {
								table: resolved.data.table,
								currency: result.currency,
								guestName: request.contact.name ?? null,
								guestPhone: request.contact.phone ?? null,
								now,
							})
							if (!tabRow) {
								return orderFailure(
									409,
									'tab_conflict',
									'Another order at this table just opened the tab. Please try again.',
								)
							}
						}
					}

					if (result.capacity) {
						const slotFailure = await assertSlotCapacity(tx, result.capacity)
						if (slotFailure) return { ok: false, failure: slotFailure }
						const entityFailure = await assertEntityCapacity(
							tx,
							result.capacity,
						)
						if (entityFailure) return { ok: false, failure: entityFailure }
					}
					if (result.readySlotCapacity) {
						const readyFailure = await assertReadySlotCapacity(
							tx,
							result.readySlotCapacity,
						)
						if (readyFailure) return { ok: false, failure: readyFailure }
					}
					// Daily dish caps (#409): sold plus held stock may not pass the cap.
					const dailyCapacity = await assertDailyDishCapacity({
						db: tx,
						context,
						locationId: request.locationId,
						lines: result.lines,
						now,
					})
					if (!dailyCapacity.ok) {
						const { status, code, message, details } = dailyCapacity.failure
						return orderFailure(status, code, message, { details })
					}

					const preparedResult = await prepareOrderDiscounts(tx, {
						priced: result,
						context,
						discounts: request.discounts,
						fulfillment: request.fulfillment,
						source: orderSource,
						customerId,
						now,
						killed: isDiscountsKillSwitchOn(),
						orgId,
						phone: request.contact.phone,
						deviceId: request.referralDeviceId ?? null,
					})
					if (!preparedResult.ok) {
						return orderFailure(
							preparedResult.failure.status,
							preparedResult.failure.code,
							preparedResult.failure.message,
							{
								quote: preparedResult.failure.quote,
								reason: preparedResult.failure.reason,
							},
						)
					}
					const prepared = preparedResult.prepared
					// The kill switch prices nothing. A guest who was shown a
					// discount must not be charged full price with a 201.
					if (
						!prepared &&
						isDiscountsKillSwitchOn() &&
						(request.discounts?.expectedDiscountMinor ?? 0) > 0
					) {
						return orderFailure(
							409,
							'discount_changed',
							'Your discount changed. Review the new total and place the order again.',
						)
					}
					const lineDiscounts = prepared?.evaluation.lineDiscounts ?? {}
					const loyaltyCart = request.loyalty
						? loyaltyCartForPricedOrder(result, lineDiscounts)
						: null
					const loyaltyCartHash = loyaltyCart
						? await hashLoyaltyCart(loyaltyCart)
						: null

					const at = now.getTime()
					const member =
						(loyaltyEarning || loyaltyTabClaim) && customerId
							? loyaltyFlags?.status === 'on'
								? // A verified customer who signed in before the program went
									// live has no account yet: open it here so this order earns.
									await ensureMemberForCustomerInTx(
										loyaltyTx(tx),
										customerId,
										at,
									)
								: await memberForCustomerInTx(loyaltyTx(tx), customerId)
							: null
					const selected =
						request.loyalty && loyaltyCart
							? await quotePlacementReward(loyaltyTx(tx), {
									member,
									selection: request.loyalty,
									cart: loyaltyCart,
									currency: result.currency,
								})
							: null
					const discounted = totalsAfterDiscounts(result, prepared)
					const totals: LoyaltyDiscountedTotals = selected
						? applyLoyaltyDiscountToTotals(
								result,
								selected.quote.lines,
								selected.quote.discountMinor,
								{
									lineDiscounts,
									deliveryDiscountMinor:
										prepared?.evaluation.deliveryDiscountMinor,
									packagingWaived:
										prepared?.evaluation.packagingWaived === true,
								},
							)
						: {
								loyaltyDiscountCents: 0,
								taxCents: discounted.taxCents,
								totalCents: discounted.totalCents,
								serviceFeeCents: discounted.serviceFeeCents,
								serviceFeeTaxCents: discounted.serviceFeeTaxCents,
								packagingFeeCents: discounted.packagingFeeCents,
								packagingFeeTaxCents: discounted.packagingFeeTaxCents,
							}
					if (prepared && request.discounts) {
						const quote = buildDiscountQuote({
							priced: result,
							prepared,
							loyaltyDiscountMinor: totals.loyaltyDiscountCents,
							taxMinor: totals.taxCents,
							totalMinor: totals.totalCents,
							serviceFeeMinor: totals.serviceFeeCents,
							packagingFeeMinor: totals.packagingFeeCents,
						})
						const decision = interpretPlacement(
							request.discounts,
							prepared,
							quote,
						)
						if (!decision.ok) {
							return orderFailure(
								decision.failure.status,
								decision.failure.code,
								decision.failure.message,
								{
									quote: decision.failure.quote,
									reason: decision.failure.reason,
								},
							)
						}
					}
					// The service fee (#123): the region prices it; the browser sends
					// what it showed. A table round has none (its tab pays it), and an
					// older client that sends nothing reads as 0, so it is refused
					// exactly where a fee is due.
					if (
						!isDineIn &&
						(request.expectedServiceFeeMinor ?? 0) !== totals.serviceFeeCents
					) {
						return orderFailure(
							409,
							'service_fee_changed',
							'The service fee changed. Review the new total and place the order again.',
							{ details: { serviceFeeMinor: totals.serviceFeeCents } },
						)
					}
					if (
						!isDineIn &&
						(request.expectedPackagingFeeMinor ?? 0) !==
							totals.packagingFeeCents
					) {
						return orderFailure(
							409,
							'packaging_fee_changed',
							'The packaging fee changed. Review the new total and place the order again.',
							{
								details: {
									packagingFeeMinor: totals.packagingFeeCents,
								},
							},
						)
					}
					// The gift card (#110) pays after discounts and loyalty: at most its
					// balance, at most what is left. The order keeps its whole total;
					// the provider is charged `total - gift card`, and what is due decides
					// whether anything is left to collect.
					let gift: OrderGiftCard | null = null
					if (request.giftCard) {
						gift = await prepareGiftCardForOrder(tx, {
							giftCard: request.giftCard,
							customerId,
							totalMinor: totals.totalCents,
							currency: result.currency,
							now: now.getTime(),
							enforceExpected: true,
						})
					}
					const dueCents = totals.totalCents - (gift?.appliedMinor ?? 0)
					const freeOrder = request.paymentMethod === 'online' && dueCents <= 0
					// A free pickup or delivery order paid at handoff has nothing to
					// collect either: store it as not_required (like a free online
					// order) so no "mark paid" step is asked of staff. A table round is
					// never free this way: its tab is settled once, at close.
					const freeHandoff =
						request.paymentMethod === 'handoff' && dueCents <= 0 && !tabRow
					// Manual acceptance (#107): an order that stands now (pay at
					// handoff, free) waits as `pending_acceptance`; an online order
					// that still has to be paid is placed as today and waits from
					// its paid event (the deadline set here marks it).
					const acceptance = placementAcceptance({
						context,
						locationId: request.locationId,
						totalCents: totals.totalCents,
						fulfillment: request.fulfillment,
						source: orderSource,
						tabId: tabRow?.id ?? null,
						scheduledFor: result.scheduledFor,
						pickup: result.pickup,
						prepMinutes: promiseLocation?.prepTime ?? null,
						now,
					})
					const waitsNow =
						acceptance.deadline !== null &&
						(request.paymentMethod !== 'online' || freeOrder)

					const numberFormat = promiseLocation?.orderNumberFormat
						? parseOrderNumberFormat(promiseLocation.orderNumberFormat)
						: null
					const usedNumbers = new Set<string>()
					let inserted: RestaurantOrder | null = null
					for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
						const number = await nextOrderNumber(tx, now, usedNumbers, {
							locationId: request.locationId,
							timeZone: promiseLocation?.timezone ?? null,
							orderNumberFormat: numberFormat,
						})
						const holdExpiresAt =
							request.paymentMethod === 'online' && !freeOrder
								? new Date(now.getTime() + result.holdMinutes * 60 * 1000)
								: null
						try {
							const [row] = await tx
								.insert(restaurantOrders)
								.values({
									id: orderId,
									orgId,
									customerId,
									number,
									locale: request.locale,
									status: waitsNow ? 'pending_acceptance' : 'accepted',
									acceptanceDeadlineAt: acceptance.deadline,
									paymentMethod: request.paymentMethod,
									paymentStatus:
										freeOrder || freeHandoff
											? 'not_required'
											: request.paymentMethod === 'online'
												? 'pending'
												: 'unpaid',
									paymentProcessor:
										request.paymentMethod === 'online'
											? (context.onlinePayment.processor ?? null)
											: null,
									fulfillment: request.fulfillment,
									locationId: request.locationId,
									locationName: result.location.name,
									dropId: result.drop?.id ?? null,
									dropSlug: result.drop?.slug ?? null,
									pickupWindowId: result.pickup?.windowId ?? null,
									pickupDate: result.pickup?.date ?? null,
									pickupTime: result.pickup?.time ?? null,
									pickupTimezone: result.pickup?.timezone ?? null,
									// Only what this placer typed: another guest's name or phone on
									// the tab must never reach this round's receipt.
									contactName: request.contact.name ?? '',
									contactPhone: request.contact.phone ?? '',
									contactEmail: request.contact.email ?? null,
									tabId: tabRow?.id ?? null,
									tableId: tableRow?.id ?? null,
									tableLabel: tableRow?.label ?? null,
									source: orderSource,
									deliveryAddress: result.delivery?.address ?? null,
									deliveryCity: result.delivery?.city ?? null,
									deliveryUnit: result.delivery?.unit ?? null,
									deliveryNotes: result.delivery?.notes ?? null,
									deliveryZoneId: result.delivery?.zoneId ?? null,
									deliveryPostalCode: result.delivery?.postalCode ?? null,
									deliveryLat: result.delivery?.lat ?? null,
									deliveryLng: result.delivery?.lng ?? null,
									scheduledFor: result.scheduledFor
										? new Date(result.scheduledFor)
										: null,
									readySlotAt: result.readySlotCapacity
										? new Date(result.readySlotCapacity.readySlotAtMs)
										: null,
									readySlotUnits: result.readySlotCapacity?.units ?? null,
									promisedAt: promised.promisedAt,
									promisedUntil: promised.promisedUntil,
									locationTimezone: promiseLocation?.timezone || null,
									smsUpdatesOptIn,
									guestMessages: orderGuestMessages,
									currency: result.currency,
									subtotalCents: result.subtotalCents,
									taxCents: totals.taxCents,
									deliveryFeeCents: result.deliveryFeeCents,
									tipCents: result.tipCents,
									tipPercent: result.tipPercent,
									serviceFeeCents: totals.serviceFeeCents,
									serviceFeeTaxCents: totals.serviceFeeTaxCents,
									serviceFeeLabel:
										totals.serviceFeeCents > 0
											? (result.serviceFeeLabel ?? null)
											: null,
									packagingFeeCents: totals.packagingFeeCents,
									packagingFeeTaxCents: totals.packagingFeeTaxCents,
									packagingFeeLabel:
										totals.packagingFeeCents > 0
											? (result.packagingFeeLabel ?? null)
											: null,
									pickupInstructions: pickupInstructionsCopy,
									utensilsRequested,
									largeOrderExtraMinutes: largeOrderExtra,
									totalCents: totals.totalCents,
									giftCardCents: gift?.appliedMinor ?? 0,
									loyaltyDiscountCents: totals.loyaltyDiscountCents,
									discountCents: discounted.discountCents,
									deliveryDiscountCents: discounted.deliveryDiscountCents,
									discounts: orderDiscountSnapshots(prepared),
									lines: result.lines,
									idempotencyKey: request.idempotencyKey,
									requestHash,
									receiptTokenHash: sha256Hex(receiptToken),
									paymentTokenHash: paymentToken
										? sha256Hex(paymentToken)
										: null,
									holdExpiresAt,
									createdAt: now,
									updatedAt: now,
								})
								.returning()
							inserted = row ?? null
						} catch (error) {
							if (isUniqueConstraintError(error) && attempt < 4) continue
							throw error
						}
					}
					if (!inserted) {
						return orderFailure(
							500,
							'order_number_conflict',
							'We could not place this order. Please try again.',
						)
					}

					await recordDailyDishClaims({ tx, context, order: inserted, now })

					if (result.capacity && result.capacity.entities.length > 0) {
						await insertRowsInChunks(
							restaurantOrderReservations,
							result.capacity.entities.map((entity) => ({
								orderId: inserted!.id,
								kind: entity.kind,
								entityId: entity.entityId,
								windowId: result.capacity!.windowId,
								slotTime: result.capacity!.slotTime,
								quantity: entity.quantity,
							})),
							(chunk) => tx.insert(restaurantOrderReservations).values(chunk),
						)
					}

					const source = { type: 'restaurant_order' as const, id: inserted.id }
					// Stock leaves with a sale that counts at once (pay at pickup, a
					// free order); an online order waits for its payment event.
					if (orderCountsTowardSales(inserted)) {
						await inventory.queue(
							tx,
							{ ...source, locationId: inserted.locationId },
							at,
						)
					}
					// The receipt, for an order that stands at once (pay at
					// handoff, free); an online order waits for its payment.
					await queueOrderPlacedMessages(tx, inserted, messages.context(at))
					if (prepared) {
						budgetCrossings = await reserveOrderDiscounts(tx, {
							orderId: inserted.id,
							customerId,
							prepared,
						})
						// A free order is already accepted: the use is spent. A
						// pay-at-pickup order stays reserved until it is completed,
						// and that reservation still counts toward the limit. One
						// waiting for acceptance spends it when accepted.
						if (freeOrder && !waitsNow) {
							await consumeDiscountRedemptions(tx, [inserted.id])
						}
					}
					if (gift) {
						// Takes the card's part in this same transaction, so a refused or
						// failed placement leaves the card untouched.
						await redeemOrderGiftCardInTx(tx, {
							gift,
							orderId: inserted.id,
							locationId: request.locationId,
							now: at,
						})
					}
					if (selected && member && loyaltyCart && loyaltyCartHash) {
						// Holds the points and binds the reward to this order. It throws
						// (rolling the order back) when the member can no longer spend.
						const redemption = await reserveRedemptionInTx(loyaltyTx(tx), {
							member,
							reward: selected.reward.snapshot,
							cart: loyaltyCart,
							cartHash: loyaltyCartHash,
							targetLineId: request.loyalty?.targetLineId ?? null,
							expectedDiscountMinor: selected.quote.discountMinor,
							channel: 'web',
							source,
							locationId: request.locationId,
							at,
						})
						if (redemption.discountMinor !== totals.loyaltyDiscountCents) {
							throw new LoyaltyDomainError('cart_changed', {
								discountMinor: redemption.discountMinor,
							})
						}
					}
					if (member?.status === 'active' && !isDineIn) {
						await claimPurchaseInTx(loyaltyTx(tx), {
							member,
							source,
							locationId: request.locationId,
							currency: result.currency,
							at,
						})
					} else if (member?.status === 'active' && tabRow) {
						await claimPurchaseIfUnclaimedInTx(loyaltyTx(tx), {
							member,
							source: { type: 'qr_tab', id: tabRow.id },
							locationId: tabRow.locationId,
							currency: tabRow.currency,
							at,
						})
					}
					if (!isDineIn) {
						const referralDiscountApplied =
							prepared?.evaluation.applied.filter(
								(a) => a.discountId === LOYALTY_REFERRAL_DISCOUNT_ID,
							) ?? []
						await bindReferralToOrderInTx(loyaltyTx(tx), {
							orgId,
							orderId: inserted.id,
							customerId,
							memberId: member?.id ?? null,
							phone: request.contact.phone,
							deviceId: request.referralDeviceId ?? null,
							typedCode: request.discounts?.code ?? null,
							appliedDiscountMinor: referralDiscountApplied.reduce(
								(sum, a) => sum + a.amountMinor,
								0,
							),
							appliedReferralDiscount: referralDiscountApplied.length > 0,
							now: at,
						})
					}

					// Last, so every refusal above returns (and commits) before it:
					// only a placed order records the consent ticked with it. A
					// replay returned earlier and records nothing again.
					const consent =
						customerId && request.marketingConsent
							? await recordOrderMarketingConsentInTx(tx, {
									customerId,
									consent: request.marketingConsent,
									now,
									contactEmail: request.contact.email ?? null,
								})
							: null
					consentConfirmation = consent?.confirmation ?? null

					return {
						ok: true,
						data: {
							status: 201,
							order: inserted,
							receiptToken,
							paymentToken,
							...(consent ? { marketingConsent: consent.result } : {}),
							tab: tabRow
								? {
										id: tabRow.id,
										tabNumber: tabRow.tabNumber,
										tabToken: deriveTabToken(
											orgId,
											tabRow.id,
											tabRow.tabTokenVersion,
										),
									}
								: null,
						},
					}
				}),
			),
		)
		await loyalty.settle(orgId)
		await inventory.settle(orgId)
		messages.deliver(orgId)
		// A pay-at-pickup order counts at once; an online one counts when its
		// payment lands (below). Background: the guest never waits for it.
		scheduleOrderJourneys(orgId)
		// Any order clears the guest's left-behind cart (#150).
		if (customerId) {
			await getTenantDb(orgId)
				.then((tenantDb) => clearCartSnapshot(tenantDb, customerId))
				.catch(() => undefined)
		}
		const confirmation = consentConfirmation as OrderConsentConfirmation | null
		if (placed.ok && placed.data.status === 201 && confirmation) {
			queueOrderConsentConfirmation(orgId, confirmation)
		}
		if (placed.ok && placed.data.status === 201) {
			notifyDiscountBudgets(orgId, budgetCrossings)
		}
		return placed
	} catch (error) {
		// `runTenantTransaction` commits whatever its callback returns and rolls
		// back only on a throw, so a refused reward throws out of the
		// transaction and becomes the order failure here.
		if (error instanceof LoyaltyDomainError) {
			return { ok: false, failure: loyaltyFailure(error) }
		}
		if (error instanceof GiftCardDomainError) {
			return orderFailure(
				error.status,
				error.code,
				'This gift card cannot be used for the order.',
				{ details: error.details },
			)
		}
		throw error
	}
}

// ---------------------------------------------------------------------------
// Receipt retrieval (secret capability, never orderId or customer JWT alone)
// ---------------------------------------------------------------------------

export type ReceiptOrder = {
	order: RestaurantOrder
	lines: PricedOrderLine[]
}

export async function getOrderReceipt(
	orgId: string,
	orderId: string,
	presentedToken: string,
): Promise<OrderServiceResult<ReceiptOrder>> {
	if (!verifyReceiptToken(orgId, orderId, presentedToken)) {
		return orderFailure(
			403,
			'invalid_receipt_token',
			'This receipt link is not valid.',
		)
	}
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	return {
		ok: true,
		data: { order, lines: order.lines as PricedOrderLine[] },
	}
}

// ---------------------------------------------------------------------------
// Internal quote (App → regional). No PII: amounts and lifecycle state only.
// ---------------------------------------------------------------------------

export type OrderQuote = {
	orgId: string
	orderId: string
	totalCents: number
	currency: string
	holdExpiresAt: string | null
	status: string
}

export async function getOrderQuote(
	orgId: string,
	orderId: string,
	paymentToken: string,
): Promise<OrderServiceResult<OrderQuote>> {
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	if (order.paymentMethod !== 'online') {
		return orderFailure(
			409,
			'not_online_order',
			'Quotes are only available for online orders.',
		)
	}
	if (!verifyPaymentToken(orgId, order.id, paymentToken)) {
		return orderFailure(
			403,
			'invalid_payment_token',
			'This payment link is not valid.',
		)
	}
	return {
		ok: true,
		data: {
			orgId,
			orderId: order.id,
			// What the provider is asked for: the card paid its part already.
			totalCents: order.totalCents - order.giftCardCents,
			currency: order.currency,
			holdExpiresAt: order.holdExpiresAt
				? order.holdExpiresAt.toISOString()
				: null,
			status: order.status,
		},
	}
}

// ---------------------------------------------------------------------------
// Payment session binding (exactly once) + payment events (monotonic)
// ---------------------------------------------------------------------------

export type PaymentSessionResult = {
	orgId: string
	orderId: string
	sessionId: string
	status: string
	paymentStatus: string
}

export async function bindPaymentSession(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}): Promise<OrderServiceResult<PaymentSessionResult>> {
	const { orgId, orderId, sessionId, processor } = input
	const db = await getTenantDb(orgId)
	const loyalty = loyaltySettleQueue()

	const result: OrderServiceResult<PaymentSessionResult> = await runExclusive(
		orgId,
		() =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					await expireHolds(tx, new Date(), loyalty)
					const [order] = await tx
						.select()
						.from(restaurantOrders)
						.where(
							and(
								eq(restaurantOrders.id, orderId),
								eq(restaurantOrders.orgId, orgId),
							),
						)
						.limit(1)
					if (!order) {
						return orderFailure(404, 'order_not_found', 'Order not found.')
					}
					if (order.paymentMethod !== 'online') {
						return orderFailure(
							409,
							'not_online_order',
							'Payment sessions are only valid for online orders.',
						)
					}
					if (order.status === 'expired') {
						return orderFailure(
							409,
							'hold_expired',
							'The checkout hold for this order has expired.',
						)
					}
					if (
						order.paymentStatus === 'paid' ||
						order.paymentStatus === 'failed' ||
						order.paymentStatus === 'expired' ||
						order.paymentStatus === 'review'
					) {
						return orderFailure(
							409,
							'payment_terminal',
							'This order already has a terminal payment state.',
						)
					}
					if (order.paymentProcessor && order.paymentProcessor !== processor) {
						return orderFailure(
							409,
							'processor_mismatch',
							'This order is bound to a different payment processor.',
						)
					}
					if (order.paymentSessionId && order.paymentSessionId !== sessionId) {
						return orderFailure(
							409,
							'session_conflict',
							'This order already has a bound payment session.',
						)
					}
					if (order.paymentSessionId === sessionId) {
						return {
							ok: true,
							data: {
								orgId,
								orderId: order.id,
								sessionId,
								status: order.status,
								paymentStatus: order.paymentStatus,
							},
						}
					}
					await tx
						.update(restaurantOrders)
						.set({
							paymentSessionId: sessionId,
							paymentProcessor: processor,
							paymentEventAt: new Date(),
							updatedAt: new Date(),
						})
						.where(eq(restaurantOrders.id, order.id))
					return {
						ok: true,
						data: {
							orgId,
							orderId: order.id,
							sessionId,
							status: order.status,
							paymentStatus: order.paymentStatus,
						},
					}
				}),
			),
	)
	await loyalty.settle(orgId)
	// The order just became payable: it counts for order journeys now.
	scheduleOrderJourneys(orgId)
	return result
}

export type PaymentEventResult = {
	orgId: string
	orderId: string
	sessionId: string
	status: string
	paymentStatus: string
}

/**
 * The payment id to keep on an order: the stored one when there is one (a
 * different id in a later event is logged by order id and ignored), else the
 * event's, else none.
 */
function keepFirstPaymentId(
	orderId: string,
	stored: string | null,
	incoming: string | undefined,
): string | null {
	if (!incoming) return stored
	if (stored && stored !== incoming) {
		console.warn(
			`Payment event for order ${orderId} names another payment id; the stored one is kept`,
		)
		return stored
	}
	return stored ?? incoming
}

export async function applyPaymentEvent(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	/**
	 * The provider's id of the payment (Stripe PaymentIntent `pi_…`,
	 * Checkout.com `pay_…`) when the event carries one; stored on a paid
	 * event so a refund can name the payment.
	 */
	paymentId?: string
}): Promise<OrderServiceResult<PaymentEventResult>> {
	const {
		orgId,
		orderId,
		sessionId,
		processor,
		status,
		amountCents,
		currency,
	} = input
	const db = await getTenantDb(orgId)
	const loyalty = loyaltySettleQueue()
	const inventory = inventorySaleQueue()
	const messages = orderMessageBatch()

	const result: OrderServiceResult<PaymentEventResult> = await runExclusive(
		orgId,
		() =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					await expireHolds(tx, new Date(), loyalty)
					const [order] = await tx
						.select()
						.from(restaurantOrders)
						.where(
							and(
								eq(restaurantOrders.id, orderId),
								eq(restaurantOrders.orgId, orgId),
							),
						)
						.limit(1)
					if (!order) {
						return orderFailure(404, 'order_not_found', 'Order not found.')
					}
					if (order.paymentMethod !== 'online') {
						return orderFailure(
							409,
							'not_online_order',
							'Payment events are only valid for online orders.',
						)
					}
					if (!order.paymentSessionId || order.paymentSessionId !== sessionId) {
						return orderFailure(
							403,
							'session_mismatch',
							'This payment event does not match the bound payment session.',
						)
					}
					if (order.paymentProcessor !== processor) {
						return orderFailure(
							409,
							'processor_mismatch',
							'This payment event does not match the bound payment processor.',
						)
					}
					if (order.totalCents - order.giftCardCents !== amountCents) {
						return orderFailure(
							422,
							'amount_mismatch',
							'The payment amount does not match this order.',
						)
					}
					if (order.currency.toLowerCase() !== currency.toLowerCase()) {
						return orderFailure(
							422,
							'currency_mismatch',
							'The payment currency does not match this order.',
						)
					}

					const now = new Date()
					// Loyalty settles or releases from the new state (a no-op for
					// orders it does not track).
					const queueLoyalty = () =>
						loyalty.queue(
							loyaltyTx(tx),
							{ type: 'restaurant_order', id: order.id },
							now.getTime(),
						)
					const idempotent: PaymentEventResult = {
						orgId,
						orderId: order.id,
						sessionId,
						status: order.status,
						paymentStatus: order.paymentStatus,
					}

					// The provider's payment id is written once: a replay may fill
					// it in (an order paid before the field was sent), but a
					// different id never replaces the one that paid the order.
					const storedPaymentId = keepFirstPaymentId(
						order.id,
						order.paymentId,
						status === 'paid' ? input.paymentId : undefined,
					)

					if (status === 'paid') {
						if (order.paymentStatus === 'paid') {
							if (storedPaymentId !== order.paymentId) {
								await tx
									.update(restaurantOrders)
									.set({ paymentId: storedPaymentId })
									.where(eq(restaurantOrders.id, order.id))
							}
							return { ok: true, data: idempotent }
						}
						const lateArrival =
							order.status === 'expired' || order.status === 'cancelled'
						if (
							order.status === 'accepted' &&
							order.paymentStatus === 'pending'
						) {
							// Manual acceptance (#107): a paid order of a location that
							// wanted it waits for a person now. Nothing counts yet: the
							// discount use stays reserved, loyalty and stock wait for
							// the accept (`applyOrderStatusPatchInTx`).
							const waits = waitsForAcceptanceWhenPaid(order)
							const nextStatus = waits ? 'pending_acceptance' : order.status
							await tx
								.update(restaurantOrders)
								.set({
									status: nextStatus,
									paymentStatus: 'paid',
									paidAt: now,
									paymentEventAt: now,
									paymentId: storedPaymentId,
									...(waits
										? {
												acceptanceDeadlineAt: paidAcceptanceDeadline(
													order,
													now,
												),
											}
										: {}),
									updatedAt: now,
								})
								.where(eq(restaurantOrders.id, order.id))
							await queueOrderPaidMessages(
								tx,
								{ ...order, status: nextStatus, paymentStatus: 'paid' },
								messages.context(now.getTime()),
							)
							if (waits) {
								return {
									ok: true,
									data: {
										...idempotent,
										status: nextStatus,
										paymentStatus: 'paid',
									},
								}
							}
							await consumeDiscountRedemptions(tx, [order.id])
							await queueLoyalty()
							// Paid online: the order counts now, so stock leaves.
							await inventory.queue(
								tx,
								{
									type: 'restaurant_order',
									id: order.id,
									locationId: order.locationId,
								},
								now.getTime(),
							)
							return {
								ok: true,
								data: {
									...idempotent,
									status: order.status,
									paymentStatus: 'paid',
								},
							}
						}
						if (
							lateArrival &&
							(order.paymentStatus === 'pending' ||
								order.paymentStatus === 'expired' ||
								order.paymentStatus === 'failed')
						) {
							// Money arrived after the hold lapsed: never resurrect the
							// reservation. Surface payment_review for the operator.
							await tx
								.update(restaurantOrders)
								.set({
									status: 'payment_review',
									paymentStatus: 'paid',
									paidAt: now,
									paymentEventAt: now,
									paymentId: storedPaymentId,
									// An operator decides a late payment from review: it
									// never also waits for acceptance.
									acceptanceDeadlineAt: null,
									updatedAt: now,
								})
								.where(eq(restaurantOrders.id, order.id))
							// The sweep gave the discount use back when the hold lapsed, but
							// the guest paid the discounted price. Honor the sale: record the
							// use again (reserved, like any order awaiting its decision) even
							// if a limit has been reached since, so the counts stay true.
							// The operator's accept consumes it and a cancel releases it.
							const late = await reReserveReleasedDiscounts(tx, order.id)
							if (late.exceededDiscountIds.length > 0) {
								// Others took the last use while the page was still payable.
								// Still honored, but the operator is told why it waits.
								const exceeded = new Set(late.exceededDiscountIds)
								await tx
									.update(restaurantOrders)
									.set({
										discounts: (order.discounts ?? []).map((discount) =>
											exceeded.has(discount.discountId)
												? { ...discount, limitExceeded: true as const }
												: discount,
										),
									})
									.where(eq(restaurantOrders.id, order.id))
							}
							await queueLoyalty()
							return {
								ok: true,
								data: {
									...idempotent,
									status: 'payment_review',
									paymentStatus: 'paid',
								},
							}
						}
						return orderFailure(
							409,
							'payment_state_conflict',
							'This order cannot transition to paid.',
						)
					}

					if (status === 'failed') {
						if (order.paymentStatus === 'failed')
							return { ok: true, data: idempotent }
						if (
							order.status === 'accepted' &&
							order.paymentStatus === 'pending'
						) {
							await tx
								.update(restaurantOrders)
								.set({
									status: 'cancelled',
									paymentStatus: 'failed',
									cancelledAt: now,
									paymentEventAt: now,
									updatedAt: now,
								})
								.where(eq(restaurantOrders.id, order.id))
							await releaseDiscountRedemptions(tx, [order.id])
							await onReferralOrderCancelledOrRefundedInTx(loyaltyTx(tx), {
								orderId: order.id,
								fullRefund: true,
								remainingEligibleMinor: 0,
								now: now.getTime(),
							})
							await restoreOrderGiftCardsInTx(
								tx,
								[order.id],
								now.getTime(),
								'payment failed',
							)
							await queueLoyalty()
							return {
								ok: true,
								data: {
									...idempotent,
									status: 'cancelled',
									paymentStatus: 'failed',
								},
							}
						}
						return orderFailure(
							409,
							'payment_state_conflict',
							'This order cannot transition to failed.',
						)
					}

					// provider session expired without payment
					if (order.paymentStatus === 'expired')
						return { ok: true, data: idempotent }
					if (
						order.status === 'accepted' &&
						order.paymentStatus === 'pending'
					) {
						await tx
							.update(restaurantOrders)
							.set({
								status: 'expired',
								paymentStatus: 'expired',
								paymentEventAt: now,
								updatedAt: now,
							})
							.where(eq(restaurantOrders.id, order.id))
						await releaseDiscountRedemptions(tx, [order.id])
						await onReferralOrderCancelledOrRefundedInTx(loyaltyTx(tx), {
							orderId: order.id,
							fullRefund: true,
							remainingEligibleMinor: 0,
							now: now.getTime(),
						})
						await restoreOrderGiftCardsInTx(
							tx,
							[order.id],
							now.getTime(),
							'payment expired',
						)
						await queueLoyalty()
						return {
							ok: true,
							data: {
								...idempotent,
								status: 'expired',
								paymentStatus: 'expired',
							},
						}
					}
					return orderFailure(
						409,
						'payment_state_conflict',
						'This order cannot transition to expired.',
					)
				}),
			),
	)
	await loyalty.settle(orgId)
	await inventory.settle(orgId)
	messages.deliver(orgId)
	return result
}

// ---------------------------------------------------------------------------
// Operator lifecycle transitions
// ---------------------------------------------------------------------------

const OPERATOR_STATUS_TRANSITIONS: Record<RestaurantOrder['status'], string[]> =
	{
		accepted: ['preparing', 'ready', 'completed', 'cancelled'],
		preparing: ['ready', 'completed', 'cancelled'],
		ready: ['completed', 'cancelled'],
		completed: [],
		cancelled: [],
		expired: [],
		payment_review: ['preparing', 'ready', 'completed', 'cancelled'],
		// Manual acceptance (#107): accept, or reject (a cancel with a reject
		// reason). Nothing else leaves it; the kitchen never sees it.
		pending_acceptance: ['accepted', 'cancelled'],
	}

export type OperatorPatchInput =
	| {
			status: RestaurantOrder['status']
			markPaid?: boolean
			/**
			 * Why it is cancelled (`status: 'cancelled'` only); required for a
			 * paid online order (`cancel_reason_required`).
			 */
			cancelReason?: OrderStoredCancelReason
			/**
			 * Cancelling a paid online order: `full` books a provider refund of
			 * everything still refundable in the cancel's own transaction.
			 */
			refund?: 'none' | 'full'
			/**
			 * Turning down an order waiting for acceptance (#107): the cancel is a
			 * rejection (`rejected_reason`), and a paid online order is refunded
			 * in full through the payment provider whatever `refund` says.
			 */
			rejectReason?: OrderStoredCancelReason
	  }
	| {
			/** Push the promised time back (#109); never mixed with a status. */
			delayMinutes: PromisedDelayMinutes
			expectedPromisedVersion: number
	  }

/**
 * Extra checks a caller runs on the order inside the write's transaction, and
 * a record it adds in that same transaction when the order changed (Station's
 * Orders app: the order's location and version, and who did it).
 */
export type OrderWriteHooks = {
	guard?: (order: RestaurantOrder) => OrderServiceFailure | null
	afterWrite?: (
		tx: OrderTx,
		before: RestaurantOrder,
		after: RestaurantOrder,
	) => Promise<void>
}

/** Who cancels, and whether they may start a provider refund with it. */
export type CancelRefundOptions = {
	/**
	 * May start a provider refund (`refund: 'full'`): the App's
	 * `refundProvider` token claim, Station's refund grant. Without it a cancel
	 * asking for a refund is refused (403 `refund_forbidden`), not cancelled.
	 */
	mayRefund: boolean
	origin: OrderRefundOrigin
	/** User id (operator), `staff:<id>` (Station), `guest` or `system`. */
	actorId: string
	/** Station has no loyalty grant: an order loyalty tracks is not refunded there. */
	loyaltyAccess?: { refundLoyalty: boolean; impersonated: boolean }
	cancelledBy?: 'operator' | 'guest' | 'system'
	/**
	 * An admin impersonating a member: never starts a provider refund, so a
	 * rejection of a paid online order (which always refunds) is refused.
	 */
	impersonated?: boolean
}

/**
 * What became of `refund: 'full'` on a cancel: the booked provider refund
 * (the App completes it; the region also kicks the App), or the code saying
 * why none was started. The cancel stands either way.
 */
export type CancelRefundOutcome = {
	refund: OrderProviderRefund | null
	replayed: boolean
	code: string | null
	/**
	 * With `code: 'refund_pending'` (another provider refund was still
	 * waiting) or `'payment_disputed'` (an open dispute): the order is marked
	 * (`cancel_refund_due_at`) and the rest is booked once that refund is
	 * final or the dispute is won (`bookOwedCancelRefundInTx`). What the guest
	 * gets back in all: paid less what is back already. 0 otherwise.
	 */
	owedCents: number
}

export { cancelRefundKey }

export async function updateOperatorOrder(
	orgId: string,
	orderId: string,
	input: OperatorPatchInput,
	hooks: OrderWriteHooks = {},
): Promise<OrderServiceResult<RestaurantOrder>> {
	const result = await updateOperatorOrderWithRefund(
		orgId,
		orderId,
		input,
		hooks,
	)
	return result.ok ? { ok: true, data: result.data.order } : result
}

export async function updateOperatorOrderWithRefund(
	orgId: string,
	orderId: string,
	input: OperatorPatchInput,
	hooks: OrderWriteHooks = {},
	cancel: CancelRefundOptions = {
		mayRefund: false,
		origin: 'operator',
		actorId: 'operator',
	},
): Promise<
	OrderServiceResult<{
		order: RestaurantOrder
		refund: CancelRefundOutcome | null
	}>
> {
	const db = await getTenantDb(orgId)
	const queues = orderWriteQueues()
	let refundOutcome: CancelRefundOutcome | null = null

	const result: OrderServiceResult<RestaurantOrder> = await runExclusive(
		orgId,
		() =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					await expireHolds(tx, new Date(), queues.loyalty)
					const [order] = await tx
						.select()
						.from(restaurantOrders)
						.where(
							and(
								eq(restaurantOrders.id, orderId),
								eq(restaurantOrders.orgId, orgId),
							),
						)
						.limit(1)
					if (!order) {
						return orderFailure(404, 'order_not_found', 'Order not found.')
					}
					const refused = hooks.guard?.(order)
					if (refused) return { ok: false, failure: refused }

					const now = new Date()
					if ('delayMinutes' in input) {
						const delayed = await applyPromisedDelay(
							tx,
							order,
							{
								minutes: input.delayMinutes,
								expectedVersion: input.expectedPromisedVersion,
							},
							now,
							queues.messages.context(now.getTime()),
						)
						if (!delayed.ok) {
							return orderFailure(delayed.status, delayed.code, delayed.message)
						}
						await hooks.afterWrite?.(tx, order, delayed.order)
						return { ok: true, data: delayed.order }
					}
					const applied = await applyOrderStatusPatchInTx(tx, order, input, {
						hooks,
						cancel,
						queues,
						now,
					})
					refundOutcome = applied.refund
					return applied.result
				}),
			),
	)
	await settleOrderWriteQueues(orgId, queues)
	if (!result.ok) return result
	const booked = refundOutcome as CancelRefundOutcome | null
	if (booked?.refund && !booked.replayed) {
		// The App caller completes it from the answer; the kick covers a lost one.
		kickOrderRefundExecute(orgId, [booked.refund.refundId])
	}
	return { ok: true, data: { order: result.data, refund: booked } }
}

/**
 * The work an order write leaves for after its commit: loyalty and inventory
 * settlement and guest messages, queued inside the transaction.
 */
export type OrderWriteQueues = {
	loyalty: LoyaltySettleQueue
	inventory: ReturnType<typeof inventorySaleQueue>
	messages: ReturnType<typeof orderMessageBatch>
}

export function orderWriteQueues(): OrderWriteQueues {
	return {
		loyalty: loyaltySettleQueue(),
		inventory: inventorySaleQueue(),
		messages: orderMessageBatch(),
	}
}

/** Runs what an order write queued, after its transaction committed. */
export async function settleOrderWriteQueues(
	orgId: string,
	queues: OrderWriteQueues,
): Promise<void> {
	await queues.loyalty.settle(orgId)
	await queues.inventory.settle(orgId)
	queues.messages.deliver(orgId)
	// A status change (accepted, completed) may make an order count or finish.
	scheduleOrderJourneys(orgId)
}

/**
 * The hold sweep an order write runs first in its own transaction, so a
 * lapsed online hold is expired before the order is read.
 */
export async function expireHoldsInTx(
	tx: OrderTx,
	now: Date,
	loyalty: LoyaltySettleQueue,
): Promise<void> {
	await expireHolds(tx, now, loyalty)
}

/**
 * Statuses a guest may cancel from (#111). The guest's window check
 * (`guestCancelWindow`) decides whether they may; this only lets the write
 * leave `pending_acceptance`, which has no operator transition of its own.
 */
const GUEST_CANCEL_FROM_STATUSES: ReadonlySet<string> = new Set([
	'accepted',
	'pending_acceptance',
])

/**
 * One status write (`OperatorPatchInput` status branch) on an order already
 * read inside the caller's transaction: the transition, cancel reason and
 * who cancelled, mark paid, the provider refund a cancel asks for, and the
 * cancel side effects (loyalty and inventory queued, discount uses released
 * and refunded, the guest's status message queued). The operator PATCH,
 * Station's Orders app and the guest's own cancel all go through here; the
 * caller runs `settleOrderWriteQueues` (and the refund kick) after commit.
 */
export async function applyOrderStatusPatchInTx(
	tx: OrderTx,
	order: RestaurantOrder,
	input: Extract<OperatorPatchInput, { status: unknown }>,
	options: {
		hooks?: OrderWriteHooks
		cancel: CancelRefundOptions
		queues: OrderWriteQueues
		now: Date
	},
): Promise<{
	result: OrderServiceResult<RestaurantOrder>
	refund: CancelRefundOutcome | null
}> {
	const { cancel, queues, now } = options
	const hooks = options.hooks ?? {}
	const done = (
		result: OrderServiceResult<RestaurantOrder>,
		refund: CancelRefundOutcome | null = null,
	) => ({ result, refund })
	let refundOutcome: CancelRefundOutcome | null = null
	const patch: Partial<RestaurantOrder> = {}
	// Manual acceptance (#107). The decision is taken on the status the order
	// has now, inside the write's transaction: accepting an order no longer
	// waiting (rejected, timed out, cancelled by the guest) or rejecting one
	// already accepted is refused, so two screens never both decide.
	const fromPending = order.status === 'pending_acceptance'
	const notPending = () =>
		done(
			orderFailure(
				409,
				'order_not_pending',
				'This order is no longer waiting for acceptance.',
			),
		)
	// Only an order that waited is answered this way; any other keeps the
	// usual `invalid_transition`.
	const waited = order.acceptanceDeadlineAt !== null
	if (
		waited &&
		input.status === 'accepted' &&
		order.status !== 'accepted' &&
		!fromPending
	) {
		return notPending()
	}
	if (
		waited &&
		input.status === 'cancelled' &&
		input.rejectReason !== undefined &&
		order.status !== 'cancelled' &&
		!fromPending
	) {
		return notPending()
	}
	// A cancel of a waiting order by the restaurant (or the timeout) is a
	// rejection; the guest's own cancel is not.
	const isReject =
		fromPending &&
		input.status === 'cancelled' &&
		cancel.cancelledBy !== 'guest'
	// A plain cancel (no reject reason) of a waiting order is not a reject: a
	// reject forces a full refund and tells the guest the restaurant could not
	// take the order. The caller says which it means.
	if (isReject && input.rejectReason === undefined) {
		return done(
			orderFailure(
				409,
				'order_not_pending',
				'This order is waiting for acceptance. Reject it with a reason instead of cancelling it.',
			),
		)
	}
	let rejectRefund = false

	if (input.status !== order.status) {
		const allowed = OPERATOR_STATUS_TRANSITIONS[order.status] ?? []
		const guestCancel =
			cancel.cancelledBy === 'guest' &&
			input.status === 'cancelled' &&
			GUEST_CANCEL_FROM_STATUSES.has(order.status)
		if (!allowed.includes(input.status) && !guestCancel) {
			return done(
				orderFailure(
					422,
					'invalid_transition',
					`An order that is ${order.status} cannot move to ${input.status}.`,
				),
			)
		}
		patch.status = input.status
		if (input.status === 'completed') patch.completedAt = now
		if (input.status === 'cancelled') patch.cancelledAt = now
		if (fromPending && input.status === 'accepted') patch.acceptedAt = now
	}

	const wantsRefund = input.refund === 'full'
	const paidOnline =
		order.paymentMethod === 'online' && order.paymentStatus === 'paid'
	if (
		input.status === 'cancelled' &&
		order.status === 'cancelled' &&
		wantsRefund
	) {
		if (!cancel.mayRefund) {
			return done(
				orderFailure(
					403,
					'refund_forbidden',
					'Refunding through the payment provider needs the refund permission.',
				),
			)
		}
		// A repeated cancel (a lost answer): answer the refund it booked (or
		// the rest it booked later), or that the rest is still owed.
		const booked = await tx
			.select()
			.from(restaurantOrderRefunds)
			.where(
				and(
					eq(restaurantOrderRefunds.orderId, order.id),
					inArray(restaurantOrderRefunds.idempotencyKey, [
						cancelRefundKey(order.id),
						owedCancelRefundKey(order.id),
					]),
				),
			)
			.orderBy(desc(restaurantOrderRefunds.createdAt))
			.limit(1)
		refundOutcome = booked[0]
			? {
					refund: orderProviderRefundView(booked[0], order),
					replayed: true,
					code: null,
					owedCents: 0,
				}
			: order.cancelRefundDueAt
				? {
						refund: null,
						replayed: false,
						code:
							order.disputeStatus === 'open'
								? 'payment_disputed'
								: 'refund_pending',
						owedCents: owedCents(order),
					}
				: {
						refund: null,
						replayed: false,
						code: 'order_not_refundable',
						owedCents: 0,
					}
	}
	if (patch.status === 'cancelled' && isReject) {
		if (wantsRefund && order.paymentMethod !== 'online') {
			return done(
				orderFailure(
					400,
					'order_not_refundable',
					'An order paid at handoff is not refunded with the cancel. Record the refund instead.',
				),
			)
		}
		const reason = input.rejectReason ?? null
		if (!reason) {
			return done(
				orderFailure(
					422,
					'reject_reason_required',
					'Say why this order is turned down.',
				),
			)
		}
		// Turning down a paid online order always gives the money back: no
		// refund grant is asked for (the timeout does it too), but an admin
		// impersonating a member never starts a provider refund.
		if (paidOnline) {
			if (cancel.impersonated) {
				return done(
					orderFailure(
						403,
						'refund_forbidden',
						'Turning down a paid order refunds it, which is not available while impersonating.',
					),
				)
			}
			rejectRefund = true
		}
		patch.cancelReason = reason
		patch.rejectedReason = reason
		patch.cancelledBy = cancel.cancelledBy ?? 'operator'
	} else if (patch.status === 'cancelled') {
		if (wantsRefund && order.paymentMethod !== 'online') {
			return done(
				orderFailure(
					400,
					'order_not_refundable',
					'An order paid at handoff is not refunded with the cancel. Record the refund instead.',
				),
			)
		}
		if (wantsRefund && !cancel.mayRefund) {
			return done(
				orderFailure(
					403,
					'refund_forbidden',
					'Refunding through the payment provider needs the refund permission.',
				),
			)
		}
		const reason = input.cancelReason ?? input.rejectReason ?? null
		if (paidOnline && !reason) {
			return done(
				orderFailure(
					422,
					'cancel_reason_required',
					'Say why this paid order is cancelled.',
				),
			)
		}
		patch.cancelReason = reason
		patch.cancelledBy = cancel.cancelledBy ?? 'operator'
	}

	if (input.markPaid) {
		// A tab is paid once, at close: settling one round alone would
		// leave the tab total and the rounds disagreeing.
		if (order.tabId) {
			return done(
				orderFailure(
					409,
					'tab_settlement_required',
					'This order is on a table tab. Close the tab to take payment.',
				),
			)
		}
		if (order.paymentMethod !== 'online') {
			// A free order (not_required) has nothing to collect: marking
			// it paid is a no-op, so a stale client tap neither fails nor
			// invents a payment.
			if (order.paymentStatus !== 'not_required') {
				if (
					order.paymentStatus !== 'unpaid' &&
					order.paymentStatus !== 'paid'
				) {
					return done(
						orderFailure(
							409,
							'payment_state_conflict',
							'This order cannot be marked paid.',
						),
					)
				}
				patch.paymentStatus = 'paid'
				patch.paidAt = now
			}
		} else {
			return done(
				orderFailure(
					409,
					'payment_not_markable',
					'Online order payment status is controlled by payment events.',
				),
			)
		}
	}

	if (Object.keys(patch).length === 0) {
		return done({ ok: true, data: order }, refundOutcome)
	}

	const [updated] = await tx
		.update(restaurantOrders)
		.set({ ...patch, updatedAt: now })
		.where(
			and(
				eq(restaurantOrders.id, order.id),
				// Belt and braces for accept and reject: only while it still waits.
				...(fromPending && patch.status
					? [eq(restaurantOrders.status, 'pending_acceptance' as const)]
					: []),
			),
		)
		.returning()
	if (fromPending && patch.status && !updated) return notPending()
	if (
		patch.status === 'cancelled' &&
		(input.refund === 'full' || rejectRefund)
	) {
		refundOutcome = await bookCancelRefund(
			tx,
			updated ?? { ...order, ...patch },
			// A rejection's refund is the rejection itself, not a refund a
			// person chose: no loyalty grant is asked for (the order never
			// earned; its reward comes back once the money is back).
			rejectRefund ? { ...cancel, loyaltyAccess: undefined } : cancel,
			now.getTime(),
		)
	}
	await queues.loyalty.queue(
		loyaltyTx(tx),
		{ type: 'restaurant_order', id: order.id },
		now.getTime(),
	)
	// A cancel returns what the order used; accepting an order held
	// for review (or marking one paid) starts to count it.
	await queues.inventory.queue(
		tx,
		{
			type: 'restaurant_order',
			id: order.id,
			locationId: order.locationId,
		},
		now.getTime(),
	)
	if (patch.status === 'cancelled') {
		await releaseDiscountRedemptions(tx, [order.id])
		await refundDiscountRedemptions(tx, order.id)
		await onReferralOrderCancelledOrRefundedInTx(loyaltyTx(tx), {
			orderId: order.id,
			fullRefund: true,
			remainingEligibleMinor: 0,
			now: now.getTime(),
		})
		// An order that captured no provider money (unpaid, or paid entirely by
		// a gift card) gives the card its part back. A paid one returns it
		// through the refund path, gift card first.
		if (order.paymentStatus !== 'paid') {
			await restoreOrderGiftCardsInTx(
				tx,
				[order.id],
				now.getTime(),
				'order cancelled',
			)
		}
	} else if (
		patch.status === 'completed' ||
		patch.paymentStatus === 'paid' ||
		// Accepting a paid (or free) online order spends the use, as its paid
		// event (or a free order's placement) would have had it not waited.
		(fromPending &&
			patch.status === 'accepted' &&
			order.paymentMethod === 'online' &&
			(order.paymentStatus === 'paid' ||
				order.paymentStatus === 'not_required')) ||
		// An operator accepting a paid order that was held for review
		// (it was paid after its hold lapsed) honors the sale.
		(order.status === 'payment_review' && patch.status !== undefined)
	) {
		if (order.status === 'payment_review') {
			// Orders that reached review before the use was re-recorded
			// at that moment have only a released row: record it now.
			await reReserveReleasedDiscounts(tx, order.id)
		}
		await consumeDiscountRedemptions(tx, [order.id])
		const effectivePaymentStatus = patch.paymentStatus ?? order.paymentStatus
		if (
			patch.status === 'completed' &&
			(effectivePaymentStatus === 'paid' ||
				effectivePaymentStatus === 'not_required')
		) {
			await onReferralOrderCompletedInTx(loyaltyTx(tx), {
				orderId: order.id,
				eligibleMinor: Math.max(0, order.subtotalCents - order.discountCents),
				totalPaidMinor: order.totalCents,
				paymentStatus: effectivePaymentStatus,
				now: now.getTime(),
			})
		}
	}
	// Ready and cancelled tell the guest (once per kind and channel).
	await queueOrderStatusMessages(
		tx,
		updated ?? { ...order, ...patch },
		order.status,
		patch.status ?? null,
		queues.messages.context(now.getTime()),
	)
	// Only a person accepting a waiting order says "accepted" (#107); an
	// order accepted automatically at placement never does.
	if (fromPending && patch.status === 'accepted') {
		await queueOrderMessage(
			tx,
			updated ?? { ...order, ...patch },
			'accepted',
			queues.messages.context(now.getTime()),
		)
	}
	await hooks.afterWrite?.(tx, order, updated ?? order)
	return done({ ok: true, data: updated ?? order }, refundOutcome)
}

/**
 * Books the full provider refund a cancel asked for, inside the cancel's
 * transaction (the order is already `cancelled` in it). Never fails the
 * cancel: what stops the refund (a dispute, a refund already waiting, nothing
 * left, loyalty the caller may not move) comes back as a code.
 */
async function bookCancelRefund(
	tx: OrderTx,
	order: RestaurantOrder,
	cancel: CancelRefundOptions,
	now: number,
): Promise<CancelRefundOutcome> {
	const none = (code: string) => ({
		refund: null,
		replayed: false,
		code,
		owedCents: 0,
	})
	if (cancel.loyaltyAccess && (await orderCarriesLoyalty(tx, order.id))) {
		if (cancel.loyaltyAccess.impersonated) {
			return none('impersonation_forbidden')
		}
		if (!cancel.loyaltyAccess.refundLoyalty) {
			return none('loyalty_refund_forbidden')
		}
	}
	const booked = await bookOrderProviderRefundInTx(tx, order, {
		amount: { full: true },
		note: null,
		idempotencyKey: cancelRefundKey(order.id),
		origin: cancel.origin,
		actorId: cancel.actorId,
		now,
	})
	if (!booked.ok && cancelRefundStaysOwed(booked.code, order)) {
		// Another refund still waits on the provider (one at a time), or the
		// payment has an open dispute: the full refund the cancel asked for is
		// owed, and booked for whatever is left once that refund is final
		// (`applyProviderRefundStatus`, the orders tick) or the dispute is won
		// (`applyDisputeStatus`; a lost one drops it).
		await tx
			.update(restaurantOrders)
			.set({ cancelRefundDueAt: new Date(now) })
			.where(eq(restaurantOrders.id, order.id))
		return {
			refund: null,
			replayed: false,
			code: booked.code,
			owedCents: owedCents(order),
		}
	}
	if (!booked.ok) return none(booked.code)
	return {
		refund: orderProviderRefundView(booked.refund, order),
		replayed: booked.replayed,
		code: null,
		owedCents: 0,
	}
}

/** What a cancel's full refund gives back in all: paid less what is back. */
function owedCents(order: RestaurantOrder): number {
	return Math.max(0, orderPaidCents(order) - orderRefundedNetCents(order))
}

export async function listOperatorOrders(
	orgId: string,
	options: {
		limit: number
		status?: string
		/** A location-scoped operator's locations; null or absent is all. */
		locationIds?: readonly string[] | null
	},
): Promise<RestaurantOrder[]> {
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const conditions = [eq(restaurantOrders.orgId, orgId)]
	if (options.locationIds) {
		conditions.push(
			inJsonList(restaurantOrders.locationId, options.locationIds),
		)
	}
	if (options.status) {
		conditions.push(
			eq(restaurantOrders.status, options.status as RestaurantOrder['status']),
		)
	}
	return db
		.select()
		.from(restaurantOrders)
		.where(and(...conditions))
		.orderBy(desc(restaurantOrders.createdAt))
		.limit(options.limit)
}

export async function getOperatorOrder(
	orgId: string,
	orderId: string,
): Promise<OrderServiceResult<RestaurantOrder>> {
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	return { ok: true, data: order }
}

// ---------------------------------------------------------------------------
// Public ordering options (GET /orders/options): aggregates only, no PII
// ---------------------------------------------------------------------------

export async function buildOrderingOptions(
	organization: PublishedOrganization,
	input: { slug: string | null; locationId: string; dropSlug: string | null },
): Promise<OrderServiceResult<PublicOrderingOptions>> {
	const result = await buildOrderingOptionsWithContext(organization, input)
	if (!result.ok) return result
	return { ok: true, data: result.data.options }
}

/** Ordering options plus the fresh order context they were built from. */
export async function buildOrderingOptionsWithContext(
	organization: PublishedOrganization,
	input: { slug: string | null; locationId: string; dropSlug: string | null },
): Promise<
	OrderServiceResult<{
		options: PublicOrderingOptions
		context: RestaurantOrderContext
	}>
> {
	const contextResult = await fetchOrderContext(
		organization.id,
		input.locationId,
		input.dropSlug,
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

	const now = new Date()
	const db = await getTenantDb(organization.id)
	await sweepExpiredHolds(organization.id)

	const slotOrders = new Map<string, number>()
	const entityUsed = new Map<string, number>()

	if (input.dropSlug && context.drop) {
		const windowIds = context.drop.pickupWindows.map((window) => window.id)
		if (windowIds.length > 0) {
			const slotRows = await db
				.select({
					windowId: restaurantOrders.pickupWindowId,
					time: restaurantOrders.pickupTime,
					value: count(),
				})
				.from(restaurantOrders)
				.where(
					and(
						// bound as one JSON parameter: Durable Object SQLite caps bound values
						inJsonList(restaurantOrders.pickupWindowId, windowIds),
						inArray(restaurantOrders.status, [
							...RESTAURANT_ORDER_ACTIVE_STATUSES,
						]),
					),
				)
				.groupBy(restaurantOrders.pickupWindowId, restaurantOrders.pickupTime)
			for (const row of slotRows) {
				if (row.windowId && row.time) {
					slotOrders.set(`${row.windowId}|${row.time}`, Number(row.value))
				}
			}
		}

		const entityIds = context.drop.inventoryOverrides.map(
			(override) => override.entityId,
		)
		if (entityIds.length > 0) {
			const entityRows = await db
				.select({
					kind: restaurantOrderReservations.kind,
					entityId: restaurantOrderReservations.entityId,
					used: sum(restaurantOrderReservations.quantity),
				})
				.from(restaurantOrderReservations)
				.innerJoin(
					restaurantOrders,
					eq(restaurantOrders.id, restaurantOrderReservations.orderId),
				)
				.where(
					and(
						inJsonList(restaurantOrderReservations.entityId, entityIds),
						eq(restaurantOrders.dropId, context.drop.drop.id),
						inArray(restaurantOrders.status, [
							...RESTAURANT_ORDER_ACTIVE_STATUSES,
						]),
					),
				)
				.groupBy(
					restaurantOrderReservations.kind,
					restaurantOrderReservations.entityId,
				)
			for (const row of entityRows) {
				entityUsed.set(`${row.kind}|${row.entityId}`, Number(row.used ?? 0))
			}
		}
	}

	const built = buildPublicOrderingOptions(context, {
		slug: input.slug,
		locationId: input.locationId,
		dropSlug: input.dropSlug,
		counts: { slotOrders, entityUsed },
		now,
		geocoderAvailable: isGeocodingAvailable(),
		dailyAvailability:
			context.dailyDishLimits?.enabled === true
				? await readDailyDishAvailability(db, context, input.locationId, now)
				: undefined,
	})
	if (!built.ok) return { ok: false, failure: fromEngineError(built.error) }
	return { ok: true, data: { options: built.options, context } }
}

// ---------------------------------------------------------------------------
// Serialization (public summary + receipt + operator views)
// ---------------------------------------------------------------------------

export function publicOrderSummary(order: RestaurantOrder) {
	return {
		id: order.id,
		number: order.number,
		status: order.status,
		paymentStatus: order.paymentStatus,
		currency: order.currency,
		subtotalCents: order.subtotalCents,
		taxCents: order.taxCents,
		deliveryFeeCents: order.deliveryFeeCents,
		tipCents: order.tipCents,
		/**
		 * The guest service fee (#123) before its tax, which is part of
		 * `taxCents`; 0 and null when none applied. The label is the name the
		 * guest saw at checkout.
		 */
		serviceFeeCents: order.serviceFeeCents,
		serviceFeeTaxCents: order.serviceFeeTaxCents,
		serviceFeeLabel: order.serviceFeeLabel,
		packagingFeeCents: order.packagingFeeCents,
		packagingFeeTaxCents: order.packagingFeeTaxCents,
		packagingFeeLabel: order.packagingFeeLabel,
		utensilsRequested: order.utensilsRequested,
		largeOrderExtraMinutes: order.largeOrderExtraMinutes,
		pickupInstructions: order.pickupInstructions,
		/** A loyalty reward's discount, taken off the subtotal before tax. */
		loyaltyDiscountCents: order.loyaltyDiscountCents,
		/** Coupons and automatic discounts on the items, in cents. */
		discountCents: order.discountCents,
		/** Delivery fee taken off by a discount, in cents. */
		deliveryDiscountCents: order.deliveryDiscountCents,
		/** Each applied discount, without the per-line allocation. */
		discounts: (order.discounts ?? []).map((discount) => ({
			discountId: discount.discountId,
			name: discount.name,
			...(discount.nameI18n ? { nameI18n: discount.nameI18n } : {}),
			code: discount.code,
			amountMinor: discount.amountMinor,
			deliveryAmountMinor: discount.deliveryAmountMinor,
		})),
		totalCents: order.totalCents,
		holdExpiresAt: order.holdExpiresAt
			? order.holdExpiresAt.toISOString()
			: null,
		/**
		 * When the order should be ready (pickup) or start arriving (delivery),
		 * and the end of a delivery range. Null when there is none (table
		 * rounds, drops, orders placed before #109).
		 */
		promisedAt: order.promisedAt ? order.promisedAt.toISOString() : null,
		promisedUntil: order.promisedUntil
			? order.promisedUntil.toISOString()
			: null,
	}
}

/**
 * The order's refunds at a glance for the guest and operator views: the
 * summary status and what still waits on the payment provider. Built from the
 * refund rows (`orderRefundSummary`); without them only `refundedCents` is
 * known and nothing reads as waiting.
 */
export type OrderRefundGlance = {
	refundStatus: OrderRefundSummaryStatus
	pendingCents: number
}

/**
 * Whether the guest may cancel the order themselves now (#111), and until
 * when: `guestCancelGlance` (`services/order-guest-cancel.ts`). No PII.
 */
export type OrderGuestCancelGlance = { allowed: boolean; until: string | null }

export function receiptOrder(
	order: RestaurantOrder,
	refunds: OrderRefundGlance | null = null,
	cancel: OrderGuestCancelGlance | null = null,
) {
	const glance = refunds ?? {
		refundStatus: orderRefundSummary(order, []).refundStatus,
		pendingCents: 0,
	}
	return {
		...publicOrderSummary(order),
		tipPercent: order.tipPercent,
		/**
		 * Amount returned so far (succeeded refunds less any the provider
		 * reversed; the payment status stays `paid`).
		 */
		refundedCents: orderRefundedNetCents(order),
		/** `pending` while a provider refund waits; `failed`, `partial`, `full`, `none`. */
		refundStatus: glance.refundStatus,
		/** A provider refund on its way (not in `refundedCents` yet). */
		refundPendingCents: glance.pendingCents,
		/**
		 * A guest cancel refunds the card in full: only a paid online order.
		 * Sites words the confirm box from it, so an order paid at handoff is
		 * never promised a refund the region does not book.
		 */
		refundsOnCancel:
			order.paymentMethod === 'online' && order.paymentStatus === 'paid',
		/** Who cancelled: `operator`, `guest` or `system`; null otherwise. */
		cancelledBy: order.cancelledBy ?? null,
		/** Only `out_of_stock` / `kitchen_closed` are told to the guest. */
		cancelReason: guestVisibleCancelReason(order.cancelReason),
		/**
		 * While the order waits for the restaurant to accept it
		 * (`pending_acceptance`): when it is turned down automatically. Null
		 * otherwise.
		 */
		acceptanceDeadlineAt:
			order.status === 'pending_acceptance' && order.acceptanceDeadlineAt
				? order.acceptanceDeadlineAt.toISOString()
				: null,
		/**
		 * The region's clock when this was read. Sites compares the cancel and
		 * acceptance deadlines with it, so a guest whose phone clock is off
		 * still sees the right countdown.
		 */
		serverNow: new Date().toISOString(),
		/** The restaurant turned it down while it waited (or nobody decided in time). */
		rejected: order.rejectedReason != null,
		/**
		 * "Cancel order" on the success page and the order link: present only
		 * on the guest's own reads (the operator view never computes it).
		 */
		...(cancel
			? { cancel: { allowed: cancel.allowed, until: cancel.until } }
			: {}),
		fulfillment: order.fulfillment,
		locale: order.locale,
		createdAt: order.createdAt ? order.createdAt.toISOString() : null,
		scheduledFor: order.scheduledFor ? order.scheduledFor.toISOString() : null,
		location: { id: order.locationId, name: order.locationName },
		pickup:
			order.pickupWindowId && order.pickupDate && order.pickupTime
				? {
						windowId: order.pickupWindowId,
						date: order.pickupDate,
						time: order.pickupTime,
						timezone: order.pickupTimezone ?? 'UTC',
					}
				: null,
		drop: order.dropSlug ? { slug: order.dropSlug } : null,
		table:
			order.tableId && order.tableLabel
				? { id: order.tableId, label: order.tableLabel }
				: null,
		tabId: order.tabId ?? null,
		source: order.source ?? null,
		lines: order.lines as PricedOrderLine[],
		contact: {
			name: order.contactName,
			phone: order.contactPhone,
			email: order.contactEmail ?? null,
		},
		delivery: order.deliveryAddress
			? {
					address: order.deliveryAddress,
					city: order.deliveryCity,
					unit: order.deliveryUnit,
					postalCode: order.deliveryPostalCode,
					notes: order.deliveryNotes,
					feeCents: order.deliveryFeeCents,
					zoneId: order.deliveryZoneId,
				}
			: null,
	}
}

/**
 * When a waiting order is (or was) turned down automatically, for the
 * operator. An online order not paid yet carries the deadline it was placed
 * with only as a mark that it will wait once paid: not shown until then.
 */
function operatorAcceptanceDeadline(order: RestaurantOrder): string | null {
	if (!order.acceptanceDeadlineAt) return null
	const stands =
		order.paymentMethod !== 'online' ||
		order.paymentStatus === 'paid' ||
		order.paymentStatus === 'not_required'
	return stands ? order.acceptanceDeadlineAt.toISOString() : null
}

export function operatorOrder(
	order: RestaurantOrder,
	customerKey: string | null = null,
	refunds: OrderRefundGlance | null = null,
) {
	return {
		...receiptOrder(order, refunds),
		id: order.id,
		orgId: order.orgId,
		customerId: order.customerId,
		/** `c_<id>` / `g_<id>` person key the Orders screen links to, or null. */
		customerKey,
		paymentMethod: order.paymentMethod,
		paymentProcessor: order.paymentProcessor,
		paymentSessionId: order.paymentSessionId,
		/**
		 * Why a `payment_review` order waits, when the region knows: the sale was
		 * paid late and a discount's limit had been used up since. Null otherwise.
		 */
		reviewReason:
			order.status === 'payment_review' &&
			(order.discounts ?? []).some((discount) => discount.limitExceeded)
				? ('discount_limit_exceeded' as const)
				: null,
		/** Returned (less reversals); the payment status stays `paid`. */
		refundedCents: orderRefundedNetCents(order),
		/**
		 * What the order charged for its service fee (#123): the fee plus its tax
		 * unless prices include tax. What a refund can give back for it is this
		 * less the fee part of the refunds already made.
		 */
		serviceFeeChargeCents: orderServiceFeeChargeCents(order),
		dropId: order.dropId,
		deliveryZoneId: order.deliveryZoneId,
		deliveryPoint:
			order.deliveryLat != null && order.deliveryLng != null
				? { lat: order.deliveryLat, lng: order.deliveryLng }
				: null,
		paidAt: order.paidAt ? order.paidAt.toISOString() : null,
		completedAt: order.completedAt ? order.completedAt.toISOString() : null,
		cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
		updatedAt: order.updatedAt ? order.updatedAt.toISOString() : null,
		/** Names the promised time a push-back (`delayMinutes`) expects. */
		promisedVersion: order.promisedVersion,
		/** Minutes already pushed back (the limit is 90 in total). */
		promisedDelayMinutes: order.promisedDelayMinutes,
		/**
		 * IANA time zone of the order's location, stored at placement (the
		 * pickup window's zone when that is all there is), for showing the
		 * promised and scheduled times in the restaurant's zone. Null when
		 * unknown.
		 */
		timeZone: order.locationTimezone ?? order.pickupTimezone ?? null,
		/** Why and by whom it was cancelled (internal reasons included). */
		cancelReason: order.cancelReason ?? null,
		cancelledBy: order.cancelledBy ?? null,
		/** Set when it was turned down while waiting for acceptance. */
		rejectedReason: order.rejectedReason ?? null,
		acceptanceDeadlineAt: operatorAcceptanceDeadline(order),
		acceptedAt: order.acceptedAt ? order.acceptedAt.toISOString() : null,
		/** An open or lost dispute: refunds are refused. */
		disputed: disputeBlocksRefund(order.disputeStatus),
		disputeStatus: order.disputeStatus ?? null,
		disputedAt: order.disputedAt ? order.disputedAt.toISOString() : null,
	}
}
