/**
 * Purchases: one row per order, QR tab or till sale a member is credited for.
 *
 *   open       claimed by a member (placed signed in, a tab claimed, a till
 *              sale with a member binding); waiting for the sale to finish
 *   completed  paid and finished: evaluated under the program version of its
 *              sale time (it may have earned 0 points, with a skip reason)
 *   review     an operator has to decide (suspicious sale time, unclear payment)
 *   excluded   never qualified (cancelled, rung up elsewhere, currency, ...)
 *
 * The same source can only ever be one purchase, so a sale cannot earn twice.
 * A QR tab is one purchase however many rounds and payments it had; its rounds
 * are never purchases of their own.
 */
export const LOYALTY_PURCHASE_SOURCES = [
	'restaurant_order',
	'qr_tab',
	'pos_order',
] as const
export type LoyaltyPurchaseSource = (typeof LOYALTY_PURCHASE_SOURCES)[number]

/**
 * Till-sale guardrail: when a member's register earnings on one
 * organization-local day (this sale included) pass this many points, the
 * purchase waits in the review queue ('large_earn') instead of earning, until
 * an operator awards it. Blunts a rogue till running big cash sales against
 * an accomplice's member code; website and QR-tab earning are unaffected.
 */
export const LOYALTY_POS_DAILY_EARN_REVIEW_POINTS = 1_000

export const LOYALTY_PURCHASE_STATES = [
	'open',
	'completed',
	'review',
	'excluded',
] as const
export type LoyaltyPurchaseState = (typeof LOYALTY_PURCHASE_STATES)[number]

export const LOYALTY_EXCLUDED_REASONS = [
	/** Cancelled, voided or expired before it was paid. */
	'cancelled',
	/** The organization had loyalty switched off when the sale finished. */
	'loyalty_disabled',
	/** No active program version at the sale time (draft or paused). */
	'program_inactive',
	/** Paid in a currency other than the program's. */
	'currency_mismatch',
	/** The member was suspended or erased. */
	'member_inactive',
	/** A QR tab closed at the counter and rung up on a till: the till sale earns instead. */
	'rung_up_on_station',
	/** An operator decided it should not earn. */
	'operator_excluded',
] as const
export type LoyaltyExcludedReason = (typeof LOYALTY_EXCLUDED_REASONS)[number]

/** Why a completed purchase earned nothing. */
export const LOYALTY_SKIP_REASONS = [
	'below_minimum',
	'visit_already_awarded',
	'nothing_eligible',
] as const
export type LoyaltySkipReason = (typeof LOYALTY_SKIP_REASONS)[number]

export const LOYALTY_SOURCE_CHANNEL = {
	restaurant_order: 'web',
	qr_tab: 'qr',
	pos_order: 'pos',
} as const satisfies Record<LoyaltyPurchaseSource, 'web' | 'qr' | 'pos'>

export const LOYALTY_MEMBER_STATUSES = [
	'active',
	'suspended',
	'erased',
] as const
export type LoyaltyMemberStatus = (typeof LOYALTY_MEMBER_STATUSES)[number]
