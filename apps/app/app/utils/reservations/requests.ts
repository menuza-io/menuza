/**
 * Large-party requests from the public site are stored as `pending_approval`
 * and named `requested` in the public API; accept both spellings.
 */
export function isPendingRequestStatus(status: string | null | undefined) {
	return status === 'pending_approval' || status === 'requested'
}

export type DecidedRequest = {
	id: string
	outcome: 'approved' | 'declined'
	guestName: string
	partySize: number
	hhmm: string
}

/** Requests still waiting for a decision, hiding rows decided in this session. */
export function selectPendingRequests<T extends { id: string; status: string }>(
	reservations: readonly T[],
	decided: ReadonlyMap<string, DecidedRequest>,
) {
	return reservations.filter(
		(rsv) => isPendingRequestStatus(rsv.status) && !decided.has(rsv.id),
	)
}
