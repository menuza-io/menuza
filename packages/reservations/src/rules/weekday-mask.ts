/**
 * Weekday masks. The persisted/engine mask is Monday-first: bit 0 = Monday ...
 * bit 6 = Sunday. UI and API `daysOfWeek` lists, and JS/`dayOfWeek()` dates,
 * are Sunday-first: 0 = Sunday ... 6 = Saturday. Convert only with the
 * functions in this file; never shift by a weekday value directly.
 */

export const ALL_WEEKDAYS_MASK = 127

/** Sunday-first weekday (0 = Sunday) to its Monday-first mask bit index. */
export function weekdayToMaskBit(weekday: number): number {
	return (weekday + 6) % 7
}

/** Monday-first mask bit index to a Sunday-first weekday. */
export function maskBitToWeekday(bit: number): number {
	return (bit + 1) % 7
}

/** Sunday-first weekday list to the Monday-first mask. Invalid entries are ignored. */
export function uiDaysToMask(days: readonly number[]): number {
	let mask = 0
	for (const d of days) {
		if (Number.isInteger(d) && d >= 0 && d <= 6) {
			mask |= 1 << weekdayToMaskBit(d)
		}
	}
	return mask
}

/** Monday-first mask to a sorted Sunday-first weekday list. */
export function maskToUiDays(mask: number): number[] {
	const days: number[] = []
	for (let weekday = 0; weekday <= 6; weekday++) {
		if ((mask & (1 << weekdayToMaskBit(weekday))) !== 0) days.push(weekday)
	}
	return days
}

/** Whether a Monday-first mask includes a Sunday-first weekday. */
export function maskIncludesWeekday(mask: number, weekday: number): boolean {
	return (mask & (1 << weekdayToMaskBit(weekday))) !== 0
}
