import {
	parseBirthMonthDay,
	toBirthMonthDay,
} from '@repo/common/birthday'

/**
 * The profile's optional birthday (#151) is two number fields, month and day
 * (no year). Both empty clears it; both filled sets it; only one filled or a
 * date that does not exist is incomplete and is not sent.
 */

/** Sent to the store when both fields are filled but are not a real date, so it answers `invalidBirthday`. */
export const INVALID_BIRTHDAY = '00-00'

/** `MM-DD` into the two field texts (empty when there is none). */
export function splitBirthMonthDay(value: string | null | undefined): {
	month: string
	day: string
} {
	const parsed = parseBirthMonthDay(value)
	if (!parsed) return { month: '', day: '' }
	return {
		month: String(Number(parsed.slice(0, 2))),
		day: String(Number(parsed.slice(3, 5))),
	}
}

/**
 * What to send: `MM-DD`, `null` (both empty: clear), or `undefined` (leave it
 * alone: one half missing, or not a real date).
 */
export function birthMonthDayFromFields(
	month: string,
	day: string,
): string | null | undefined {
	const m = month.trim()
	const d = day.trim()
	if (!m && !d) return null
	if (!m || !d || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return undefined
	return toBirthMonthDay(Number(m), Number(d)) ?? undefined
}
