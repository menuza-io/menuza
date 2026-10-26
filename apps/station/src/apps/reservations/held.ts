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

/**
 * How many whole minutes a free table stays free: until its next booking,
 * less the minutes the table is kept after a stay (a party seated now must be
 * gone before the reset begins). Zero for a booking already due; null for a
 * table that is not free or has nothing booked after now.
 */
export function freeForMin(
	state: TableState,
	table: { resetBufferMin?: number },
	now: number,
): number | null {
	if (state.kind !== 'open' && state.kind !== 'soon') return null
	const next = state.next
	if (!next) return null
	const left = Math.floor((next.startAt - now) / 60_000)
	return Math.max(0, left - (table.resetBufferMin ?? 0))
}

/**
 * Whether a table's free time is shorter than a party's stay, so seating them
 * would run into the next booking (null free time: never short).
 */
export const runsIntoNext = (freeFor: number | null, stayMin: number) =>
	freeFor !== null && freeFor < stayMin

/** A party this much smaller than half a table leaves it mostly empty. */
export const bigTableFor = (partySize: number, maxCovers: number) =>
	maxCovers >= 2 && partySize * 2 < maxCovers
