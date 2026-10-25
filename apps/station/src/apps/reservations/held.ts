import {
	isWaitingAtStand,
	minutesLate,
	type DayReservation,
	type TableState,
} from './feed.ts'

/** A table kept for a party that is due soon, or is already late (or at the stand). */
export type Held = {
	reservation: DayReservation
	/** Minutes past the booked time (0 when not late yet). */
	lateMin: number
	/** They are here, waiting to be seated. */
	atStand: boolean
	/** The till can seat them: a booking that is expected or at the stand. */
	canSeat: boolean
}

/** Statuses a till seats a held party from (the server's own transitions). */
const SEATABLE = new Set(['booked', 'confirmed', 'arrived'])

/**
 * The party a table is held for: the next booking, once it is due within the
 * half hour (`soon`), whether or not it is late. Null for a table that is open
 * for the long run, seated or blocked: nothing there to seat first.
 */
export function heldFor(state: TableState, now: number): Held | null {
	if (state.kind !== 'soon') return null
	const r = state.next
	return {
		reservation: r,
		lateMin: minutesLate(r, now),
		atStand: isWaitingAtStand(r),
		canSeat: SEATABLE.has(r.status),
	}
}

/**
 * What a held table's sheet leads with. Seating the held party leads only when
 * they are here to be seated: at the stand, or already late. A party that is
 * merely due is not at the door yet: the table can take a walk-in meanwhile
 * (with the caution that it may delay them), and seating the party is the
 * second choice, one tap away.
 */
export const heldLead = (held: Held): 'party' | 'walk_in' =>
	held.canSeat && (held.atStand || held.lateMin > 0) ? 'party' : 'walk_in'
