import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { loyaltyErrorInfo } from './loyalty-client.ts'

/** One translated sentence for a failed loyalty call; falls back to `fallback`. */

const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	loyalty_unavailable: msg`Loyalty is temporarily unavailable in this region. Try again in a moment.`,
	loyalty_disabled: msg`Loyalty is turned off for this organization.`,
	redemption_disabled: msg`Redeeming rewards is turned off for this organization.`,
	program_not_found: msg`There is no loyalty program yet.`,
	program_inactive: msg`The program is not active.`,
	member_not_found: msg`This points account no longer exists.`,
	member_inactive: msg`This points account is suspended.`,
	reward_not_found: msg`This reward no longer exists.`,
	reward_unavailable: msg`This reward is not available.`,
	stale_version: msg`Someone else saved changes first. Reload to see the latest version, then try again.`,
	idempotency_conflict: msg`This request conflicts with an earlier one. Reload and try again.`,
	redemption_not_found: msg`This redemption no longer exists.`,
	purchase_not_found: msg`This sale no longer exists.`,
	invalid_transition: msg`That change is no longer possible. Reload to see the latest state.`,
	adjustment_invalid: msg`That adjustment is not valid. Check the amount and try again.`,
	adjustment_limit: msg`This goes over the most points one person can add in 24 hours. Add fewer points, or ask someone else who can adjust points.`,
	config_invalid: msg`The configuration is not valid. Check the fields and try again.`,
	location_forbidden: msg`You do not have access to this location.`,
	unauthorized_scope: msg`You do not have permission to do that.`,
	forbidden_grant: msg`You do not have permission to do that.`,
	rate_limited: msg`Too many requests. Wait a moment and try again.`,
	invalid_request: msg`The request was rejected. Check the fields and try again.`,
	refund_exceeds_payment: msg`The refund is larger than what was paid.`,
	refund_not_online: msg`Only a tab paid from the guest's phone can be refunded here.`,
	refund_not_paid: msg`Only a paid tab can be refunded.`,
	currency_mismatch: msg`The currency does not match the program's currency.`,
}

const STATUS_MESSAGES: Record<number, MessageDescriptor> = {
	401: msg`Your session has ended. Sign in again to keep working.`,
	403: msg`You do not have permission to do that.`,
	404: msg`This no longer exists. Reload to see the latest state.`,
	409: msg`Someone else changed this first. Reload and try again.`,
	429: msg`Too many requests. Wait a moment and try again.`,
	503: msg`Loyalty is temporarily unavailable in this region. Try again in a moment.`,
}

export function loyaltyErrorMessage(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const { code, status } = loyaltyErrorInfo(error)
	if (code && ERROR_MESSAGES[code]) return translate(ERROR_MESSAGES[code]!)
	if (status && STATUS_MESSAGES[status])
		return translate(STATUS_MESSAGES[status]!)
	return translate(fallback)
}
