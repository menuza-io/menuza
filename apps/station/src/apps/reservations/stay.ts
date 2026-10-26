import { clearAtOf, isOnFloor, type DayReservation } from './feed.ts'

// Lives with the feed (a table's fit for a later booking reads it too); kept here for its callers.
export { clearAtOf }

/**
 * How long a seated party has been at their table, and when the table is
 * expected to clear: the booking's own end (its start plus the stay it was
 * booked for, which "+15 min" lengthens) or, for a party seated late, the
 * stay counted from when they sat. Pure, so the sheet, the table tile and the
 * Seated list all say the same thing.
 */

/** What a seated party's stay looks like right now. */
export type Stay = {
	/** Whole minutes seated so far (never negative). */
	seatedMin: number
	/** When the table is expected to clear (see `clearAtOf`). */
	clearAt: number
	/**
	 * Whole minutes until then, rounded up, never below zero. A table due in
	 * 20 seconds is still "1m left", never "0m left".
	 */
	leftMin: number
	/** Whole minutes past the expected end (0 until it is past). */
	overMin: number
	/** Past the expected end: they are over their time. */
	over: boolean
	/** How far through the stay they are (above 1 once over). */
	ratio: number
}

type StayFields = Pick<
	DayReservation,
	'status' | 'seatedAt' | 'endAt' | 'startAt' | 'durationMin'
>

/** Null for a party that is not seated (or was never marked seated). */
export function stayOf(r: StayFields, now: number): Stay | null {
	if (!isOnFloor(r) || typeof r.seatedAt !== 'number') return null
	const seatedMs = Math.max(0, now - r.seatedAt)
	const seatedMin = Math.floor(seatedMs / 60_000)
	const clearAt = clearAtOf(r)
	const leftMs = clearAt - now
	const over = leftMs <= 0
	return {
		seatedMin,
		clearAt,
		leftMin: over ? 0 : Math.ceil(leftMs / 60_000),
		overMin: over ? Math.max(0, Math.floor(-leftMs / 60_000)) : 0,
		over,
		// Through the stay they actually have: from sitting down to the table clearing.
		ratio: seatedMs / Math.max(60_000, clearAt - r.seatedAt),
	}
}

/** The longest stay a till may set (the server hands a longer one to a manager). */
export const MAX_TILL_STAY_MIN = 360
/** What "+15 min" adds. */
export const EXTEND_STEP_MIN = 15

export type ExtendPlan =
	| {
			ok: true
			/** The new stay in minutes, as the booking holds it (counted from its start). */
			durationMin: number
			/** When the table is then expected to clear. */
			clearAt: number
	  }
	| { ok: false; why: 'too_long' }

/**
 * What "+15 min" does: the table is kept a quarter hour past the later of the
 * booking's end and now (a party already over its time is given a quarter hour
 * from now, not from a time long gone). The stay the server holds is counted
 * from the booking's start, so it is lengthened by however far that takes it;
 * past what a till may set, it is a manager's.
 */
export function extendPlan(
	r: Pick<
		DayReservation,
		'startAt' | 'endAt' | 'durationMin' | 'seatedAt' | 'status'
	>,
	now: number,
): ExtendPlan {
	const newEnd = Math.max(r.endAt, now) + EXTEND_STEP_MIN * 60_000
	const durationMin = Math.max(
		r.durationMin + 1,
		Math.ceil((newEnd - r.startAt) / 60_000),
	)
	if (durationMin > MAX_TILL_STAY_MIN) return { ok: false, why: 'too_long' }
	return {
		ok: true,
		durationMin,
		clearAt: clearAtOf({
			...r,
			durationMin,
			endAt: r.startAt + durationMin * 60_000,
		}),
	}
}

/** Whether a stay can be lengthened by one more step from a till. */
export const canExtendStay = (
	r: Pick<
		DayReservation,
		'startAt' | 'endAt' | 'durationMin' | 'seatedAt' | 'status'
	>,
	now: number,
) => extendPlan(r, now).ok
