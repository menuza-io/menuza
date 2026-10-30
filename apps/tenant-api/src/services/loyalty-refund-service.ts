import { LoyaltyDomainError, normalizeCurrency } from '@repo/loyalty'
import { loyaltyPurchases, loyaltyRefunds, qrTabs } from '@repo/tenant-db'
import { and, eq, sql } from 'drizzle-orm'
import {
	hashLoyaltyRequest,
	type LoyaltyReader,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import { locationVisible } from './loyalty-member-service.ts'
import {
	applyPurchaseRefundsInTx,
	latestRedemptionForSourceInTx,
	purchaseForSourceInTx,
	readSourceFactsInTx,
} from './loyalty-purchase-service.ts'
import { restoreRedemptionInTx } from './loyalty-redemption-service.ts'

/**
 * Money returned for a QR tab paid from the phone. No provider refund event
 * reaches the region, so an operator records it (audited, with its own
 * grant); closing or voiding a tab is never refund evidence on its own. An
 * online order's refunds are recorded on the order (`order-refund-service`)
 * and reconciliation reads them from there.
 *
 * Refunds are cumulative: each one adds to the total returned, and points are
 * recomputed from that total against the purchase's own snapshot, so a
 * partial refund takes back its share and a repeated request changes nothing.
 * The reward's points come back once, when every cent paid has come back.
 *
 * The idempotency store forgets a key after 48h; the refund row keeps it
 * forever. A later retry with the same request replays from that row (its
 * point and reward deltas report zero — the first request applied them), and
 * a different request under a used key is a conflict.
 */

export type RefundSourceType = 'qr_tab'

export type LoyaltyRefundResult = {
	refundId: string
	purchaseId: string | null
	refundedMinor: number
	cumulativeRefundedMinor: number
	pointsReversed: number
	fullRefund: boolean
	rewardRestored: boolean
}

export async function refundedTotalInTx(
	db: LoyaltyReader,
	source: { type: RefundSourceType; id: string },
): Promise<number> {
	const row = await db
		.select({
			total: sql<number>`coalesce(sum(${loyaltyRefunds.amountMinor}), 0)`,
		})
		.from(loyaltyRefunds)
		.where(
			and(
				eq(loyaltyRefunds.sourceType, source.type),
				eq(loyaltyRefunds.sourceId, source.id),
			),
		)
		.get()
	return Number(row?.total ?? 0)
}

export async function recordLoyaltyRefund(
	orgId: string,
	input: {
		source: { type: RefundSourceType; id: string }
		/** Omit with `full` to refund what is left. */
		amountMinor?: number
		full?: boolean
		note: string
		actorId: string
		locationIds: readonly string[] | null
		idempotencyKey: string
		now?: number
	},
): Promise<LoyaltyRefundResult> {
	const requestHash = hashLoyaltyRequest({
		source: input.source,
		amountMinor: input.amountMinor ?? null,
		full: input.full === true,
		note: input.note,
	})
	return withLoyaltyWrite(
		{
			orgId,
			now: input.now,
			idempotency: {
				scope: `refund:${input.actorId}`,
				key: input.idempotencyKey,
				requestHash,
			},
		},
		async (tx, ctx) => {
			const source = { type: input.source.type, id: input.source.id }
			const purchase = await purchaseForSourceInTx(tx, source)
			const redemption = await latestRedemptionForSourceInTx(tx, source)
			const memberId = purchase?.memberId ?? redemption?.memberId
			if (!memberId) throw new LoyaltyDomainError('purchase_not_found')
			ctx.linkMember(memberId)
			const facts = await readSourceFactsInTx(tx, source, {
				redemption,
				now: ctx.now,
			})
			if (!facts) throw new LoyaltyDomainError('purchase_not_found')
			if (!locationVisible(input.locationIds, facts.locationId)) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			const previous = await refundedTotalInTx(tx, source)
			const storedKey = `${input.actorId}:${input.idempotencyKey}`
			// The refund row outlives the 48h idempotency store: find it before
			// any check of what is left to refund (a retry of the refund that
			// brought the total to what was paid has nothing left) and before
			// writing, so a late retry replays instead of being refused or
			// crashing on the unique index, and never applies twice.
			const existing = await tx
				.select()
				.from(loyaltyRefunds)
				.where(eq(loyaltyRefunds.idempotencyKey, storedKey))
				.get()
			if (existing) {
				const sameRequest =
					existing.sourceType === source.type &&
					existing.sourceId === source.id &&
					existing.note === input.note &&
					(input.full === true && input.amountMinor === undefined
						? existing.full
						: existing.amountMinor === input.amountMinor)
				if (!sameRequest) {
					throw new LoyaltyDomainError('idempotency_conflict')
				}
				return {
					refundId: existing.id,
					purchaseId: existing.purchaseId,
					refundedMinor: existing.amountMinor,
					cumulativeRefundedMinor: previous,
					pointsReversed: 0,
					fullRefund: existing.full,
					rewardRestored: false,
				}
			}
			if (source.type === 'qr_tab') {
				// Only money that actually moved can come back: a counter-paid or
				// unpaid tab has no provider refund to mirror, so there is nothing
				// to record (and no earned points to take back) here.
				const tab = await tx
					.select({
						paymentMethod: qrTabs.paymentMethod,
						paymentStatus: qrTabs.paymentStatus,
					})
					.from(qrTabs)
					.where(eq(qrTabs.id, source.id))
					.get()
				if (!tab || tab.paymentMethod !== 'online') {
					throw new LoyaltyDomainError('refund_not_online')
				}
				if (tab.paymentStatus !== 'paid') {
					throw new LoyaltyDomainError('refund_not_paid')
				}
			}
			// What was actually paid: the snapshot once the sale finished.
			const paidMinor =
				purchase?.state === 'completed'
					? purchase.totalPaidMinor
					: facts.totalMinor
			const amount =
				input.full === true && input.amountMinor === undefined
					? paidMinor - previous
					: (input.amountMinor ?? 0)
			if (!Number.isSafeInteger(amount) || amount <= 0) {
				throw new LoyaltyDomainError('refund_exceeds_payment', {
					refundableMinor: Math.max(0, paidMinor - previous),
				})
			}
			const cumulative = previous + amount
			if (cumulative > paidMinor) {
				throw new LoyaltyDomainError('refund_exceeds_payment', {
					refundableMinor: Math.max(0, paidMinor - previous),
				})
			}
			const fullRefund = paidMinor > 0 && cumulative >= paidMinor
			const [refund] = await tx
				.insert(loyaltyRefunds)
				.values({
					sourceType: source.type,
					sourceId: source.id,
					purchaseId: purchase?.id ?? null,
					amountMinor: amount,
					currency: normalizeCurrency(facts.currency),
					full: fullRefund,
					note: input.note,
					actorId: input.actorId,
					idempotencyKey: storedKey,
					createdAt: ctx.now,
				})
				.returning()

			let pointsReversed = 0
			if (purchase) {
				const [updated] = await tx
					.update(loyaltyPurchases)
					.set({ refundedMinor: cumulative, updatedAt: ctx.now })
					.where(eq(loyaltyPurchases.id, purchase.id))
					.returning()
				const applied = await applyPurchaseRefundsInTx(tx, updated!, {
					at: ctx.now,
					actorKind: 'operator',
					actorId: input.actorId,
				})
				pointsReversed = applied.pointsReversed
			}

			let rewardRestored = false
			if (fullRefund && redemption?.state === 'consumed') {
				await restoreRedemptionInTx(tx, redemption, {
					at: ctx.now,
					actorKind: 'operator',
					actorId: input.actorId,
				})
				rewardRestored = true
			}

			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				locationId: facts.locationId,
				action: 'refund.recorded',
				entityType: 'refund',
				entityId: refund!.id,
				changes: {
					sourceType: source.type,
					sourceId: source.id,
					amountMinor: amount,
					cumulativeRefundedMinor: cumulative,
					pointsReversed,
					fullRefund,
					rewardRestored,
					note: input.note,
				},
				at: ctx.now,
			})
			return {
				refundId: refund!.id,
				purchaseId: purchase?.id ?? null,
				refundedMinor: amount,
				cumulativeRefundedMinor: cumulative,
				pointsReversed,
				fullRefund,
				rewardRestored,
			}
		},
	)
}
