import { ReservationsApiError } from './api.ts'

/** Label keys (see `ReservationLabels`) for the failures a guest can hit. */
export type ReservationErrorKey =
	| 'errorSlotUnavailable'
	| 'errorHoldExpired'
	| 'errorRateLimited'
	| 'errorVerification'
	| 'errorPaused'
	| 'errorNotFound'
	| 'errorPhoneOverlap'
	| 'errorPhoneLimit'
	| 'errorCancelClosed'
	| 'errorModifyClosed'
	| 'errorModifyPayment'
	| 'errorLargeParty'
	| 'errorRequestsClosed'
	| 'errorPartySize'
	| 'errorInvalid'
	| 'errorWaitlistDuplicate'
	| 'errorWaitlistFull'
	| 'errorWaitlistClosed'
	| 'errorWaitlistLinkInvalid'
	| 'errorNotifyClosed'
	| 'errorNotifyLimit'
	| 'errorPolicyRequired'
	| 'errorPaymentUnavailable'
	| 'errorNetwork'
	| 'errorGeneric'

const BY_CODE: Record<string, ReservationErrorKey> = {
	slot_unavailable: 'errorSlotUnavailable',
	hold_expired: 'errorHoldExpired',
	rate_limited: 'errorRateLimited',
	verification_failed: 'errorVerification',
	unavailable: 'errorPaused',
	not_found: 'errorNotFound',
	phone_overlap: 'errorPhoneOverlap',
	phone_active_limit: 'errorPhoneLimit',
	cancel_closed: 'errorCancelClosed',
	modify_closed: 'errorModifyClosed',
	modify_changes_payment: 'errorModifyPayment',
	large_party: 'errorLargeParty',
	requests_closed: 'errorRequestsClosed',
	party_size_invalid: 'errorPartySize',
	invalid: 'errorInvalid',
	already_on_waitlist: 'errorWaitlistDuplicate',
	waitlist_full: 'errorWaitlistFull',
	too_many_active_requests: 'errorNotifyLimit',
	policy_required: 'errorPolicyRequired',
	policy_unavailable: 'errorPaymentUnavailable',
}

/** Chooses which localized message to show; the server stays authoritative. */
export function reservationErrorKey(error: unknown): ReservationErrorKey {
	if (error instanceof ReservationsApiError) {
		const byCode = BY_CODE[error.code]
		if (byCode) return byCode
		if (error.status === 429) return 'errorRateLimited'
		if (error.status === 503) return 'errorPaused'
		if (error.status === 404) return 'errorNotFound'
		return 'errorGeneric'
	}
	return 'errorNetwork'
}

/**
 * The waitlist and notify-me routes answer `404 not_found` for "switched off"
 * and for a bad link alike, so the wording depends on what the guest was doing.
 */
export function waitlistErrorKey(
	error: unknown,
	scope: 'join' | 'status' | 'notify',
): ReservationErrorKey {
	if (
		error instanceof ReservationsApiError &&
		(error.status === 404 || error.code === 'not_found')
	) {
		if (scope === 'join') return 'errorWaitlistClosed'
		if (scope === 'notify') return 'errorNotifyClosed'
		return 'errorWaitlistLinkInvalid'
	}
	return reservationErrorKey(error)
}

/** Field paths the server flagged (`issues[].path`), never any submitted values. */
export function invalidFieldPaths(error: unknown): string[] {
	if (!(error instanceof ReservationsApiError)) return []
	const issues = error.body.issues
	if (!Array.isArray(issues)) return []
	return issues.flatMap((issue) =>
		issue && typeof (issue as { path?: unknown }).path === 'string'
			? [(issue as { path: string }).path]
			: [],
	)
}
