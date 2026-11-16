import { z } from 'zod'

/**
 * Guest birthdays (#151): month and day only, stored as `MM-DD`. The year is
 * never asked for or kept. A birthday is personal data: it is cleared with the
 * person, never exported, never logged, and a refusal never echoes what was
 * submitted (`invalid_birthday` carries no value).
 */

export const BIRTHDAY_ERROR = 'invalid_birthday' as const

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** A valid `MM-DD` (29 February allowed), or null. The value is never reported back. */
export function parseBirthMonthDay(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const match = /^(\d{2})-(\d{2})$/.exec(value)
	if (!match) return null
	const month = Number(match[1])
	const day = Number(match[2])
	if (month < 1 || month > 12) return null
	if (day < 1 || day > DAYS_IN_MONTH[month - 1]!) return null
	return value
}

/** The request field: `MM-DD`, or null to clear. An invalid value fails without its text. */
export const birthMonthDayFieldSchema = z
	.union([z.string(), z.null()])
	.refine((value) => value === null || parseBirthMonthDay(value) !== null, {
		message: BIRTHDAY_ERROR,
	})

/** From the month and day a guest picked (1-12, 1-31): `MM-DD`, or null when it is not a real date. */
export function toBirthMonthDay(month: number, day: number): string | null {
	const text = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
	return parseBirthMonthDay(text)
}

/** The calendar day a birthday is celebrated in a year: 29 February is 28 February in a non-leap year. */
export function birthdayInYear(
	birthMonthDay: string,
	year: number,
): { month: number; day: number } {
	const month = Number(birthMonthDay.slice(0, 2))
	let day = Number(birthMonthDay.slice(3, 5))
	if (month === 2 && day === 29 && !isLeapYear(year)) day = 28
	return { month, day }
}

/** Whole days from one calendar date to another (UTC arithmetic on dates, no zones involved). */
export function daysBetween(
	from: { year: number; month: number; day: number },
	to: { year: number; month: number; day: number },
): number {
	const a = Date.UTC(from.year, from.month - 1, from.day)
	const b = Date.UTC(to.year, to.month - 1, to.day)
	return Math.round((b - a) / 86_400_000)
}

export const BIRTHDAY_SEND_HOUR = 10
export const DEFAULT_BIRTHDAY_DAYS_BEFORE = 7

/**
 * Whether a guest's birthday journey is due, from their local date and hour.
 * It is due `daysBefore` days ahead of the birthday, from 10:00 local time on
 * that day; a pass that missed it still catches up on the following day. The
 * year returned is the year of the birthday being celebrated: the journey fires
 * once per guest per year.
 */
export function birthdayDue(input: {
	birthMonthDay: string
	daysBefore: number
	today: { year: number; month: number; day: number }
	hour: number
}): { due: boolean; year: number } {
	for (const year of [input.today.year, input.today.year + 1]) {
		const occurrence = birthdayInYear(input.birthMonthDay, year)
		const diff = daysBetween(input.today, { year, ...occurrence })
		if (diff < 0) continue
		if (diff === input.daysBefore && input.hour >= BIRTHDAY_SEND_HOUR) {
			return { due: true, year }
		}
		// Missed yesterday (the tick was down): catch up today, at any hour.
		if (diff === input.daysBefore - 1 && input.daysBefore >= 1) {
			return { due: true, year }
		}
		return { due: false, year }
	}
	return { due: false, year: input.today.year }
}

/**
 * The `MM-DD` values whose owners may be due on any local day around a UTC
 * date: lets the SQL prefilter by value instead of reading every guest. A
 * 29 February birthday is celebrated on 28 February in a non-leap year, so
 * `02-29` is included whenever `02-28` is.
 */
export function candidateBirthMonthDays(
	utcDay: { year: number; month: number; day: number },
	daysBefore: number,
): string[] {
	const values = new Set<string>()
	// Local days run from UTC-12 to UTC+14: yesterday to tomorrow, plus one
	// day of catch-up.
	for (let offset = -1; offset <= 1; offset += 1) {
		for (const lead of [daysBefore, daysBefore - 1]) {
			if (lead < 0) continue
			const date = new Date(
				Date.UTC(utcDay.year, utcDay.month - 1, utcDay.day + offset + lead),
			)
			const text = `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
				date.getUTCDate(),
			).padStart(2, '0')}`
			values.add(text)
			if (text === '02-28') values.add('02-29')
		}
	}
	return [...values]
}
