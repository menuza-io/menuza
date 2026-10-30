import { type PricedOrderLine } from '@repo/common/restaurant-orders'
import {
	buildPurchaseSnapshot,
	redemptionHoldsPoints,
	snapshotCatalogId,
	type LoyaltyCart,
	type LoyaltyCartLine,
	type SnapshotAllocationLine,
	type SnapshotSourceLine,
} from '@repo/loyalty'
import {
	loyaltyOutbox,
	loyaltyRedemptions,
	loyaltyRefunds,
	qrTabs,
	restaurantOrders,
	type QrTabRow,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { and, asc, eq, inArray, lte, ne, notExists, sql } from 'drizzle-orm'
import { type LoyaltyReader } from '../lib/loyalty-write.ts'
import { type RedemptionRow } from '../services/loyalty-redemption-service.ts'
import {
	type LoyaltySourceAdapter,
	type LoyaltySourceVerdict,
} from '../services/loyalty-sources.ts'
import {
	listTabRounds,
	QR_ROUND_VOID_STATUSES,
	tabTotals,
} from '../services/qr-dine-in.ts'

/**
 * Loyalty's view of restaurant orders and QR tabs: the neutral cart a reward
 * is quoted on, and the purchase snapshot a finished sale earns from. Both are
 * built from the priced lines the region stored, never from client prices.
 *
 * A pickup or delivery order is one purchase. A QR tab is one purchase however
 * many rounds it had; its rounds (orders with a `tabId`) never are.
 */

const MAX_CATEGORY_IDS = 50

/** A line's position on the order; on a tab, prefixed by its round. */
export function restaurantLineId(index: number, roundId?: string): string {
	return roundId ? `${roundId}:${index}` : String(index)
}

function categoryIdsOf(line: PricedOrderLine): string[] {
	return [...new Set(line.categoryIds.map(snapshotCatalogId))].slice(
		0,
		MAX_CATEGORY_IDS,
	)
}

/** The cart a reward is quoted and bound on. */
export function restaurantCartLines(
	lines: readonly PricedOrderLine[],
	roundId?: string,
): LoyaltyCartLine[] {
	return lines.map((line, index) => {
		const unitMinor = Math.max(0, line.unitPriceCents)
		const unitBaseMinor = Math.min(unitMinor, Math.max(0, line.baseUnitCents))
		return {
			lineId: restaurantLineId(index, roundId),
			itemId: snapshotCatalogId(line.itemId),
			variantId: line.variantId ? snapshotCatalogId(line.variantId) : null,
			categoryIds: categoryIdsOf(line),
			quantity: line.quantity,
			unitBaseMinor,
			unitMinor,
		}
	})
}

function snapshotLines(
	lines: readonly PricedOrderLine[],
	roundId?: string,
): SnapshotSourceLine[] {
	return lines.map((line, index) => ({
		lineId: restaurantLineId(index, roundId),
		itemId: line.itemId,
		categoryIds: line.categoryIds,
		quantity: line.quantity,
		grossMinor: line.totalCents,
		taxableMinor: line.taxableCents,
	}))
}

/**
 * How the sale's loyalty discount splits over its lines: the redemption's own
 * split when it is the discount the sale carries, otherwise spread like a
 * sale-level discount (the mismatch itself goes to review).
 */
function discountSplit(
	saleDiscountMinor: number,
	redemption: RedemptionRow | null,
): { allocation?: SnapshotAllocationLine[]; otherDiscountMinor: number } {
	if (saleDiscountMinor <= 0) return { otherDiscountMinor: 0 }
	if (redemption && redemption.discountMinor === saleDiscountMinor) {
		return {
			allocation: redemption.allocation.map((line) => ({
				lineId: line.lineId,
				discountMinor: line.discountMinor,
				rewardUnits: line.rewardUnits,
			})),
			otherDiscountMinor: 0,
		}
	}
	return { otherDiscountMinor: saleDiscountMinor }
}

/**
 * The priced lines a stored order or round holds. A round stored before lines
 * carried their base price and categories (a tab open across the deploy)
 * reads with a zero base price and no categories: it can still earn on what it
 * paid, but a free-item reward is worth nothing on it and category earning
 * finds no match. Nothing throws on such a line.
 */
function storedLines(order: RestaurantOrder): PricedOrderLine[] {
	if (!Array.isArray(order.lines)) return []
	return (order.lines as Array<Partial<PricedOrderLine>>).map(
		(line) =>
			({
				...line,
				baseUnitCents: line.baseUnitCents ?? 0,
				categoryIds: line.categoryIds ?? [],
			}) as PricedOrderLine,
	)
}

/** Prices include tax when the total never added it on top. */
export function orderTaxInclusive(
	order: Pick<
		RestaurantOrder,
		| 'taxCents'
		| 'totalCents'
		| 'subtotalCents'
		| 'loyaltyDiscountCents'
		| 'tipCents'
		| 'deliveryFeeCents'
	>,
): boolean {
	return (
		order.taxCents > 0 &&
		order.totalCents ===
			order.subtotalCents -
				order.loyaltyDiscountCents +
				order.tipCents +
				order.deliveryFeeCents
	)
}

const ms = (value: Date | null | undefined) =>
	value instanceof Date ? value.getTime() : 0

/** Time for a provider's payment event to reach the region. */
const PAYMENT_EVENT_GRACE_MS = 15 * 60_000

/**
 * How long after its hold an online order's payment page can still take
 * money. The App opens a Stripe Checkout session for at least 31 minutes
 * (Stripe's minimum is 30); a Checkout.com hosted page cannot be closed early
 * and stays payable for a day.
 */
export const ONLINE_PAYABLE_AFTER_HOLD_MS = {
	connect: 31 * 60_000 + PAYMENT_EVENT_GRACE_MS,
	checkout: 24 * 60 * 60_000 + PAYMENT_EVENT_GRACE_MS,
} as const

/**
 * Until when an unpaid online order can still be paid on the page opened for
 * it; null when no page was opened. A session is only ever bound before the
 * hold lapses, so the hold bounds when the page was opened.
 */
export function restaurantOrderPayableUntil(
	order: Pick<
		RestaurantOrder,
		| 'paymentMethod'
		| 'paymentSessionId'
		| 'paymentProcessor'
		| 'holdExpiresAt'
		| 'createdAt'
	>,
): number | null {
	if (
		order.paymentMethod !== 'online' ||
		!order.paymentSessionId ||
		!order.paymentProcessor
	) {
		return null
	}
	return (
		(ms(order.holdExpiresAt) || ms(order.createdAt)) +
		ONLINE_PAYABLE_AFTER_HOLD_MS[order.paymentProcessor]
	)
}

/**
 * Until when the payment page bound to a QR tab can still take money; null
 * when none is bound. `paymentEventAt` is when the page was bound; past the
 * tab's own 45-minute hold a Checkout.com page stays payable for a day, like
 * an order's.
 */
export function qrTabPayableUntil(
	tab: Pick<
		QrTabRow,
		'paymentStatus' | 'paymentSessionId' | 'paymentProcessor' | 'paymentEventAt'
	>,
): number | null {
	if (
		tab.paymentStatus !== 'pending' ||
		!tab.paymentSessionId ||
		!tab.paymentProcessor ||
		tab.paymentEventAt === null
	) {
		return null
	}
	return tab.paymentEventAt + ONLINE_PAYABLE_AFTER_HOLD_MS[tab.paymentProcessor]
}

/** `restaurantOrderPayableUntil` in SQL (the order's times are in seconds). */
const payableUntilSql = sql<number>`(coalesce(${restaurantOrders.holdExpiresAt}, ${restaurantOrders.createdAt}) * 1000 + case when ${restaurantOrders.paymentSessionId} is null then 0 when ${restaurantOrders.paymentProcessor} = 'checkout' then ${ONLINE_PAYABLE_AFTER_HOLD_MS.checkout} when ${restaurantOrders.paymentProcessor} = 'connect' then ${ONLINE_PAYABLE_AFTER_HOLD_MS.connect} else 0 end)`

/**
 * Paid and completed earns; cancelled or expired unpaid releases, and so does
 * a paid one that never went ahead (cancelled, expired, or a late payment
 * held for review) once its money all came back or when nothing was due;
 * anything where the money is unclear
 * (paid then cancelled without a full refund, a payment under review, handed
 * over without a recorded payment) waits for an operator.
 *
 * An unpaid order whose payment page can still take the discounted total
 * keeps its reward held until the page closes: a late payment then goes to
 * review with the reward, instead of the guest keeping the discount and the
 * points.
 */
export function restaurantOrderVerdict(
	order: RestaurantOrder,
	redemption: RedemptionRow | null,
	now: number,
): LoyaltySourceVerdict {
	const paid = order.paymentStatus === 'paid'
	const stopped =
		order.status === 'cancelled' ||
		order.status === 'expired' ||
		order.status === 'payment_review'
	// Paid, never fulfilled and every cent back (or none was due, the reward
	// covered it all): nothing is left for an operator to decide.
	if (stopped && paid && order.refundedCents >= order.totalCents) {
		return { kind: 'cancelled', releaseReason: 'order_refunded' }
	}
	if (order.paymentStatus === 'review' || order.status === 'payment_review') {
		return { kind: 'review', reason: 'payment_uncertain' }
	}
	if (order.status === 'cancelled' || order.status === 'expired') {
		if (paid) return { kind: 'review', reason: 'payment_uncertain' }
		const payableUntil = restaurantOrderPayableUntil(order)
		if (
			redemption &&
			redemptionHoldsPoints(redemption.state) &&
			payableUntil !== null &&
			now < payableUntil
		) {
			return { kind: 'open' }
		}
		return {
			kind: 'cancelled',
			releaseReason:
				order.status === 'expired' ? 'payment_expired' : 'order_cancelled',
		}
	}
	if (order.status !== 'completed') return { kind: 'open' }
	if (!paid) return { kind: 'review', reason: 'completed_unpaid' }
	const occurredAt =
		Math.max(ms(order.completedAt), ms(order.paidAt)) ||
		ms(order.updatedAt) ||
		now
	const split = discountSplit(order.loyaltyDiscountCents, redemption)
	return {
		kind: 'completed',
		occurredAt,
		receivedAt: null,
		snapshot: buildPurchaseSnapshot({
			currency: order.currency,
			totalPaidMinor: order.totalCents,
			taxMinor: order.taxCents,
			taxInclusive: orderTaxInclusive(order),
			lines: snapshotLines(storedLines(order)),
			allocation: split.allocation,
			otherDiscountMinor: split.otherDiscountMinor,
		}),
		loyaltyDiscountMinor: order.loyaltyDiscountCents,
		releaseReason: null,
	}
}

/** A reward still held on an online order that never went ahead. */
function heldOnUnpaidOnlineOrder() {
	return and(
		eq(loyaltyRedemptions.sourceType, 'restaurant_order'),
		inArray(loyaltyRedemptions.state, ['reserved', 'bound']),
		eq(restaurantOrders.paymentMethod, 'online'),
		inArray(restaurantOrders.status, ['cancelled', 'expired']),
		ne(restaurantOrders.paymentStatus, 'paid'),
	)
}

/**
 * Not waiting in the outbox already, or parked there for an operator:
 * queueing again would reset its attempts, so it would never park.
 */
function notQueued(db: LoyaltyReader) {
	return notExists(
		db
			.select({ one: sql`1` })
			.from(loyaltyOutbox)
			.where(
				and(
					eq(loyaltyOutbox.sourceType, 'restaurant_order'),
					eq(loyaltyOutbox.sourceId, loyaltyRedemptions.sourceId),
					inArray(loyaltyOutbox.status, ['pending', 'failed']),
				),
			),
	)
}

export const restaurantOrderLoyaltySource: LoyaltySourceAdapter = {
	type: 'restaurant_order',
	async read(db, sourceId, { redemption, now }) {
		const order = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, sourceId))
			.get()
		// A tab's rounds are part of the tab's purchase, never their own.
		if (!order || order.tabId) return null
		return {
			currency: order.currency,
			totalMinor: order.totalCents,
			refundedMinor: order.refundedCents,
			locationId: order.locationId,
			verdict: restaurantOrderVerdict(order, redemption, now),
		}
	},
	timed: {
		/** Orders whose payment page closed while their reward was still held. */
		async due(db, now, limit) {
			const rows = await db
				.select({ id: restaurantOrders.id })
				.from(loyaltyRedemptions)
				.innerJoin(
					restaurantOrders,
					eq(restaurantOrders.id, loyaltyRedemptions.sourceId),
				)
				.where(
					and(
						heldOnUnpaidOnlineOrder(),
						lte(payableUntilSql, now),
						notQueued(db),
					),
				)
				.orderBy(asc(payableUntilSql))
				.limit(limit)
				.all()
			return rows.map((row) => row.id)
		},
		/** The next hold to lapse under a reward, or the next page to close. */
		async nextDueAt(db) {
			const [lapse, close] = await Promise.all([
				db
					.select({
						at: sql<
							number | null
						>`min(${restaurantOrders.holdExpiresAt}) * 1000`,
					})
					.from(loyaltyRedemptions)
					.innerJoin(
						restaurantOrders,
						eq(restaurantOrders.id, loyaltyRedemptions.sourceId),
					)
					.where(
						and(
							eq(loyaltyRedemptions.sourceType, 'restaurant_order'),
							inArray(loyaltyRedemptions.state, ['reserved', 'bound']),
							eq(restaurantOrders.paymentMethod, 'online'),
							eq(restaurantOrders.status, 'accepted'),
							eq(restaurantOrders.paymentStatus, 'pending'),
						),
					)
					.get(),
				db
					.select({ at: sql<number | null>`min(${payableUntilSql})` })
					.from(loyaltyRedemptions)
					.innerJoin(
						restaurantOrders,
						eq(restaurantOrders.id, loyaltyRedemptions.sourceId),
					)
					.where(and(heldOnUnpaidOnlineOrder(), notQueued(db)))
					.get(),
			])
			const due = [lapse?.at, close?.at]
				.map((value) =>
					value === null || value === undefined ? null : Number(value),
				)
				.filter(
					(value): value is number => value !== null && Number.isFinite(value),
				)
			return due.length > 0 ? Math.min(...due) : null
		},
	},
}

function liveRound(round: RestaurantOrder): boolean {
	return !(QR_ROUND_VOID_STATUSES as readonly string[]).includes(round.status)
}

/** The most lines a loyalty cart holds, and the most units on one (`loyaltyCartSchema`). */
export const LOYALTY_CART_MAX_LINES = 200
export const LOYALTY_CART_MAX_LINE_QUANTITY = 1000

/**
 * The tab's counting round lines in cart groups. A tab that fits the cart's
 * line cap keeps one group per line. A longer one merges lines that are the
 * same to a reward (item, variant, categories and both prices), so quantities
 * add (a group holds at most the cart's per-line quantity); the group is named
 * by its first line's id.
 */
function tabCartGroups(
	rounds: readonly RestaurantOrder[],
): LoyaltyCartLine[][] {
	const lines = rounds
		.filter(liveRound)
		.flatMap((round) => restaurantCartLines(storedLines(round), round.id))
	if (lines.length <= LOYALTY_CART_MAX_LINES) return lines.map((line) => [line])
	const groups: LoyaltyCartLine[][] = []
	const open = new Map<string, { group: LoyaltyCartLine[]; quantity: number }>()
	for (const line of lines) {
		const key = JSON.stringify([
			line.itemId,
			line.variantId,
			[...line.categoryIds].sort(),
			line.unitBaseMinor,
			line.unitMinor,
		])
		const current = open.get(key)
		if (
			current &&
			current.quantity + line.quantity <= LOYALTY_CART_MAX_LINE_QUANTITY
		) {
			current.group.push(line)
			current.quantity += line.quantity
		} else {
			const group = [line]
			groups.push(group)
			open.set(key, { group, quantity: line.quantity })
		}
	}
	return groups
}

/** The tab's counting rounds as one cart: what a reward on the tab is quoted on. */
export function tabCartLines(
	rounds: readonly RestaurantOrder[],
): LoyaltyCartLine[] {
	return tabCartGroups(rounds).map((group) =>
		group.length === 1
			? group[0]!
			: {
					...group[0]!,
					quantity: group.reduce((sum, line) => sum + line.quantity, 0),
				},
	)
}

/**
 * A reward allocation made on the tab's cart, spelled over the tab's own lines:
 * a merged group's share is spread over its lines in order, each up to what its
 * units cost, so totals and the purchase snapshot find every line by id.
 */
export function expandTabAllocation<
	T extends { lineId: string; discountMinor: number; rewardUnits?: number },
>(rounds: readonly RestaurantOrder[], allocation: readonly T[]): T[] {
	const merged = new Map<string, LoyaltyCartLine[]>()
	for (const group of tabCartGroups(rounds)) {
		if (group.length > 1) merged.set(group[0]!.lineId, group)
	}
	if (merged.size === 0) return [...allocation]
	return allocation.flatMap((entry) => {
		const group = merged.get(entry.lineId)
		if (!group) return [entry]
		let discountLeft = entry.discountMinor
		let unitsLeft = entry.rewardUnits ?? 0
		const spread = group.map((line, index) => {
			const last = index === group.length - 1
			const discountMinor = last
				? discountLeft
				: Math.min(discountLeft, line.unitMinor * line.quantity)
			const rewardUnits = last ? unitsLeft : Math.min(unitsLeft, line.quantity)
			discountLeft -= discountMinor
			unitsLeft -= rewardUnits
			return {
				...entry,
				lineId: line.lineId,
				discountMinor,
				...(entry.rewardUnits === undefined ? {} : { rewardUnits }),
			}
		})
		return spread.filter(
			(share) => share.discountMinor > 0 || (share.rewardUnits ?? 0) > 0,
		)
	})
}

export function tabLoyaltyCart(
	tab: Pick<QrTabRow, 'currency'>,
	rounds: readonly RestaurantOrder[],
): LoyaltyCart {
	return {
		currency: tab.currency,
		lines: tabCartLines(rounds),
		otherDiscountMinor: 0,
	}
}

/**
 * A tab earns once, when it settles. Paid from the phone it also spends its
 * reward; closed at the counter the reward is given back (rewards apply to a
 * tab only when it is paid from the phone), and when the counter rang it up on
 * a till the till sale earns instead of the tab.
 */
export async function qrTabVerdict(
	db: LoyaltyReader,
	tab: QrTabRow,
	redemption: RedemptionRow | null,
	now: number,
): Promise<LoyaltySourceVerdict> {
	if (tab.status === 'open') return { kind: 'open' }
	if (tab.status === 'cancelled') {
		return { kind: 'cancelled', releaseReason: 'tab_voided' }
	}
	if (tab.rungUpOnStation) {
		return {
			kind: 'excluded',
			reason: 'rung_up_on_station',
			releaseReason: 'counter_close',
		}
	}
	if (tab.paymentStatus === 'review') {
		return { kind: 'review', reason: 'payment_uncertain' }
	}
	if (tab.paymentStatus !== 'paid') {
		return { kind: 'review', reason: 'completed_unpaid' }
	}
	const rounds = (await listTabRounds(db, [tab.id])).filter(liveRound)
	const online = tab.paymentMethod === 'online'
	const saleDiscount = online ? tab.loyaltyDiscountCents : 0
	const split = discountSplit(saleDiscount, redemption)
	if (split.allocation) {
		split.allocation = expandTabAllocation(rounds, split.allocation)
	}
	const totals = tabTotals(tab, rounds, { useSnapshot: true })
	return {
		kind: 'completed',
		occurredAt: tab.paidAt ?? tab.closedAt ?? tab.updatedAt ?? now,
		receivedAt: null,
		snapshot: buildPurchaseSnapshot({
			currency: tab.currency,
			totalPaidMinor: tab.totalCents,
			taxMinor: tab.taxCents,
			taxInclusive: totals.taxInclusive,
			lines: rounds.flatMap((round) =>
				snapshotLines(storedLines(round), round.id),
			),
			allocation: split.allocation,
			otherDiscountMinor: split.otherDiscountMinor,
		}),
		loyaltyDiscountMinor: saleDiscount,
		// Paid from the phone without the discount (a reward an earlier, still
		// payable page carried): the member keeps the points.
		releaseReason: !online
			? 'counter_close'
			: saleDiscount === 0
				? 'reward_not_used'
				: null,
	}
}

export const qrTabLoyaltySource: LoyaltySourceAdapter = {
	type: 'qr_tab',
	async read(db, sourceId, { redemption, now }) {
		const tab = await db
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, sourceId))
			.get()
		if (!tab) return null
		// A tab's refunds are recorded through loyalty, one row each.
		const refunded = await db
			.select({
				total: sql<number>`coalesce(sum(${loyaltyRefunds.amountMinor}), 0)`,
			})
			.from(loyaltyRefunds)
			.where(
				and(
					eq(loyaltyRefunds.sourceType, 'qr_tab'),
					eq(loyaltyRefunds.sourceId, sourceId),
				),
			)
			.get()
		return {
			currency: tab.currency,
			totalMinor: tab.totalCents,
			refundedMinor: Number(refunded?.total ?? 0),
			locationId: tab.locationId,
			verdict: await qrTabVerdict(db, tab, redemption, now),
		}
	},
}
