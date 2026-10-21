import { formatHhmm } from '@repo/reservations'

const MINUTES_PER_DAY = 1440

/**
 * Resolve a clock time typed into an `HH:MM` input to business-day minutes.
 * Reservation start minutes run past midnight on overnight services (`1470` is
 * 00:30 the next calendar day), but a time input only holds `00:00..23:59`.
 * The result is the reading (`clock` or `clock + 1440`) closest to
 * `referenceMin`, so editing 00:30(+1d) to 00:45 gives `1485`, never `45`, and
 * an 18:00 booking moved to 01:00 stays overnight (`1500`). Returns `null` when
 * the text is not a valid time.
 */
export function resolveEditedStartMin(
	hhmm: string,
	referenceMin: number,
): number | null {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
	if (!match) return null
	const clock = Number(match[1]) * 60 + Number(match[2])
	const baseDay = Math.floor(referenceMin / MINUTES_PER_DAY)
	let best = clock + baseDay * MINUTES_PER_DAY
	for (const dayOffset of [baseDay - 1, baseDay, baseDay + 1]) {
		const candidate = clock + dayOffset * MINUTES_PER_DAY
		if (candidate < 0) continue
		if (
			Math.abs(candidate - referenceMin) < Math.abs(best - referenceMin) ||
			(Math.abs(candidate - referenceMin) === Math.abs(best - referenceMin) &&
				candidate < best)
		) {
			best = candidate
		}
	}
	return best
}

/**
 * The start-time part of an edit request. Empty unless the operator changed the
 * time: a notes-only edit must not resend (and so shift) an unchanged time.
 */
export function startMinPatch(
	originalMin: number,
	editedHhmm: string,
): { localStartMin?: number } {
	if (editedHhmm === formatHhmm(originalMin)) return {}
	const next = resolveEditedStartMin(editedHhmm, originalMin)
	if (next === null || next === originalMin) return {}
	return { localStartMin: next }
}
