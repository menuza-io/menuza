import { type LoyaltyPurchaseSource } from '@repo/loyalty'
import {
	loyaltyOutbox,
	loyaltyPurchases,
	loyaltyRedemptions,
} from '@repo/tenant-db'
import { and, count, eq } from 'drizzle-orm'
import { type LoyaltyReader, type LoyaltyTx } from '../lib/loyalty-write.ts'

/**
 * Parked sources: outbox rows that ran out of attempts (`failed`). Parking
 * sends the source's purchase and bound redemption to review, so a parked row
 * stays counted until an operator has answered every review item on it, or
 * the source is queued again (a sale change or a requeue).
 */

/** Sources parked for an operator right now. */
export async function countParkedLoyaltySources(
	db: LoyaltyReader,
): Promise<number> {
	const row = await db
		.select({ parked: count() })
		.from(loyaltyOutbox)
		.where(eq(loyaltyOutbox.status, 'failed'))
		.get()
	return row?.parked ?? 0
}

/** Closes a parked source once nothing on it is still waiting in review. */
export async function closeParkedSourceInTx(
	tx: LoyaltyTx,
	source: { type: LoyaltyPurchaseSource; id: string },
	at: number,
): Promise<void> {
	const purchase = await tx
		.select({ id: loyaltyPurchases.id })
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.sourceType, source.type),
				eq(loyaltyPurchases.sourceId, source.id),
				eq(loyaltyPurchases.state, 'review'),
			),
		)
		.get()
	if (purchase) return
	const redemption = await tx
		.select({ id: loyaltyRedemptions.id })
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.sourceType, source.type),
				eq(loyaltyRedemptions.sourceId, source.id),
				eq(loyaltyRedemptions.state, 'review'),
			),
		)
		.get()
	if (redemption) return
	await tx
		.update(loyaltyOutbox)
		.set({ status: 'done', doneAt: at, lastError: null, updatedAt: at })
		.where(
			and(
				eq(loyaltyOutbox.sourceType, source.type),
				eq(loyaltyOutbox.sourceId, source.id),
				eq(loyaltyOutbox.status, 'failed'),
			),
		)
}
