import {
	BIRTHDAY_ERROR,
	parseBirthMonthDay,
	toBirthMonthDay,
} from '@repo/common/birthday'

/**
 * Browser half of the optional birthday field (#151): a month and a day, never
 * a year. It is optional everywhere (never blocks a form) and is sent straight
 * to tenant-api with the customer token; Sites never sees it server-side.
 */

export { BIRTHDAY_ERROR }

/** Days a month can have (29 February is allowed). */
export function daysInMonth(month: number): number {
	if (month === 2) return 29
	return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** `MM-DD` into the two select values (`''` for none). */
export function splitBirthMonthDay(value: unknown): {
	month: string
	day: string
} {
	const parsed = parseBirthMonthDay(value)
	if (!parsed) return { month: '', day: '' }
	return { month: String(Number(parsed.slice(0, 2))), day: String(Number(parsed.slice(3, 5))) }
}

/**
 * The value to send: `'MM-DD'`, `null` (both empty: clears it), or `undefined`
 * when only one of the two is chosen (incomplete: not sent, never an error).
 */
export function birthMonthDayFromSelections(
	month: string,
	day: string,
): string | null | undefined {
	if (!month && !day) return null
	if (!month || !day) return undefined
	return toBirthMonthDay(Number(month), Number(day)) ?? undefined
}

/** Reads the field group (`[data-birthday-field]`) out of a form. */
export function readBirthdayField(
	root: ParentNode | null | undefined,
): string | null | undefined {
	const month = root?.querySelector<HTMLSelectElement>('[data-birthday-month]')
	const day = root?.querySelector<HTMLSelectElement>('[data-birthday-day]')
	if (!month || !day) return undefined
	return birthMonthDayFromSelections(month.value, day.value)
}

/** Fills the selects from a stored `MM-DD`. */
export function writeBirthdayField(
	root: ParentNode | null | undefined,
	value: unknown,
): void {
	const month = root?.querySelector<HTMLSelectElement>('[data-birthday-month]')
	const day = root?.querySelector<HTMLSelectElement>('[data-birthday-day]')
	if (!month || !day) return
	const parts = splitBirthMonthDay(value)
	month.value = parts.month
	day.value = parts.day
}
