import { type WaitlistEntry } from '@repo/reservations'
import { type DayReservation } from './feed.ts'

/** What the host has picked up to place on the floor. */
export type Placing =
	| { kind: 'reservation'; reservation: DayReservation }
	| { kind: 'waitlist'; entry: WaitlistEntry }
	/** A party already seated, picked up to be moved to another table. */
	| { kind: 'move'; reservation: DayReservation }
	| {
			kind: 'walk_in'
			partySize: number
			guestName: string
			/** One per party: a retry after no answer can never seat them twice. */
			key: string
			/** The same for seating them anyway, over a booking. */
			overbookKey: string
	  }

export const placingSize = (p: Placing) =>
	p.kind === 'reservation' || p.kind === 'move'
		? p.reservation.partySize
		: p.kind === 'waitlist'
			? p.entry.partySize
			: p.partySize

export const placingKey = (p: Placing | null) =>
	!p
		? null
		: p.kind === 'reservation'
			? `r:${p.reservation.id}`
			: p.kind === 'move'
				? `m:${p.reservation.id}`
				: p.kind === 'waitlist'
					? `w:${p.entry.id}`
					: 'walk-in'
