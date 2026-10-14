import {
	localParts,
	parseDate,
	formatDate,
	addDays,
	zonedLocalToUtc,
} from './tz.ts'

/**
 * Local-time input for time cards. A manager types "22:00 to 02:00" for a
 * night shift; the server turns that into instants in the SCOPE's time zone
 * (never the browser's), rolling past midnight and resolving daylight-saving
 * gaps and repeats with the shared rules in `tz.ts`.
 */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function minutesOfDay(hhmm: string): [number, number] {
	const [h, m] = hhmm.split(':').map(Number) as [number, number]
	return [h, m]
}

/** The instant of `hhmm` on calendar `date` in `timeZone`. */
export function localTimeToInstant(
	date: string,
	hhmm: string,
	timeZone: string,
): number {
	const { year, month, day } = parseDate(date)
	const [h, m] = minutesOfDay(hhmm)
	return zonedLocalToUtc(year, month, day, h, m, timeZone)
}

/**
 * Clock-in and clock-out from a date and two times of day. An end that is not
 * after the start belongs to the next day (an overnight shift); a 22:00-22:00
 * card is 24 hours, never zero.
 */
export function resolveLocalCardTimes(
	input: { date: string; startTime: string; endTime: string },
	timeZone: string,
): { clockInAt: number; clockOutAt: number } {
	const clockInAt = localTimeToInstant(input.date, input.startTime, timeZone)
	let clockOutAt = localTimeToInstant(input.date, input.endTime, timeZone)
	if (clockOutAt <= clockInAt) {
		clockOutAt = localTimeToInstant(
			addDays(input.date, 1),
			input.endTime,
			timeZone,
		)
	}
	return { clockInAt, clockOutAt }
}

/**
 * A break typed as times of day inside a card: the start is the first moment at
 * or after the card's clock-in that reads `startTime`, and the end is the first
 * moment after the start that reads `endTime`.
 */
export function resolveLocalBreakTimes(
	input: { startTime: string; endTime: string },
	clockInAt: number,
	timeZone: string,
): { startAt: number; endAt: number } {
	const p = localParts(clockInAt, timeZone)
	const date = formatDate(p.year, p.month, p.day)
	let startAt = localTimeToInstant(date, input.startTime, timeZone)
	if (startAt < clockInAt) {
		startAt = localTimeToInstant(addDays(date, 1), input.startTime, timeZone)
	}
	const startParts = localParts(startAt, timeZone)
	const startDate = formatDate(
		startParts.year,
		startParts.month,
		startParts.day,
	)
	let endAt = localTimeToInstant(startDate, input.endTime, timeZone)
	if (endAt <= startAt) {
		endAt = localTimeToInstant(addDays(startDate, 1), input.endTime, timeZone)
	}
	return { startAt, endAt }
}
