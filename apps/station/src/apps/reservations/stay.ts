import { isOnFloor, type DayReservation } from './feed.ts'

/**
 * How long a seated party has been at their table, and when the table is
 * expected to clear: the booking's own end (its start plus the stay it was
 * booked for, which "+15 min" lengthens). Pure, so the sheet, the table tile
 * and the Seated list all say the same thing.
 */

/** What a seated party's stay looks like right now. */
export type Stay = {
	/** Whole minutes seated so far (never negative). */
	seatedMin: number
	/** When the table is expected to clear (the booking's end). */
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
	/** How far through the booked stay they are (above 1 once over). */
	ratio: number
}

/** Null for a party that is not seated (or was never marked seated). */
export function stayOf(
	r: Pick<
		DayReservation,
		'status' | 'seatedAt' | 'endAt' | 'startAt' | 'durationMin'
	>,
	now: number,
): Stay | null {
	if (!isOnFloor(r) || typeof r.seatedAt !== 'number') return null
	const seatedMin = Math.max(0, Math.floor((now - r.seatedAt) / 60_000))
	const leftMs = r.endAt - now
	const over = leftMs <= 0
	return {
		seatedMin,
		clearAt: r.endAt,
		leftMin: over ? 0 : Math.ceil(leftMs / 60_000),
		overMin: over ? Math.max(0, Math.floor(-leftMs / 60_000)) : 0,
		over,
		ratio: seatedMin / Math.max(1, r.durationMin),
	}
}

/** The longest stay a till may set (the server hands a longer one to a manager). */
export const MAX_TILL_STAY_MIN = 360
/** What "+15 min" adds. */
export const EXTEND_STEP_MIN = 15

/** Whether a stay can be lengthened by one more step from a till. */
export const canExtendStay = (r: Pick<DayReservation, 'durationMin'>) =>
	r.durationMin + EXTEND_STEP_MIN <= MAX_TILL_STAY_MIN
