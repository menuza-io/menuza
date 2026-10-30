/**
 * Reconciliation. Order channels never call loyalty inside their own
 * transaction beyond two cheap inserts (claiming a purchase, queueing a
 * source); the work itself runs from `loyalty_outbox` after the sale commits
 * and again from the tick until it succeeds. It reads the authoritative order,
 * tab or till sale every time and computes from cumulative facts, so a
 * duplicate, late or out-of-order event changes nothing, and a loyalty failure
 * can never refuse or alter a sale.
 */
export const LOYALTY_OUTBOX_STATUSES = ['pending', 'done', 'failed'] as const
export type LoyaltyOutboxStatus = (typeof LOYALTY_OUTBOX_STATUSES)[number]

/** After this many failed attempts a source is parked for an operator. */
export const LOYALTY_OUTBOX_MAX_ATTEMPTS = 12

/** Wait before retry `attempt` (1-based): 30 s doubling, at most an hour. */
export function loyaltyOutboxBackoffMs(attempt: number): number {
	const step = Math.max(1, Math.floor(attempt))
	return Math.min(60 * 60_000, 30_000 * 2 ** (step - 1))
}

/**
 * A till redemption bound to a sale that has not been uploaded after this long
 * moves to review. It is never released by a timer: the discount may be on a
 * sale that is still on the tablet.
 */
export const LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS = 24 * 60 * 60_000

/** How long expired codes, bindings, approvals and idempotency keys are kept. */
export const LOYALTY_PURGE_AFTER_MS = 30 * 24 * 60 * 60_000
