import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type LoyaltyAdjustmentReason,
	type LoyaltyChannel,
	type LoyaltyEarningMethod,
	type LoyaltyLedgerType,
	type LoyaltyMemberStatus,
	type LoyaltyProgramStatus,
	type LoyaltyPurchaseSource,
	type LoyaltyPurchaseState,
	type LoyaltyRedemptionState,
	type LoyaltyReviewReason,
	type LoyaltyRewardKind,
	type LoyaltyRewardStatus,
	type LoyaltyUnitLabel,
} from '@repo/loyalty'

/**
 * Display labels for the enums the loyalty API returns. Callers render them
 * with `i18n._(descriptor)` through `loyaltyEnumLabel`, so no raw enum value
 * reaches the screen for a known value.
 */

export const LOYALTY_PROGRAM_STATUS_LABELS: Record<
	LoyaltyProgramStatus,
	MessageDescriptor
> = {
	draft: msg`Draft`,
	active: msg`Active`,
	paused: msg`Paused`,
}

export const LOYALTY_UNIT_LABEL_LABELS: Record<
	LoyaltyUnitLabel,
	MessageDescriptor
> = {
	points: msg`Points`,
	stars: msg`Stars`,
}

export const LOYALTY_EARNING_METHOD_LABELS: Record<
	LoyaltyEarningMethod,
	MessageDescriptor
> = {
	spend: msg`Amount spent`,
	visit: msg`Per visit`,
	items: msg`Selected items`,
	categories: msg`Selected categories`,
}

export const LOYALTY_REWARD_KIND_LABELS: Record<
	LoyaltyRewardKind,
	MessageDescriptor
> = {
	order: msg`Whole order discount`,
	categories: msg`Category discount`,
	items: msg`Item discount`,
	free_item: msg`Free item`,
}

export const LOYALTY_REWARD_STATUS_LABELS: Record<
	LoyaltyRewardStatus,
	MessageDescriptor
> = {
	active: msg`Active`,
	archived: msg`Archived`,
}

export const LOYALTY_MEMBER_STATUS_LABELS: Record<
	LoyaltyMemberStatus,
	MessageDescriptor
> = {
	active: msg`Active`,
	suspended: msg`Suspended`,
	erased: msg`Erased`,
}

export const LOYALTY_ADJUSTMENT_REASON_LABELS: Record<
	LoyaltyAdjustmentReason,
	MessageDescriptor
> = {
	goodwill: msg`Goodwill`,
	correction: msg`Correction`,
	service_recovery: msg`Service recovery`,
	fraud: msg`Fraud`,
	other: msg`Other`,
}

export const LOYALTY_LEDGER_TYPE_LABELS: Record<
	LoyaltyLedgerType,
	MessageDescriptor
> = {
	earn: msg`Earned`,
	earn_reversal: msg`Earning reversed`,
	redeem: msg`Redeemed`,
	redeem_restore: msg`Redemption restored`,
	adjust: msg`Adjusted`,
}

export const LOYALTY_CHANNEL_LABELS: Record<LoyaltyChannel, MessageDescriptor> =
	{
		web: msg`Online`,
		pos: msg`Register`,
		qr: msg`QR ordering`,
		native: msg`Mobile app`,
	}

export const LOYALTY_PURCHASE_SOURCE_LABELS: Record<
	LoyaltyPurchaseSource,
	MessageDescriptor
> = {
	restaurant_order: msg`Online order`,
	qr_tab: msg`QR tab`,
	pos_order: msg`Register sale`,
}

export const LOYALTY_PURCHASE_STATE_LABELS: Record<
	LoyaltyPurchaseState,
	MessageDescriptor
> = {
	open: msg`Open`,
	completed: msg`Completed`,
	review: msg`Needs review`,
	excluded: msg`Excluded`,
}

export const LOYALTY_REDEMPTION_STATE_LABELS: Record<
	LoyaltyRedemptionState,
	MessageDescriptor
> = {
	reserved: msg`Reserved`,
	bound: msg`Bound to a sale`,
	consumed: msg`Consumed`,
	released: msg`Released`,
	review: msg`Needs review`,
	restored: msg`Restored`,
}

export const LOYALTY_REVIEW_REASON_LABELS: Record<
	LoyaltyReviewReason,
	MessageDescriptor
> = {
	payment_uncertain: msg`Payment uncertain`,
	completed_unpaid: msg`Completed without a recorded payment`,
	upload_held: msg`Upload held for review`,
	upload_missing: msg`Sale upload missing`,
	upload_mismatch: msg`Uploaded discount does not match`,
	device_mismatch: msg`Reward approved on another terminal`,
	redemption_unknown: msg`Unknown redemption on the sale`,
	redemption_released: msg`Redemption was already released`,
	sale_time_suspicious: msg`Suspicious sale time`,
	sale_flagged: msg`Register sale flagged for review`,
	reconciliation_failed: msg`Reconciliation failed`,
	large_earn: msg`Large register earnings for the day`,
}

function humanize(value: string): string {
	const text = value.replace(/[_-]+/g, ' ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Renders a known enum through Lingui; unknown values fall back to readable text. */
export function loyaltyEnumLabel(
	translate: (descriptor: MessageDescriptor) => string,
	labels: Record<string, MessageDescriptor>,
	value: string | null | undefined,
): string {
	if (!value) return ''
	const descriptor = labels[value]
	return descriptor ? translate(descriptor) : humanize(value)
}
