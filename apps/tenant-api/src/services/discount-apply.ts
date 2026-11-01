import { applyOrderDiscounts } from '@repo/common/restaurant-orders'
import type {
	PricedRestaurantOrder,
	RestaurantOrderContext,
} from '@repo/common/restaurant-orders'
import type { OrderDiscountsRequest } from '@repo/discounts'
import {
	type DiscountChannel,
	type DiscountEvaluation,
	type DiscountQuote,
	type DiscountRecord,
	type DiscountRefusalReason,
	type DiscountUsage,
	discountPeriodKeys,
	evaluateDiscounts,
	localNowString,
} from '@repo/discounts'
import {
	discountRedemptions,
	posOrders,
	qrTabs,
	restaurantOrders,
	type OrderDiscountSnapshot,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import {
	and,
	count,
	eq,
	gte,
	inArray,
	lte,
	not,
	or,
	sql,
	sum,
} from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'
import { codesWithIssuedCode } from './discount-marketing-codes.ts'
import { memberForCustomerInTx } from './loyalty-member-service.ts'
import { QR_TAB_SESSION_HOLD_MS } from './qr-dine-in.ts'

type DiscountDb = TenantDatabase | TenantTransaction

const COUNTING_STATES = ['reserved', 'consumed'] as const

/**
 * How long a pay-at-pickup order that was never completed or cancelled keeps
 * its reserved use against a limit, counted from its scheduled time (or its
 * creation when ASAP). Nothing sweeps those orders, so without a bound a
 * no-show would hold a total-limited or per-customer use for ever. After this
 * the use stops counting; the order itself is not touched.
 */
export const DISCOUNT_RESERVED_COUNT_MAX_MS = 24 * 60 * 60 * 1000

/** Suffix of the use re-recorded for a sale that was paid after its use was given back. */
const LATE_SOURCE_SUFFIX = ':late'

/** These refusals prove a typed code exists. Guests only hear that it was not found. */
const HIDDEN_REFUSAL_REASONS = new Set<DiscountRefusalReason>([
	'wrong_channel',
	'not_started',
	'expired',
	'not_available_now',
	'wrong_location',
	'wrong_fulfillment',
	'wrong_drop',
])

export function publicRefusalReason(
	reason: DiscountRefusalReason,
): DiscountRefusalReason {
	return HIDDEN_REFUSAL_REASONS.has(reason) ? 'not_found' : reason
}

export type DiscountApplyFailure = {
	status: number
	code:
		| 'discounts_disabled'
		| 'discounts_on_tab'
		| 'discount_changed'
		| 'coupon_refused'
	message: string
	quote?: DiscountQuote
	reason?: string
}

export type PreparedDiscounts = {
	evaluation: DiscountEvaluation
	/** Null when nothing was typed. */
	typedCode: string | null
	periods: { day: string; week: string }
	records: readonly DiscountRecord[]
	/** The coupon codes the evaluation saw (a code's `maxUses` is kept on its use). */
	codes: readonly { id: string; maxUses: number | null }[]
}

/** Refusals the customer can fix by changing the cart, so they are not probes. */
const FIXABLE_COUPON_REASONS = new Set<DiscountRefusalReason>([
	'minimum_not_met',
	'quantity_not_met',
])

/**
 * Whether a typed code on a read-only quote (loyalty checkout quote, etc.)
 * should charge the org coupon guess budget.
 */
export function couponOutcomeCountsAsGuess(
	prepared: PreparedDiscounts | null,
	codeSent: string | null | undefined,
): boolean {
	if (!codeSent?.trim()) return false
	if (!prepared) return false
	const coupon = prepared.evaluation.code
	if (!coupon) return true
	if (coupon.status === 'applied') return false
	if (coupon.status === 'replaced') return true
	if (coupon.status === 'refused') {
		return !FIXABLE_COUPON_REASONS.has(publicRefusalReason(coupon.reason))
	}
	return false
}

/**
 * Prices the discounts on an already-priced order. Quote mode always comes
 * back with an evaluation (a refused code is part of the answer). Place mode
 * is the same evaluation; the caller compares it with what the customer was
 * shown after loyalty has been applied on top.
 */
export async function prepareOrderDiscounts(
	db: DiscountDb,
	input: {
		priced: PricedRestaurantOrder
		context: RestaurantOrderContext
		discounts: OrderDiscountsRequest | undefined
		fulfillment: 'pickup' | 'delivery' | 'dine_in'
		source: 'qr_poster' | 'qr_table' | null
		customerId: string | null
		now: Date
		killed: boolean
		/**
		 * Evaluate automatic discounts even when the request omitted
		 * `discounts`. Placement leaves this off so an older checkout, which
		 * never sends the field, keeps the total it showed.
		 */
		applyAutomatic?: boolean
	},
): Promise<
	| { ok: true; prepared: PreparedDiscounts | null }
	| { ok: false; failure: DiscountApplyFailure }
> {
	const { priced, discounts, killed } = input
	const typedCode = discounts?.code ?? null
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
		return { ok: true, prepared: null }
	}
	if (input.fulfillment === 'dine_in') {
		if (discounts) {
			return {
				ok: false,
				failure: {
					status: 409,
					code: 'discounts_on_tab',
					message: 'Discounts cannot be used on a table tab yet.',
				},
			}
		}
		return { ok: true, prepared: null }
	}
	// A checkout that never asked about discounts keeps the price it showed.
	if (!discounts && !input.applyAutomatic) return { ok: true, prepared: null }

	const features = input.context.discounts?.features
	const records = (input.context.discounts?.discounts ?? []).filter(
		(record) => {
			if (record.application === 'automatic')
				return features?.automatic === true
			if (record.application === 'code') return features?.coupons === true
			return false
		},
	)
	const codes =
		features?.coupons === true
			? await codesWithIssuedCode(
					db,
					input.context.discounts?.codes ?? [],
					typedCode,
					input.now,
				)
			: []
	const localNow = discountLocalNow(priced, input.now)
	const periods = discountPeriodKeys(localNow)
	const customer = await discountCustomerFacts(db, input.customerId, input.now)
	const { usage, codeUsage } = await loadDiscountUsageCounts(
		db,
		records.map((record) => record.id),
		customer.customerId,
		periods,
		input.now,
	)
	const evaluation = evaluateDiscounts({
		currency: priced.currency,
		lines: priced.lines.map((line, index) => ({
			lineId: String(index),
			itemId: line.itemId,
			variantId: line.variantId,
			categoryIds: line.categoryIds,
			quantity: line.quantity,
			unitMinor: line.unitPriceCents,
			baseUnitMinor: line.baseUnitCents,
			variantNames: line.variantNames,
			options: line.options.map((option) => ({
				groupId: option.groupId,
				optionId: option.optionId,
				quantity: option.quantity,
				totalMinor: option.totalCents,
			})),
			excluded: line.excludeFromDiscounts === true,
		})),
		context: {
			channel: discountChannel(input.fulfillment, input.source),
			fulfillment: input.fulfillment,
			locationId: priced.location.id,
			isDrop: priced.drop !== null,
			localNow,
			deliveryFeeMinor:
				input.fulfillment === 'delivery' ? priced.deliveryFeeCents : 0,
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
	return {
		ok: true,
		prepared: { evaluation, typedCode, periods, records, codes },
	}
}

/**
 * The wall clock the schedule, `startsAt` and `endsAt` are judged at: the
 * time the food is wanted, not the time the order is typed. A pre-order made
 * at 6pm for 4pm tomorrow gets tomorrow's 4pm rules. A scheduled order uses
 * its `scheduledFor`, a drop order its pickup slot, and ASAP orders now.
 */
export function discountLocalNow(
	priced: Pick<
		PricedRestaurantOrder,
		'scheduledFor' | 'pickup' | 'drop' | 'location'
	>,
	now: Date,
): string {
	const timezone = priced.location.timezone
	if (priced.scheduledFor) {
		const at = Date.parse(priced.scheduledFor)
		if (Number.isFinite(at)) return localNowString(at, timezone)
	}
	const pickup = priced.pickup
	if (
		priced.drop &&
		pickup &&
		/^\d{4}-\d{2}-\d{2}$/.test(pickup.date) &&
		/^\d{2}:\d{2}$/.test(pickup.time)
	) {
		return `${pickup.date}T${pickup.time}`
	}
	return localNowString(now.getTime(), timezone)
}

function discountChannel(
	fulfillment: 'pickup' | 'delivery' | 'dine_in',
	source: 'qr_poster' | 'qr_table' | null,
): DiscountChannel {
	if (
		fulfillment === 'dine_in' ||
		source === 'qr_poster' ||
		source === 'qr_table'
	) {
		return 'qr'
	}
	return 'web'
}

/**
 * An unpaid online hold whose time has run out. The next placement sweeps it
 * to `expired`, so for every count it already no longer happened. Quotes do
 * not sweep, so the counts below skip these rows to give the same answer.
 */
function lapsedHold(now: Date) {
	return and(
		eq(restaurantOrders.paymentMethod, 'online'),
		eq(restaurantOrders.status, 'accepted'),
		eq(restaurantOrders.paymentStatus, 'pending'),
		sql`${restaurantOrders.holdExpiresAt} is not null and ${restaurantOrders.holdExpiresAt} < ${Math.floor(now.getTime() / 1000)}`,
	)
}

export async function discountCustomerFacts(
	db: DiscountDb,
	customerId: string | null,
	now: Date = new Date(),
): Promise<{
	customerId: string | null
	signedIn: boolean
	isNewCustomer: boolean
	isLoyaltyMember: boolean
}> {
	if (!customerId) {
		return {
			customerId: null,
			signedIn: false,
			isNewCustomer: false,
			isLoyaltyMember: false,
		}
	}
	const [prior] = await db
		.select({ id: restaurantOrders.id })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.customerId, customerId),
				inArray(restaurantOrders.status, [
					'accepted',
					'preparing',
					'ready',
					'completed',
					'payment_review',
				]),
				// A lapsed unpaid hold is not a first order.
				not(lapsedHold(now)!),
			),
		)
		.limit(1)
	const member = await memberForCustomerInTx(db, customerId)
	return {
		customerId,
		signedIn: true,
		isNewCustomer: !prior,
		isLoyaltyMember: member?.status === 'active',
	}
}

/**
 * A reserved use of an online order that no longer counts: a lapsed unpaid
 * hold (the sweep gives it back), or an order still sitting at accepted,
 * preparing or ready (a pay-at-pickup no-show) more than
 * `DISCOUNT_RESERVED_COUNT_MAX_MS` after its scheduled time, or its creation
 * when it is ASAP. Only the count changes; the order and the row stay as they
 * are. Consumed uses always count. A payment_review order is a paid sale, so
 * its use counts until an operator decides.
 */
function staleReservedUse(now: Date) {
	const cutoff = Math.floor(
		(now.getTime() - DISCOUNT_RESERVED_COUNT_MAX_MS) / 1000,
	)
	// A tab's attempt is reserved before its provider session exists, and no
	// sweep gives it back. Once the tab is still unpaid and its payment event
	// is older than the session hold, the attempt was abandoned: it stops
	// counting (the row itself is released by the tab's next pay request).
	const tabCutoff = now.getTime() - QR_TAB_SESSION_HOLD_MS
	return sql`(${discountRedemptions.state} = 'reserved' and (
		(${restaurantOrders.id} is not null and (
			(${lapsedHold(now)})
			or (${restaurantOrders.status} in ('accepted', 'preparing', 'ready')
				and coalesce(${restaurantOrders.scheduledFor}, ${restaurantOrders.createdAt}, 0) < ${cutoff})
		))
		or (${qrTabs.id} is not null
			and ${qrTabs.paymentStatus} != 'paid'
			and coalesce(${qrTabs.paymentEventAt}, ${discountRedemptions.createdAt}, 0) < ${tabCutoff})
	))`
}

export async function loadDiscountUsageCounts(
	db: DiscountDb,
	discountIds: readonly string[],
	customerId: string | null,
	periods: { day: string; week: string },
	now: Date = new Date(),
	/**
	 * A tab whose own earlier attempts must not count against it, so a quote
	 * of the tab and the close that follows it agree whatever its own stale
	 * reservations say.
	 */
	options: { ignoreTabId?: string } = {},
): Promise<{
	usage: Record<string, DiscountUsage>
	codeUsage: Record<string, number>
}> {
	const usage: Record<string, DiscountUsage> = {}
	const codeUsage: Record<string, number> = {}
	if (discountIds.length === 0) return { usage, codeUsage }
	const rows = await db
		.select({
			discountId: discountRedemptions.discountId,
			customerId: discountRedemptions.customerId,
			localDay: discountRedemptions.localDay,
			localWeek: discountRedemptions.localWeek,
			codeId: discountRedemptions.codeId,
			n: count(),
		})
		.from(discountRedemptions)
		.leftJoin(
			restaurantOrders,
			and(
				eq(discountRedemptions.sourceType, 'order'),
				eq(discountRedemptions.sourceId, restaurantOrders.id),
			),
		)
		.leftJoin(
			qrTabs,
			and(
				eq(discountRedemptions.sourceType, 'tab'),
				sql`${qrTabs.id} = substr(${discountRedemptions.sourceId}, 1, instr(${discountRedemptions.sourceId} || ':', ':') - 1)`,
			),
		)
		.where(
			and(
				inJsonList(discountRedemptions.discountId, discountIds),
				inArray(discountRedemptions.state, [...COUNTING_STATES]),
				not(staleReservedUse(now)),
				options.ignoreTabId
					? not(
							and(
								eq(discountRedemptions.sourceType, 'tab'),
								sql`substr(${discountRedemptions.sourceId}, 1, instr(${discountRedemptions.sourceId} || ':', ':') - 1) = ${options.ignoreTabId}`,
							)!,
						)
					: undefined,
			),
		)
		.groupBy(
			discountRedemptions.discountId,
			discountRedemptions.customerId,
			discountRedemptions.localDay,
			discountRedemptions.localWeek,
			discountRedemptions.codeId,
		)
	for (const row of rows) {
		const n = Number(row.n)
		const current = usage[row.discountId] ?? {
			total: 0,
			customerLifetime: 0,
			customerDay: 0,
			customerWeek: 0,
		}
		current.total += n
		if (customerId && row.customerId === customerId) {
			current.customerLifetime += n
			if (row.localDay === periods.day) current.customerDay += n
			if (row.localWeek === periods.week) current.customerWeek += n
		}
		usage[row.discountId] = current
		if (row.codeId) codeUsage[row.codeId] = (codeUsage[row.codeId] ?? 0) + n
	}
	return { usage, codeUsage }
}

/** The quote body, after loyalty has been applied on what discounts left. */
export function buildDiscountQuote(input: {
	priced: PricedRestaurantOrder
	prepared: PreparedDiscounts | null
	loyaltyDiscountMinor: number
	taxMinor: number
	totalMinor: number
	couponsEnabled?: boolean
}): DiscountQuote {
	const evaluation = input.prepared?.evaluation
	const typedCode = input.prepared?.typedCode ?? null
	const coupon = evaluation?.code ?? null
	return {
		currency: input.priced.currency,
		subtotalMinor: input.priced.subtotalCents,
		discounts: (evaluation?.applied ?? []).map((applied) => ({
			discountId: applied.discountId,
			version: applied.version,
			name: applied.name,
			code: applied.codeId ? typedCode : null,
			amountMinor: applied.amountMinor,
			deliveryAmountMinor: applied.deliveryAmountMinor,
			lineIds: applied.lines.map((line) => line.lineId),
		})),
		totalDiscountMinor: evaluation?.totalDiscountMinor ?? 0,
		loyaltyDiscountMinor: input.loyaltyDiscountMinor,
		taxMinor: input.taxMinor,
		tipMinor: input.priced.tipCents,
		deliveryFeeMinor: input.priced.deliveryFeeCents,
		deliveryDiscountMinor: evaluation?.deliveryDiscountMinor ?? 0,
		totalMinor: input.totalMinor,
		paymentRequired: input.totalMinor > 0,
		coupon: coupon
			? coupon.status === 'applied'
				? { status: 'applied' }
				: coupon.status === 'replaced'
					? { status: 'replaced', reason: 'replaced_by_better_discount' }
					: { status: 'refused', reason: publicRefusalReason(coupon.reason) }
			: null,
		...(input.couponsEnabled === undefined
			? {}
			: { couponsEnabled: input.couponsEnabled }),
	}
}

/**
 * What placement does with a prepared evaluation. A quote never refuses a
 * code: the refusal is the coupon field. Placement refuses a code that did
 * not apply, and a total that is not the one the customer was shown.
 */
export function interpretPlacement(
	discounts: OrderDiscountsRequest,
	prepared: PreparedDiscounts,
	quote: DiscountQuote,
): { ok: true } | { ok: false; failure: DiscountApplyFailure } {
	const outcome = prepared.evaluation.code
	if (discounts.code && outcome && outcome.status !== 'applied') {
		if (outcome.status === 'replaced') {
			return {
				ok: false,
				failure: {
					status: 409,
					code: 'discount_changed',
					message:
						'Your discount changed. Review the new total and place the order again.',
					reason: 'replaced_by_better_discount',
					quote,
				},
			}
		}
		return {
			ok: false,
			failure: {
				status: 409,
				code: 'coupon_refused',
				message: 'That coupon code could not be applied.',
				reason: publicRefusalReason(outcome.reason),
				quote,
			},
		}
	}
	const expected = discounts.expectedDiscountMinor ?? 0
	if (expected !== prepared.evaluation.totalDiscountMinor) {
		return {
			ok: false,
			failure: {
				status: 409,
				code: 'discount_changed',
				message:
					'Your discount changed. Review the new total and place the order again.',
				quote,
			},
		}
	}
	return { ok: true }
}

export function orderDiscountSnapshots(
	prepared: PreparedDiscounts | null,
): OrderDiscountSnapshot[] {
	if (!prepared) return []
	const typedCode = prepared.typedCode
	return prepared.evaluation.applied.map((applied) => ({
		discountId: applied.discountId,
		version: applied.version,
		name: applied.name,
		code: applied.codeId ? typedCode : null,
		amountMinor: applied.amountMinor,
		deliveryAmountMinor: applied.deliveryAmountMinor,
		allocation: applied.lines.map((line) => ({
			lineId: line.lineId,
			amountMinor: line.amountMinor,
			units: line.units,
		})),
	}))
}

/** Inserts one reserved redemption per applied discount. Facts never change. */
export async function reserveOrderDiscounts(
	db: DiscountDb,
	input: {
		orderId: string
		customerId: string | null
		prepared: PreparedDiscounts
		/** Defaults to an online order. Tab payment and the till pass their own. */
		sourceType?: 'order' | 'tab' | 'pos'
	},
): Promise<void> {
	const { prepared } = input
	if (prepared.evaluation.applied.length === 0) return
	const byId = new Map(prepared.records.map((record) => [record.id, record]))
	const rows = prepared.evaluation.applied.map((applied) => ({
		discountId: applied.discountId,
		discountVersion: applied.version,
		codeId: applied.codeId,
		normalizedCode: applied.normalizedCode,
		sourceType: input.sourceType ?? 'order',
		sourceId: input.orderId,
		customerId: input.customerId,
		state: 'reserved' as const,
		amountMinor: applied.amountMinor,
		deliveryAmountMinor: applied.deliveryAmountMinor,
		allocation: applied.lines.map((line) => ({
			lineId: line.lineId,
			amountMinor: line.amountMinor,
			units: line.units,
		})),
		// The definition as it applied, plus the code's use limit, so a sale paid
		// after its hold lapsed can be checked against the limits it was sold under.
		snapshot: {
			...(byId.get(applied.discountId) ?? { name: applied.name }),
			...(applied.codeId
				? {
						codeMaxUses:
							prepared.codes.find((code) => code.id === applied.codeId)
								?.maxUses ?? null,
					}
				: {}),
		},
		localDay: prepared.periods.day,
		localWeek: prepared.periods.week,
	}))
	// Durable Object SQLite allows 100 bound parameters. One redemption row
	// binds about 15, so 7 rows in one statement fails the whole order.
	const rowsPerStatement = 6
	for (let index = 0; index < rows.length; index += rowsPerStatement) {
		await db
			.insert(discountRedemptions)
			.values(rows.slice(index, index + rowsPerStatement))
	}
}

async function moveRedemptions(
	db: DiscountDb,
	orderIds: readonly string[],
	from: 'reserved' | 'consumed',
	to: 'consumed' | 'released' | 'refunded',
	sourceType: 'order' | 'tab' | 'pos' = 'order',
): Promise<void> {
	if (orderIds.length === 0) return
	// An order paid after its hold lapsed has its use re-recorded under
	// `<orderId>:late` (a released row cannot be reopened), so every move
	// covers both.
	const sourceIds =
		sourceType === 'order'
			? orderIds.flatMap((id) => [id, `${id}${LATE_SOURCE_SUFFIX}`])
			: orderIds
	await db
		.update(discountRedemptions)
		.set({ state: to, updatedAt: Date.now() })
		.where(
			and(
				eq(discountRedemptions.sourceType, sourceType),
				inJsonList(discountRedemptions.sourceId, sourceIds),
				eq(discountRedemptions.state, from),
			),
		)
}

/**
 * Honors a sale whose discount use was given back before the money arrived:
 * an online hold that lapsed and then was paid (`payment_review`). A released
 * row can never be reopened, so each released discount without a live use is
 * copied to a new `reserved` row under `<orderId>:late` (every fact, the
 * snapshot included, is kept). The sale was paid with the discount in its
 * price, so this never refuses: the use is always recorded so the counts stay
 * true. But when other uses have taken the discount's total limit, the
 * customer's limit or the code's `maxUses` since, those discounts are named in
 * `exceededDiscountIds` so the caller can flag the order for an operator.
 * Safe to repeat.
 */
export async function reReserveReleasedDiscounts(
	db: DiscountDb,
	orderId: string,
): Promise<{ recorded: number; exceededDiscountIds: string[] }> {
	return reReserveSource(
		db,
		'order',
		orderId,
		`${orderId}${LATE_SOURCE_SUFFIX}`,
	)
}

type LateUseSnapshot = {
	totalLimit?: number | null
	perCustomerLimit?: {
		count: number
		period: 'day' | 'week' | 'lifetime'
	} | null
	codeMaxUses?: number | null
}

/** True when recording this use would put a limit it was sold under over. */
async function lateUseExceedsLimit(
	db: DiscountDb,
	row: typeof discountRedemptions.$inferSelect,
	now: Date,
): Promise<boolean> {
	const snapshot = (row.snapshot ?? {}) as LateUseSnapshot
	const totalLimit = snapshot.totalLimit ?? null
	const perCustomer = snapshot.perCustomerLimit ?? null
	const codeMaxUses = snapshot.codeMaxUses ?? null
	if (totalLimit === null && !perCustomer && codeMaxUses === null) return false
	// Every other live use (this order has none: its rows are all released).
	const { usage, codeUsage } = await loadDiscountUsageCounts(
		db,
		[row.discountId],
		row.customerId,
		{ day: row.localDay, week: row.localWeek },
		now,
	)
	const used = usage[row.discountId]
	if (totalLimit !== null && (used?.total ?? 0) >= totalLimit) return true
	if (perCustomer && row.customerId) {
		const customerUsed =
			perCustomer.period === 'day'
				? (used?.customerDay ?? 0)
				: perCustomer.period === 'week'
					? (used?.customerWeek ?? 0)
					: (used?.customerLifetime ?? 0)
		if (customerUsed >= perCustomer.count) return true
	}
	return (
		codeMaxUses !== null &&
		row.codeId !== null &&
		(codeUsage[row.codeId] ?? 0) >= codeMaxUses
	)
}

async function reReserveSource(
	db: DiscountDb,
	sourceType: 'order',
	sourceId: string,
	lateSourceId: string,
): Promise<{ recorded: number; exceededDiscountIds: string[] }> {
	const rows = await db
		.select()
		.from(discountRedemptions)
		.where(
			and(
				eq(discountRedemptions.sourceType, sourceType),
				inJsonList(discountRedemptions.sourceId, [
					sourceId,
					`${sourceId}${LATE_SOURCE_SUFFIX}`,
				]),
			),
		)
	const live = new Set(
		rows.filter((row) => row.state !== 'released').map((row) => row.discountId),
	)
	// One copy per discount, the newest released row.
	const copies = new Map<string, (typeof rows)[number]>()
	for (const row of rows) {
		if (row.state !== 'released' || live.has(row.discountId)) continue
		const known = copies.get(row.discountId)
		if (!known || row.createdAt > known.createdAt) {
			copies.set(row.discountId, row)
		}
	}
	let recorded = 0
	const exceededDiscountIds: string[] = []
	const now = new Date()
	for (const row of copies.values()) {
		// Checked before the use is recorded, so the row never counts itself.
		if (await lateUseExceedsLimit(db, row, now)) {
			exceededDiscountIds.push(row.discountId)
		}
		const inserted = await db
			.insert(discountRedemptions)
			.values({
				discountId: row.discountId,
				discountVersion: row.discountVersion,
				codeId: row.codeId,
				normalizedCode: row.normalizedCode,
				sourceType,
				sourceId: lateSourceId,
				customerId: row.customerId,
				state: 'reserved',
				amountMinor: row.amountMinor,
				deliveryAmountMinor: row.deliveryAmountMinor,
				allocation: row.allocation,
				snapshot: row.snapshot,
				localDay: row.localDay,
				localWeek: row.localWeek,
			})
			.onConflictDoNothing()
			.returning({ id: discountRedemptions.id })
		recorded += inserted.length
	}
	return { recorded, exceededDiscountIds }
}

export function consumeDiscountSource(
	db: DiscountDb,
	sourceType: 'order' | 'tab' | 'pos',
	sourceId: string,
): Promise<void> {
	return moveRedemptions(db, [sourceId], 'reserved', 'consumed', sourceType)
}

export function releaseDiscountSource(
	db: DiscountDb,
	sourceType: 'order' | 'tab' | 'pos',
	sourceId: string,
): Promise<void> {
	return moveRedemptions(db, [sourceId], 'reserved', 'released', sourceType)
}

export function consumeDiscountRedemptions(
	db: DiscountDb,
	orderIds: readonly string[],
): Promise<void> {
	return moveRedemptions(db, orderIds, 'reserved', 'consumed')
}

export function releaseDiscountRedemptions(
	db: DiscountDb,
	orderIds: readonly string[],
): Promise<void> {
	return moveRedemptions(db, orderIds, 'reserved', 'released')
}

export function refundDiscountRedemptions(
	db: DiscountDb,
	orderId: string,
): Promise<void> {
	return moveRedemptions(db, [orderId], 'consumed', 'refunded')
}

/** A consumed use of a till sale (or tab) stops counting when the sale is refunded in full. */
export function refundDiscountSource(
	db: DiscountDb,
	sourceType: 'order' | 'tab' | 'pos',
	sourceId: string,
): Promise<void> {
	return moveRedemptions(db, [sourceId], 'consumed', 'refunded', sourceType)
}

/** Totals with only the discount engine applied (no loyalty reward). */
export function totalsAfterDiscounts(
	priced: PricedRestaurantOrder,
	prepared: PreparedDiscounts | null,
) {
	return applyOrderDiscounts(
		priced,
		prepared?.evaluation.lineDiscounts ?? {},
		prepared?.evaluation.deliveryDiscountMinor ?? 0,
	)
}

/** Counts for the operator list. No customer data. */
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/

export async function readDiscountUsage(
	db: DiscountDb,
	ids: readonly string[],
	range?: { from?: string; to?: string },
	/** `null` = every location; a list keeps only sales at those locations. */
	locationIds: readonly string[] | null = null,
): Promise<
	Array<{
		discountId: string
		uses: number
		reserved: number
		consumed: number
		refunded: number
		discountMinor: number
	}>
> {
	const unique = [...new Set(ids)]
	const blank = () => ({
		uses: 0,
		reserved: 0,
		consumed: 0,
		refunded: 0,
		discountMinor: 0,
	})
	const byId = new Map(unique.map((id) => [id, blank()]))
	if (unique.length === 0) return []
	const scoped = locationIds !== null
	if (scoped && locationIds.length === 0) {
		return unique.map((discountId) => ({ discountId, ...blank() }))
	}
	// A late copy of a source (`<id>:late`) belongs to the same location.
	const baseSourceId = sql<string>`case when ${discountRedemptions.sourceId} like ${`%${LATE_SOURCE_SUFFIX}`} then substr(${discountRedemptions.sourceId}, 1, length(${discountRedemptions.sourceId}) - ${LATE_SOURCE_SUFFIX.length}) else ${discountRedemptions.sourceId} end`
	const inScope = scoped
		? or(
				and(
					eq(discountRedemptions.sourceType, 'order'),
					sql`${baseSourceId} in (${db
						.select({ id: restaurantOrders.id })
						.from(restaurantOrders)
						.where(
							inJsonList(restaurantOrders.locationId, [...locationIds]),
						)})`,
				),
				and(
					eq(discountRedemptions.sourceType, 'tab'),
					sql`${baseSourceId} in (${db
						.select({ id: qrTabs.id })
						.from(qrTabs)
						.where(inJsonList(qrTabs.locationId, [...locationIds]))})`,
				),
				and(
					eq(discountRedemptions.sourceType, 'pos'),
					sql`${baseSourceId} in (${db
						.select({ id: posOrders.id })
						.from(posOrders)
						.where(inJsonList(posOrders.locationId, [...locationIds]))})`,
				),
			)
		: undefined
	const from = range?.from && LOCAL_DAY.test(range.from) ? range.from : null
	const to = range?.to && LOCAL_DAY.test(range.to) ? range.to : null
	const rows = await db
		.select({
			discountId: discountRedemptions.discountId,
			state: discountRedemptions.state,
			n: count(),
			amount: sum(discountRedemptions.amountMinor),
			delivery: sum(discountRedemptions.deliveryAmountMinor),
		})
		.from(discountRedemptions)
		.where(
			and(
				inJsonList(discountRedemptions.discountId, unique),
				from ? gte(discountRedemptions.localDay, from) : undefined,
				to ? lte(discountRedemptions.localDay, to) : undefined,
				inScope,
			),
		)
		.groupBy(discountRedemptions.discountId, discountRedemptions.state)
	for (const row of rows) {
		const entry = byId.get(row.discountId)
		if (!entry) continue
		const n = Number(row.n)
		const money = Number(row.amount ?? 0) + Number(row.delivery ?? 0)
		if (row.state === 'reserved') {
			entry.reserved += n
			entry.uses += n
			entry.discountMinor += money
		} else if (row.state === 'consumed') {
			entry.consumed += n
			entry.uses += n
			entry.discountMinor += money
		} else if (row.state === 'refunded') {
			entry.refunded += n
		}
	}
	return unique.map((discountId) => ({ discountId, ...byId.get(discountId)! }))
}

/**
 * Records till discounts once a till sale is paid. A failure here never
 * refuses the sale. Rows start reserved (the table requires it) and are then
 * consumed. A repeat upload hits the unique key and is ignored.
 *
 * `rules` are the till rules as they are now (automatic and manual, from
 * App's `discount-rules`); without them the order context's automatic
 * definitions stand in. An application whose rule is not there, or that needs a
 * manager and names none, is not a use: the upload is flagged for review
 * (`discountRuleReason` in `pos-service.ts`) instead of being counted.
 */
export async function recordPosDiscountUses(
	db: DiscountDb,
	input: {
		orderId: string
		locationId: string
		applications: ReadonlyArray<{
			discountId: string
			name: string
			amountCents: number
			approvedByStaffId?: string
			reason?: string
		}>
		context: RestaurantOrderContext | null
		rules?: readonly DiscountRecord[] | null
		/** When the sale happened. Period limits use this, not the upload time. */
		soldAt?: Date
		now?: Date
	},
): Promise<void> {
	const applications = input.applications.filter(
		(application) => application.amountCents > 0 && application.discountId,
	)
	if (applications.length === 0) return
	const now = input.soldAt ?? input.now ?? new Date()
	const location = input.context?.menu.locations.find(
		(row) => row.id === input.locationId,
	)
	const periods = discountPeriodKeys(
		localNowString(now.getTime(), location?.timezone ?? 'UTC'),
	)
	const records = new Map(
		(input.rules ?? input.context?.discounts?.discounts ?? []).map((record) => [
			record.id,
			record,
		]),
	)
	let inserted = false
	for (const application of applications) {
		const record = records.get(application.discountId)
		// An id the rules do not have is not a use. A rule that needs a manager
		// is not a use until the till names who approved it. Both are flagged.
		if (!record) continue
		if (record.requireApproval && !application.approvedByStaffId) continue
		try {
			await db.insert(discountRedemptions).values({
				discountId: application.discountId,
				discountVersion: record.version,
				codeId: null,
				normalizedCode: null,
				sourceType: 'pos',
				sourceId: input.orderId,
				customerId: null,
				state: 'reserved',
				amountMinor: application.amountCents,
				deliveryAmountMinor: 0,
				allocation: [],
				snapshot: {
					...record,
					...(application.approvedByStaffId
						? { approvedByStaffId: application.approvedByStaffId }
						: {}),
					...(application.reason ? { reason: application.reason } : {}),
				},
				localDay: periods.day,
				localWeek: periods.week,
			})
			inserted = true
		} catch {
			// Already recorded, or the row was refused. The sale stays stored.
		}
	}
	if (!inserted) return
	try {
		await consumeDiscountSource(db, 'pos', input.orderId)
	} catch {
		// Reserved still counts toward the limit.
	}
}

/**
 * A till sale that is cancelled or refunded in full no longer uses its
 * discounts: a use that was only reserved is released, a consumed one is
 * refunded, so neither counts toward a limit. Nothing to do when none was
 * recorded. A failure never changes the sale.
 */
export async function releasePosDiscountUses(
	db: DiscountDb,
	orderId: string,
): Promise<void> {
	await releaseDiscountSource(db, 'pos', orderId)
	await refundDiscountSource(db, 'pos', orderId)
}
