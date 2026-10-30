import {
	posLineTaxableCents,
	posLineTotalCents,
	type PosOrderLine,
} from '@repo/common/pos-orders'
import {
	buildPurchaseSnapshot,
	computeRewardDiscount,
	loyaltyRewardSnapshotSchema,
	type LoyaltyCart,
	type SnapshotAllocationLine,
	type SnapshotSourceLine,
} from '@repo/loyalty'
import {
	posFiscalDocuments,
	posHeldUploads,
	posOrderRevisions,
	posOrders,
	posPayments,
	type PosOrderRow,
} from '@repo/tenant-db'
import { and, desc, eq, gt, isNotNull, isNull, max, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type LoyaltyReader } from '../lib/loyalty-write.ts'
import { type RedemptionRow } from '../services/loyalty-redemption-service.ts'
import {
	type LoyaltySourceAdapter,
	type LoyaltySourceVerdict,
} from '../services/loyalty-sources.ts'

/**
 * Loyalty's view of a till sale (`pos_order`). The till is the record of what
 * was sold, so a sale earns from the lines, discounts and money it uploaded;
 * the region only decides whether that upload can be trusted to earn yet.
 *
 * - Open: nothing changes. Cancelled: a reward on it is given back.
 * - A newer revision held for review: the sale is uncertain, so it waits.
 * - Closed (paid, or paid and refunded): it earns, net of refunds. A sale the
 *   till review flagged for its clock, the people it names or its fiscal
 *   chain waits for an operator; a price or menu difference still earns.
 */

/** Till review reasons that still earn: the price or the menu, never who or when. */
const EARNING_FLAGS = new Set([
	'unverified',
	'unverifiable',
	'large_discount',
	'price_mismatch',
	'tax_mismatch',
	'stale_price',
	'stale_tax',
])
const EARNING_FLAG_PREFIXES = ['catalog:', 'stale_catalog:']

/** Whether a sale the till review flagged for this reason still earns. */
export function tillFlagEarns(reason: string): boolean {
	return (
		EARNING_FLAGS.has(reason) ||
		EARNING_FLAG_PREFIXES.some((prefix) => reason.startsWith(prefix))
	)
}

/** A line's id on the sale: the till's own, else its position (contract 3 and older). */
export function tillLineId(
	line: Pick<PosOrderLine, 'id'>,
	index: number,
): string {
	return line.id ?? String(index)
}

function storedLines(sale: PosOrderRow): PosOrderLine[] {
	return Array.isArray(sale.lines) ? (sale.lines as PosOrderLine[]) : []
}

function adjustmentTotal(sale: PosOrderRow, kind: 'discount' | 'loyalty') {
	const adjustments = Array.isArray(sale.adjustments)
		? (sale.adjustments as Array<{ kind?: unknown; amountCents?: unknown }>)
		: []
	return adjustments.reduce(
		(sum, adjustment) =>
			adjustment.kind === kind &&
			typeof adjustment.amountCents === 'number' &&
			Number.isSafeInteger(adjustment.amountCents) &&
			adjustment.amountCents > 0
				? sum + adjustment.amountCents
				: sum,
		0,
	)
}

export function tillSnapshotLines(
	lines: readonly PosOrderLine[],
	categories: ReadonlyMap<string, readonly string[]>,
): SnapshotSourceLine[] {
	return lines.map((line, index) => {
		const lineId = tillLineId(line, index)
		return {
			lineId,
			itemId: line.itemId,
			categoryIds: categories.get(lineId) ?? [],
			quantity: line.quantity,
			grossMinor: posLineTotalCents(line),
			taxableMinor: posLineTaxableCents(line),
		}
	})
}

/**
 * The sale as the loyalty cart the till asked approval for, rebuilt from the
 * uploaded lines and the categories the till uploaded with them.
 */
export function tillLoyaltyCart(
	sale: PosOrderRow,
	categories: ReadonlyMap<string, readonly string[]>,
): LoyaltyCart {
	return {
		currency: sale.currency,
		otherDiscountMinor: adjustmentTotal(sale, 'discount'),
		lines: storedLines(sale).map((line, index) => {
			const lineId = tillLineId(line, index)
			return {
				lineId,
				itemId: line.itemId,
				variantId: line.variantId ?? null,
				categoryIds: [...(categories.get(lineId) ?? [])],
				quantity: line.quantity,
				unitBaseMinor: line.baseCents,
				unitMinor:
					line.baseCents +
					line.options.reduce((sum, o) => sum + o.unitCents * o.quantity, 0),
			}
		}),
	}
}

/**
 * Whether the approved reward still earns exactly its approved discount on the
 * uploaded cart. The discount amount alone can match while the lines under it
 * changed; an unreadable snapshot fails closed (the sale waits in review).
 */
export function discountMatchesUpload(
	sale: PosOrderRow,
	redemption: RedemptionRow,
	categories: ReadonlyMap<string, readonly string[]>,
): boolean {
	const reward = loyaltyRewardSnapshotSchema.safeParse(
		redemption.rewardSnapshot,
	)
	if (!reward.success) return false
	const cart = tillLoyaltyCart(sale, categories)
	if (cart.lines.length === 0) return false
	const recheck = computeRewardDiscount(reward.data, cart, {
		targetLineId: redemption.targetLineId,
	})
	return recheck.ok && recheck.discountMinor === redemption.discountMinor
}

/**
 * How the sale's loyalty discount splits over its lines: the redemption's own
 * split when it is the discount the sale carries and still fits the sale's
 * lines. A split that names a line the sale does not have, or gives a line more
 * than it cost, does not fit: the discount is spread like a till discount and
 * the sale waits for an operator. A different amount is settlement's to catch.
 */
export function tillDiscountSplit(
	saleDiscountMinor: number,
	redemption: RedemptionRow | null,
	lines: readonly SnapshotSourceLine[],
): {
	allocation?: SnapshotAllocationLine[]
	otherDiscountMinor: number
	fits: boolean
} {
	if (saleDiscountMinor <= 0) return { otherDiscountMinor: 0, fits: true }
	if (!redemption || redemption.discountMinor !== saleDiscountMinor) {
		return { otherDiscountMinor: saleDiscountMinor, fits: true }
	}
	const byId = new Map(lines.map((line) => [line.lineId, line]))
	const fits =
		byId.size === lines.length &&
		redemption.allocation.every((share) => {
			const line = byId.get(share.lineId)
			return (
				line !== undefined &&
				share.discountMinor <= line.grossMinor &&
				share.rewardUnits <= line.quantity
			)
		})
	if (!fits) return { otherDiscountMinor: saleDiscountMinor, fits: false }
	return {
		allocation: redemption.allocation.map((share) => ({
			lineId: share.lineId,
			discountMinor: share.discountMinor,
			rewardUnits: share.rewardUnits,
		})),
		otherDiscountMinor: 0,
		fits: true,
	}
}

/** A newer revision of the sale (or one that could not be read) waits in the held queue. */
async function heldNewerRevision(
	db: LoyaltyReader,
	sale: PosOrderRow,
): Promise<boolean> {
	// Only this sale's own terminal can stall it: a held row names the sale by
	// an id and revision the payload claims, so another terminal's unreadable
	// upload must never hold back a sale it does not own.
	const held = await db
		.select({ id: posHeldUploads.id })
		.from(posHeldUploads)
		.where(
			and(
				eq(posHeldUploads.orderId, sale.id),
				eq(posHeldUploads.deviceId, sale.deviceId),
				isNull(posHeldUploads.resolvedAt),
				or(
					isNull(posHeldUploads.revision),
					gt(posHeldUploads.revision, sale.revision),
				),
			),
		)
		.limit(1)
		.get()
	return held !== undefined
}

/**
 * Whether any revision was flagged for a reason that does not earn, or a
 * fiscal document of the sale has a problem. A sale keeps the first reason it
 * was flagged for, so every revision's own verdict is read as well.
 */
async function tillSaleFlagged(
	db: LoyaltyReader,
	sale: PosOrderRow,
): Promise<boolean> {
	if (sale.reviewReason && !tillFlagEarns(sale.reviewReason)) return true
	const reasons = await db
		.selectDistinct({ reason: posOrderRevisions.reviewReason })
		.from(posOrderRevisions)
		.where(
			and(
				eq(posOrderRevisions.orderId, sale.id),
				isNotNull(posOrderRevisions.reviewReason),
			),
		)
		.all()
	if (reasons.some((row) => row.reason && !tillFlagEarns(row.reason))) {
		return true
	}
	const fiscal = await db
		.select({ docId: posFiscalDocuments.docId })
		.from(posFiscalDocuments)
		.where(
			and(
				eq(posFiscalDocuments.orderId, sale.id),
				isNotNull(posFiscalDocuments.problem),
			),
		)
		.limit(1)
		.get()
	return fiscal !== undefined
}

const loyaltyLinesSchema = z
	.array(
		z.object({
			id: z.string().min(1).max(100),
			categoryIds: z.array(z.string().min(1).max(100)).max(50),
		}),
	)
	.max(50)

/**
 * Each line's menu categories, as the till sent them with the sale's loyalty
 * (contract 5) in its latest revision that had them. Revisions keep them; the
 * sale row does not.
 */
async function tillLineCategories(
	db: LoyaltyReader,
	saleId: string,
): Promise<Map<string, string[]>> {
	const extract = sql<
		string | null
	>`json_extract(${posOrderRevisions.snapshot}, '$.loyalty.lines')`
	const row = await db
		.select({ lines: extract })
		.from(posOrderRevisions)
		.where(and(eq(posOrderRevisions.orderId, saleId), isNotNull(extract)))
		.orderBy(desc(posOrderRevisions.revision))
		.limit(1)
		.get()
	const categories = new Map<string, string[]>()
	if (!row?.lines) return categories
	let raw: unknown
	try {
		raw = typeof row.lines === 'string' ? JSON.parse(row.lines) : row.lines
	} catch {
		return categories
	}
	const parsed = loyaltyLinesSchema.safeParse(raw)
	if (!parsed.success) return categories
	for (const line of parsed.data) categories.set(line.id, line.categoryIds)
	return categories
}

/** When the region received the payment that closed the sale (offline sales arrive late). */
async function closingPaymentReceivedAt(
	db: LoyaltyReader,
	saleId: string,
): Promise<number | null> {
	const row = await db
		.select({ at: max(posPayments.receivedAt) })
		.from(posPayments)
		.where(
			and(eq(posPayments.orderId, saleId), eq(posPayments.kind, 'payment')),
		)
		.get()
	return row?.at ?? null
}

export async function posOrderVerdict(
	db: LoyaltyReader,
	sale: PosOrderRow,
	redemption: RedemptionRow | null,
	now: number,
): Promise<LoyaltySourceVerdict> {
	if (await heldNewerRevision(db, sale)) {
		return { kind: 'review', reason: 'upload_held' }
	}
	if (sale.status === 'open') return { kind: 'open' }
	if (sale.status === 'void') {
		return { kind: 'cancelled', releaseReason: 'sale_voided' }
	}
	if (redemption?.deviceId != null && redemption.deviceId !== sale.deviceId) {
		// A reward approved on one terminal is spent by that terminal's upload;
		// any other terminal's sale carrying it waits for an operator.
		return { kind: 'review', reason: 'device_mismatch' }
	}
	const loyaltyDiscount = adjustmentTotal(sale, 'loyalty')
	const categories = await tillLineCategories(db, sale.id)
	const lines = tillSnapshotLines(storedLines(sale), categories)
	const split = tillDiscountSplit(loyaltyDiscount, redemption, lines)
	const cartMatches =
		split.fits && redemption !== null && loyaltyDiscount > 0
			? discountMatchesUpload(sale, redemption, categories)
			: true
	const flagged = await tillSaleFlagged(db, sale)
	return {
		kind: 'completed',
		occurredAt: sale.paidAt ?? sale.updatedAt ?? now,
		receivedAt: await closingPaymentReceivedAt(db, sale.id),
		snapshot: buildPurchaseSnapshot({
			currency: sale.currency,
			totalPaidMinor: sale.totalCents,
			taxMinor: sale.taxCents,
			taxInclusive: sale.taxInclusive,
			lines,
			allocation: split.allocation,
			otherDiscountMinor:
				split.otherDiscountMinor + adjustmentTotal(sale, 'discount'),
		}),
		loyaltyDiscountMinor: loyaltyDiscount,
		// Closed without the reward it was approved for: the member keeps the points.
		releaseReason: loyaltyDiscount === 0 ? 'reward_not_used' : null,
		holdReason:
			!split.fits || !cartMatches
				? 'upload_mismatch'
				: flagged
					? 'sale_flagged'
					: null,
	}
}

export const posOrderLoyaltySource: LoyaltySourceAdapter = {
	type: 'pos_order',
	async read(db, sourceId, { redemption, now }) {
		const sale = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, sourceId))
			.get()
		if (!sale) return null
		return {
			currency: sale.currency,
			totalMinor: sale.totalCents,
			refundedMinor: sale.refundedCents,
			locationId: sale.locationId,
			verdict: await posOrderVerdict(db, sale, redemption, now),
		}
	},
}
