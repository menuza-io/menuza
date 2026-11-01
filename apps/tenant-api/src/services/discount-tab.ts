import type { PricedOrderLine } from '@repo/common/restaurant-orders'
import type { RestaurantOrderContext } from '@repo/common/restaurant-orders'
import type { OrderDiscountsRequest } from '@repo/discounts'
import {
	discountPeriodKeys,
	evaluateDiscounts,
	localNowString,
	type DiscountCartLine,
	type DiscountEvaluation,
} from '@repo/discounts'
import {
	discountRedemptions,
	type RestaurantOrder,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, inArray, isNotNull, like, or, sql } from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'
import { isDiscountsKillSwitchOn } from '../lib/discount-switches.ts'
import { discountedTabTotals } from '../restaurant/loyalty-checkout.ts'
import { restaurantLineId } from '../restaurant/loyalty-sources.ts'
import { codesWithIssuedCode } from './discount-marketing-codes.ts'
import { QR_ROUND_VOID_STATUSES } from './qr-dine-in.ts'
import {
	discountCustomerFacts,
	loadDiscountUsageCounts,
	type DiscountApplyFailure,
	publicRefusalReason,
	type PreparedDiscounts,
} from './discount-apply.ts'

type DiscountDb = TenantDatabase | TenantTransaction

export type TabDiscountQuote = {
	prepared: PreparedDiscounts
	/** Line ids are `roundId:index`, the same ids loyalty uses. */
	allocation: { lineId: string; discountMinor: number }[]
	discountCents: number
}

/**
 * Prices automatic discounts and an optional code against a tab's rounds.
 * Rounds themselves never carry a discount; this runs when the guest pays.
 * A refused code is a failure. An empty result means nothing applied.
 */
export async function evaluateTabDiscounts(
	db: DiscountDb,
	input: {
		context: RestaurantOrderContext
		rounds: readonly RestaurantOrder[]
		locationId: string
		customerId: string | null
		/** Undefined: the client did not ask for discounts, so none apply. */
		discounts: OrderDiscountsRequest | undefined
		now: Date
		/** The tab being priced: its own earlier reservations never count against it. */
		tabId?: string
	},
): Promise<
	| { ok: true; quote: TabDiscountQuote | null }
	| { ok: false; failure: DiscountApplyFailure }
> {
	const killed = isDiscountsKillSwitchOn()
	const typedCode = input.discounts?.code ?? null
	if (killed) {
		if (typedCode) {
			return {
				ok: false,
				failure: {
					status: 503,
					code: 'discounts_disabled',
					message: 'Discounts are not available right now.',
				},
			}
		}
		return { ok: true, quote: null }
	}
	// Like an order: a client that sent no `discounts` field did not ask, so
	// nothing applies and its total stays what it was shown. The tab view,
	// counter close and the Sites pay request all ask (an empty object asks for
	// the automatic discounts alone).
	if (!input.discounts) return { ok: true, quote: null }
	const features = input.context.discounts?.features
	const automatic = features?.automatic === true
	const coupons = features?.coupons === true
	// A typed code is always evaluated, even with coupons off (then against an
	// empty code list), so it is refused like on web instead of silently ignored.
	if (!automatic && !typedCode) {
		return { ok: true, quote: null }
	}
	const records = (input.context.discounts?.discounts ?? []).filter(
		(record) => {
			if (record.application === 'automatic') return automatic
			if (record.application === 'code') return coupons
			return false
		},
	)
	if (records.length === 0 && !typedCode) return { ok: true, quote: null }

	const location = input.context.menu.locations.find(
		(entry) => entry.id === input.locationId,
	)
	const lines = tabLines(input.rounds)
	const localNow = localNowString(
		input.now.getTime(),
		location?.timezone || 'UTC',
	)
	const periods = discountPeriodKeys(localNow)
	const customer = await discountCustomerFacts(db, input.customerId, input.now)
	const { usage, codeUsage } = await loadDiscountUsageCounts(
		db,
		records.map((record) => record.id),
		customer.customerId,
		periods,
		input.now,
		{ ignoreTabId: input.tabId },
	)
	const codes = coupons
		? await codesWithIssuedCode(
				db,
				input.context.discounts?.codes ?? [],
				typedCode,
				input.now,
			)
		: []
	const evaluation = evaluateDiscounts({
		currency: location?.currency || input.context.menu.organization.currency,
		lines,
		context: {
			channel: 'qr',
			fulfillment: 'dine_in',
			locationId: input.locationId,
			isDrop: false,
			localNow,
			deliveryFeeMinor: 0,
			customer: {
				signedIn: customer.signedIn,
				isNewCustomer: customer.isNewCustomer,
				isLoyaltyMember: customer.isLoyaltyMember,
			},
		},
		discounts: records,
		codes,
		usage,
		codeUsage,
		code: typedCode,
	})
	const refused = refusedCode(typedCode, evaluation)
	if (refused) return { ok: false, failure: refused }
	if (evaluation.applied.length === 0) return { ok: true, quote: null }
	const allocation = Object.entries(evaluation.lineDiscounts).map(
		([lineId, discountMinor]) => ({ lineId, discountMinor }),
	)
	return {
		ok: true,
		quote: {
			prepared: { evaluation, typedCode, periods, records, codes },
			allocation,
			discountCents: evaluation.totalDiscountMinor,
		},
	}
}

function refusedCode(
	typedCode: string | null,
	evaluation: DiscountEvaluation,
): DiscountApplyFailure | null {
	if (!typedCode || !evaluation.code || evaluation.code.status === 'applied') {
		return null
	}
	if (evaluation.code.status === 'replaced') {
		return {
			status: 409,
			code: 'discount_changed',
			message:
				'Your discount changed. Review the new total and place the order again.',
		}
	}
	return {
		status: 409,
		code: 'coupon_refused',
		message: 'That coupon code could not be applied.',
		reason: publicRefusalReason(evaluation.code.reason),
	}
}

function tabLines(rounds: readonly RestaurantOrder[]) {
	const lines: DiscountCartLine[] = []
	for (const round of rounds) {
		if ((QR_ROUND_VOID_STATUSES as readonly string[]).includes(round.status)) {
			continue
		}
		const stored = Array.isArray(round.lines)
			? (round.lines as PricedOrderLine[])
			: []
		stored.forEach((line, index) => {
			lines.push({
				lineId: restaurantLineId(index, round.id),
				itemId: line.itemId,
				variantId: line.variantId,
				categoryIds: line.categoryIds ?? [],
				quantity: line.quantity,
				unitMinor: line.unitPriceCents,
				// Rounds stored before modifier detail carry neither field.
				baseUnitMinor: line.baseUnitCents,
				variantNames: line.variantNames,
				options: (line.options ?? []).map((option) => ({
					groupId: option.groupId,
					optionId: option.optionId,
					quantity: option.quantity,
					totalMinor: option.totalCents,
				})),
				excluded: line.excludeFromDiscounts === true,
			})
		})
	}
	return lines
}

/** One payment attempt is its own source, so a released try can be replaced. */
export function tabDiscountSourceId(tabId: string, at: number): string {
	return `${tabId}:${at}`
}

function tabSourceMatch(tabId: string) {
	return or(
		eq(discountRedemptions.sourceId, tabId),
		like(discountRedemptions.sourceId, `${tabId}:%`),
	)
}

/** The code on a tab's reserved redemption, if the guest typed one. */
export async function tabReservedCode(
	db: DiscountDb,
	tabId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ code: discountRedemptions.normalizedCode })
		.from(discountRedemptions)
		.where(
			and(
				eq(discountRedemptions.sourceType, 'tab'),
				tabSourceMatch(tabId),
				eq(discountRedemptions.state, 'reserved'),
				// An automatic discount's row has no code; only a typed one counts.
				isNotNull(discountRedemptions.normalizedCode),
			),
		)
		.limit(1)
	return row?.code ?? null
}

export async function releaseTabDiscounts(
	db: DiscountDb,
	tabId: string,
): Promise<void> {
	await db
		.update(discountRedemptions)
		.set({ state: 'released', updatedAt: Date.now() })
		.where(
			and(
				eq(discountRedemptions.sourceType, 'tab'),
				eq(discountRedemptions.state, 'reserved'),
				tabSourceMatch(tabId),
			),
		)
}

export async function consumeTabDiscounts(
	db: DiscountDb,
	tabId: string,
): Promise<void> {
	await db
		.update(discountRedemptions)
		.set({ state: 'consumed', updatedAt: Date.now() })
		.where(
			and(
				eq(discountRedemptions.sourceType, 'tab'),
				eq(discountRedemptions.state, 'reserved'),
				tabSourceMatch(tabId),
			),
		)
}

/** Reserved or consumed discount rows for one tab, as a line allocation. */
export async function tabDiscountAllocation(
	db: DiscountDb,
	tabId: string,
): Promise<{ lineId: string; discountMinor: number }[]> {
	const rows = await db
		.select({
			allocation: discountRedemptions.allocation,
		})
		.from(discountRedemptions)
		.where(
			and(
				eq(discountRedemptions.sourceType, 'tab'),
				tabSourceMatch(tabId),
				inArray(discountRedemptions.state, ['reserved', 'consumed']),
			),
		)
	const byLine = new Map<string, number>()
	for (const row of rows) {
		for (const line of row.allocation ?? []) {
			byLine.set(line.lineId, (byLine.get(line.lineId) ?? 0) + line.amountMinor)
		}
	}
	return [...byLine.entries()].map(([lineId, discountMinor]) => ({
		lineId,
		discountMinor,
	}))
}

/**
 * What a tab costs after its discounts, before any tip: the rounds' tax
 * shrinks with the taxable base the discounts took off, and the total is the
 * rounds' total less the discounts (and the tax they removed on an exclusive
 * menu). Null when the allocation names a line the tab no longer has.
 */
export function tabPricedWithDiscounts(
	rounds: readonly RestaurantOrder[],
	allocation: readonly { lineId: string; discountMinor: number }[],
): { discountCents: number; taxCents: number; billCents: number } | null {
	const priced = discountedTabTotals(rounds, allocation)
	if (!priced) return null
	return {
		discountCents: priced.loyaltyDiscountCents,
		taxCents: priced.taxCents,
		billCents: priced.totalCents,
	}
}

/**
 * What each tab's discounts took off, in minor units, from the reserved or
 * consumed rows of every attempt (`<tabId>` or `<tabId>:...`). One query for
 * any number of tabs.
 */
export async function tabDiscountAmounts(
	db: DiscountDb,
	tabIds: readonly string[],
	states: readonly ('reserved' | 'consumed')[] = ['reserved', 'consumed'],
): Promise<Map<string, number>> {
	const totals = new Map<string, number>()
	if (tabIds.length === 0) return totals
	const tabOf = sql<string>`substr(${discountRedemptions.sourceId}, 1, instr(${discountRedemptions.sourceId} || ':', ':') - 1)`
	const rows = await db
		.select({
			tabId: tabOf,
			amountMinor: discountRedemptions.amountMinor,
		})
		.from(discountRedemptions)
		.where(
			and(
				eq(discountRedemptions.sourceType, 'tab'),
				// bounded: at most the two counting states
				inArray(discountRedemptions.state, [...states]),
				inJsonList(tabOf, tabIds),
			),
		)
	for (const row of rows) {
		totals.set(row.tabId, (totals.get(row.tabId) ?? 0) + row.amountMinor)
	}
	return totals
}
