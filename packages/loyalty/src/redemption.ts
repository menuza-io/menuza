/**
 * Redemption lifecycle.
 *
 *   reserved -> bound      attached to one order, tab or sale
 *   reserved -> released   an unbound hold expired
 *   bound    -> consumed   the sale was confirmed (paid)
 *   bound    -> released  confirmed unpaid: cancelled, payment failed or expired
 *   bound    -> review     payment or upload uncertain
 *   review   -> consumed   the sale was reconciled
 *   review   -> released   no sale was confirmed
 *   consumed -> restored   confirmed full refund (points come back once)
 *
 * A bound redemption is never released by a timer: a timeout is not proof that
 * the discount or the payment did not happen.
 */
export const LOYALTY_REDEMPTION_STATES = [
	'reserved',
	'bound',
	'consumed',
	'released',
	'review',
	'restored',
] as const
export type LoyaltyRedemptionState = (typeof LOYALTY_REDEMPTION_STATES)[number]

const TRANSITIONS: Readonly<
	Record<LoyaltyRedemptionState, readonly LoyaltyRedemptionState[]>
> = {
	reserved: ['bound', 'released'],
	bound: ['consumed', 'released', 'review'],
	review: ['consumed', 'released'],
	consumed: ['restored'],
	released: [],
	restored: [],
}

export function canTransitionRedemption(
	from: LoyaltyRedemptionState,
	to: LoyaltyRedemptionState,
): boolean {
	return TRANSITIONS[from].includes(to)
}

export function nextRedemptionStates(
	from: LoyaltyRedemptionState,
): readonly LoyaltyRedemptionState[] {
	return TRANSITIONS[from]
}

/** States whose points are excluded from the available balance. */
export const LOYALTY_HOLDING_STATES = ['reserved', 'bound', 'review'] as const
export function redemptionHoldsPoints(state: LoyaltyRedemptionState): boolean {
	return (LOYALTY_HOLDING_STATES as readonly string[]).includes(state)
}

/** States that occupy an order's single reward slot. */
export function redemptionOccupiesOrder(
	state: LoyaltyRedemptionState,
): boolean {
	return state !== 'released'
}

export function isTerminalRedemptionState(
	state: LoyaltyRedemptionState,
): boolean {
	return TRANSITIONS[state].length === 0
}

/** Why a redemption or a purchase waits for an operator. */
export const LOYALTY_REVIEW_REASONS = [
	/** The payment itself is under review. */
	'payment_uncertain',
	/** Handed over or closed without a recorded payment. */
	'completed_unpaid',
	/** The till upload was held for review. */
	'upload_held',
	/** No upload of the sale a day after the points were bound to it. */
	'upload_missing',
	/** The uploaded loyalty discount does not match what was approved. */
	'upload_mismatch',
	/** A reward approved on one terminal was uploaded by another. */
	'device_mismatch',
	/** The sale carries a loyalty discount that matches no approved redemption. */
	'redemption_unknown',
	/** The sale carries a loyalty discount whose points were already released. */
	'redemption_released',
	/** An offline sale time that is in the future or too old to trust. */
	'sale_time_suspicious',
	/**
	 * The till sale itself was flagged for a manager (its clock, who it names,
	 * or its fiscal chain), so it earns only once someone looks.
	 */
	'sale_flagged',
	/** Reconciliation kept failing for this source. */
	'reconciliation_failed',
	/**
	 * A till sale that would push the member's register earnings for the
	 * organization-local day past LOYALTY_POS_DAILY_EARN_REVIEW_POINTS: it
	 * earns only once an operator awards it from the review queue.
	 */
	'large_earn',
] as const
export type LoyaltyReviewReason = (typeof LOYALTY_REVIEW_REASONS)[number]

/** How long a reserved (unbound) hold lasts before it may be released. */
export const LOYALTY_RESERVATION_TTL_MS = 15 * 60_000
