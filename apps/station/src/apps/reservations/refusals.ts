import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type HostApiError } from './api.ts'

/**
 * What a refusal from the server means, in the host's language (the server's
 * own text is English). One honest sentence for each reason the server gives,
 * so "Someone changed this a moment ago" is only said for a changed booking,
 * never for a table that is due to someone else.
 */

/** What the host was doing, for the few reasons that mean different things in each. */
export type RefusalContext =
	/** Making a booking: no availability is the time, not a table. */
	| 'book'
	/** Lengthening a stay: a longer one is a manager's. */
	| 'stay'
	/** Marking a party partly here or partly seated. */
	| 'partial'
	/** Reopening a no-show. */
	| 'reopen'

/**
 * A refusal that is about the table chosen, not about the party: the party is
 * put back in hand so the next tap is another table.
 */
export function wantsAnotherTable(failure: HostApiError | null): boolean {
	return (
		failure !== null &&
		[
			'locked_table_conflict',
			'table_blocked',
			'table_occupied',
			'reflow_failed',
			'no_availability',
		].includes(failure.code)
	)
}

export function refusalMessage(
	failure: HostApiError | null,
	context?: RefusalContext,
): MessageDescriptor {
	switch (failure?.code) {
		case 'manager_required':
			return context === 'stay'
				? msg`A longer stay is a manager’s to set in the app.`
				: msg`This booking has a payment on it. A manager handles it in the app.`
		case 'guest_permission_required':
			return msg`That needs guest details, which this sign-in does not have.`
		case 'not_for_station':
		case 'undo_not_allowed':
			return msg`That is done in the app, not at a till.`
		case 'not_a_host':
			return msg`You are not on this terminal’s host list.`
		// The next party on the table is locked, here, or due too soon to be moved.
		case 'locked_table_conflict':
			return msg`The next party is due at this table. Choose another table or ask a manager.`
		// A table taped off during their stay is not a table someone is on: no "Seat anyway".
		case 'table_blocked':
			return msg`That table is blocked during their stay.`
		case 'pacing_exceeded':
		case 'pacing_parties_exceeded':
			return msg`That time is full. A manager can allow it.`
		case 'party_too_large_for_table':
			return msg`No room for that many at their table. Move them to a bigger table.`
		case 'reflow_failed':
			return msg`No table fits that now.`
		case 'no_availability':
			return context === 'book'
				? msg`That time is no longer available. Choose another.`
				: msg`No table fits that now.`
		case 'slot_unavailable':
			return msg`That time is no longer available. Choose another.`
		case 'invalid_status':
		case 'reservation_not_active':
			return msg`This booking is no longer open.`
		case 'in_the_past':
			return msg`That time has passed.`
		case 'invalid_status_transition':
			// The server has no such step for a till yet: said as that, not as "changed".
			if (context === 'partial')
				return msg`Marking part of a party is not available from this till yet.`
			if (context === 'reopen')
				return msg`A no-show cannot be reopened from a till. Seat them as a walk-in instead.`
			return msg`That cannot be done to this booking now. Here is the latest.`
		// A till seats today's bookings, and calls a no-show once its time has passed.
		case 'not_today':
		case 'too_early':
		// An undo too late, or onto a table someone else now has: not worth a retry.
		case 'table_occupied':
		case 'undo_window_expired':
		case 'cannot_undo':
			return msg`That cannot be done to this booking now. Here is the latest.`
		case 'closed_day':
			return msg`The restaurant is closed that day.`
		default:
			return msg`That did not go through. Try again.`
	}
}
