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
	| 'errorLargeParty'
	| 'errorRequestsClosed'
	| 'errorPartySize'
	| 'errorInvalid'
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
	large_party: 'errorLargeParty',
	requests_closed: 'errorRequestsClosed',
	party_size_invalid: 'errorPartySize',
	invalid: 'errorInvalid',
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
