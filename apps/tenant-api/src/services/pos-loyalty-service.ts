import { type PosOrderRequest } from '@repo/common/pos-orders'
import { LoyaltyDomainError } from '@repo/loyalty'
import { type PosOrderRow } from '@repo/tenant-db'
import {
	getLoyaltyFlagState,
	loyaltyCreditsSales,
} from '../lib/loyalty-context.ts'
import {
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import {
	LOYALTY_TILL_SOURCE,
	resolveBindingInTx,
} from './loyalty-code-service.ts'
import { readMemberInTx, type MemberRow } from './loyalty-member-service.ts'
import {
	claimPurchaseInTx,
	loyaltySettleQueue,
} from './loyalty-purchase-service.ts'
import { activeRedemptionForSourceInTx } from './loyalty-redemption-service.ts'

/**
 * Loyalty for a till upload the server accepted (contract 5).
 *
 * Inside the upload's own transaction the sale is credited to its member and
 * queued; once it commits, the sale is reconciled. The member is the one who
 * approved a reward on the sale, else the one behind the binding the till
 * sent, checked at the time the sale was paid so a sale finished offline still
 * counts. Crediting a sale is new work and needs loyalty on; a reward already
 * on the sale is reconciled whatever the flags say. Nothing here can refuse or
 * change the sale.
 */

/** How far a till's clock may be off the region's when it used a binding. */
export const TILL_CLOCK_SKEW_MS = 5 * 60_000

function failureCode(error: unknown): string {
	if (error instanceof LoyaltyDomainError) return error.code
	return (error instanceof Error ? error.name : 'unknown').slice(0, 64)
}

/** When the till took the sale's last payment; now for a sale still open. */
function tillSaleTime(order: PosOrderRequest, now: number): number {
	if (order.status !== 'paid' && order.status !== 'refunded') return now
	const paidAt = order.payments.reduce(
		(latest, payment) => Math.max(latest, Date.parse(payment.at)),
		Number.NEGATIVE_INFINITY,
	)
	return Number.isFinite(paidAt) ? paidAt : now
}

async function tillMemberInTx(
	tx: LoyaltyTx,
	orgId: string,
	input: { deviceId: string; order: PosOrderRequest; now: number },
): Promise<MemberRow | null> {
	const redemption = await activeRedemptionForSourceInTx(
		tx,
		LOYALTY_TILL_SOURCE,
		input.order.id,
	)
	if (redemption) {
		// The reward is spent by the terminal that took the approval; another
		// terminal uploading the same sale id credits nobody (settlement holds
		// the redemption in review instead).
		if (redemption.deviceId !== null && redemption.deviceId !== input.deviceId)
			return null
		const member = await readMemberInTx(tx, redemption.memberId)
		return member?.status === 'active' ? member : null
	}
	const binding = input.order.loyalty?.binding
	if (!binding) return null
	try {
		const { member } = await resolveBindingInTx(tx, orgId, {
			binding,
			deviceId: input.deviceId,
			at: tillSaleTime(input.order, input.now),
			clockSkewMs: TILL_CLOCK_SKEW_MS,
		})
		return member
	} catch (error) {
		if (error instanceof LoyaltyDomainError) return null
		throw error
	}
}

/**
 * The discount a reward approved for this sale accounts for (0 without one):
 * the redemption the member approved at the till and bound to the sale id.
 * Read-only; lets the large-discount check tell a reward from a manual
 * discount labelled as one.
 */
export async function tillRewardBackedCents(
	db: LoyaltyReader,
	saleId: string,
): Promise<number> {
	const redemption = await activeRedemptionForSourceInTx(
		db,
		LOYALTY_TILL_SOURCE,
		saleId,
	)
	return redemption && redemption.state !== 'restored'
		? redemption.discountMinor
		: 0
}

export type TillLoyaltyUpload = {
	/** In the upload's transaction, once the revision is stored. Never throws. */
	inTx: (tx: LoyaltyTx, sale: PosOrderRow) => Promise<void>
	/** After the upload committed. Never throws. */
	settle: () => Promise<void>
}

export async function tillLoyaltyUpload(
	orgId: string,
	input: { deviceId: string; order: PosOrderRequest; now?: number },
): Promise<TillLoyaltyUpload> {
	const { order } = input
	// Only a till that put a member on the sale sends `loyalty`.
	const credits =
		order.loyalty && order.status !== 'void'
			? loyaltyCreditsSales(await getLoyaltyFlagState(orgId))
			: false
	const queue = loyaltySettleQueue()
	return {
		async inTx(tx, sale) {
			const now = input.now ?? Date.now()
			const source = { type: LOYALTY_TILL_SOURCE, id: sale.id }
			if (credits) {
				try {
					const member = await tillMemberInTx(tx, orgId, {
						deviceId: input.deviceId,
						order,
						now,
					})
					if (member) {
						await claimPurchaseInTx(tx, {
							member,
							source,
							locationId: sale.locationId,
							currency: sale.currency,
							at: now,
						})
					}
				} catch (error) {
					// `already_claimed` and `member_inactive` leave the sale uncredited.
					if (!(error instanceof LoyaltyDomainError)) {
						console.error(
							'Loyalty did not credit a till sale',
							failureCode(error),
						)
					}
				}
			}
			try {
				await queue.queue(tx, source, now)
			} catch (error) {
				console.error('Loyalty did not queue a till sale', failureCode(error))
			}
		},
		async settle() {
			try {
				await queue.settle(orgId, { now: input.now })
			} catch (error) {
				console.error('Loyalty did not settle a till sale', failureCode(error))
			}
		},
	}
}

/**
 * Reconciles a till sale again when its held uploads change: a newer revision
 * the server could not apply makes the sale wait for a person, and settling
 * that upload lets it go on from the sale as stored. Only a sale loyalty
 * tracks is queued. Never throws.
 */
export async function requeueTillSaleLoyalty(
	orgId: string,
	saleId: string,
	options: { now?: number } = {},
): Promise<void> {
	const queue = loyaltySettleQueue()
	try {
		// A held upload changes nothing about the sale: re-arm its queued work
		// without resetting the retry budget, so a terminal holding uploads in a
		// loop cannot keep a failing reconciliation alive forever.
		await withLoyaltyWrite({ orgId, now: options.now }, (tx, ctx) =>
			queue.queue(tx, { type: LOYALTY_TILL_SOURCE, id: saleId }, ctx.now, {
				preserveAttempts: true,
			}),
		)
		await queue.settle(orgId, options)
	} catch (error) {
		console.error('Loyalty did not queue a till sale', failureCode(error))
	}
}
