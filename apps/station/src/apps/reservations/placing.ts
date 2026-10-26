import { type WaitlistEntry } from '@repo/reservations'
import { coversHere } from './arrival.ts'
import {
	DEFAULT_TURN_MIN,
	type DayReservation,
	type PartyToPlace,
} from './feed.ts'

/** What the host has picked up to place on the floor. */
export type Placing =
	| {
			kind: 'reservation'
			reservation: DayReservation
			/**
			 * Only this many of the party are seated now ("Seat 3 now"): the
			 * rest follow. Absent for a whole party.
			 */
			covers?: number
	  }
	| { kind: 'waitlist'; entry: WaitlistEntry }
	/** A party already seated, picked up to be moved to another table. */
	| { kind: 'move'; reservation: DayReservation }
	/**
	 * A booking with no table, picked up to be given one (not seated): a tap on
	 * a table puts it there for its own time.
	 */
	| { kind: 'assign'; reservation: DayReservation }
	| {
			kind: 'walk_in'
			partySize: number
			guestName: string
			/** One per party: a retry after no answer can never seat them twice. */
			key: string
			/** The same for seating them anyway, over a booking. */
			overbookKey: string
	  }

/**
 * A booking picked up to be seated. One only partly at the stand (arrived,
 * short of its size) is picked up as the ones who are here: "Seat 3 now".
 */
export const reservationPlacing = (reservation: DayReservation): Placing => {
	const partly = coversHere(reservation)
	return partly && partly.stage === 'door'
		? { kind: 'reservation', reservation, covers: partly.here }
		: { kind: 'reservation', reservation }
}

export const placingSize = (p: Placing) =>
	p.kind === 'reservation'
		? (p.covers ?? p.reservation.partySize)
		: p.kind === 'move' || p.kind === 'assign'
			? p.reservation.partySize
			: p.kind === 'waitlist'
				? p.entry.partySize
				: p.partySize

/**
 * The party in hand as the floor judges a table for it: how many, for how
 * long, and the window it would hold a table. A booking is seated against its
 * own booked window (the server checks a seating against it), a party moved
 * has the rest of its stay left, and one seated now (a walk-in, the waitlist)
 * gets a turn from now.
 */
export function partyToPlace(p: Placing, now: number): PartyToPlace {
	if (p.kind === 'reservation' || p.kind === 'assign')
		return {
			partySize: placingSize(p),
			durationMin: p.reservation.durationMin,
			reservationId: p.reservation.id,
			startAt: p.reservation.startAt,
			endAt: p.reservation.endAt,
			...(p.kind === 'assign' ? { future: true } : {}),
		}
	if (p.kind === 'move')
		return {
			partySize: placingSize(p),
			// A party moved has the rest of their stay left, not a whole turn.
			durationMin: Math.max(
				15,
				Math.ceil((p.reservation.endAt - now) / 60_000),
			),
			reservationId: p.reservation.id,
		}
	return { partySize: placingSize(p), durationMin: DEFAULT_TURN_MIN }
}

export const placingKey = (p: Placing | null) =>
	!p
		? null
		: p.kind === 'reservation'
			? `r:${p.reservation.id}`
			: p.kind === 'move'
				? `m:${p.reservation.id}`
				: p.kind === 'assign'
					? `a:${p.reservation.id}`
					: p.kind === 'waitlist'
						? `w:${p.entry.id}`
						: 'walk-in'
