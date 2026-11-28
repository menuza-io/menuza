import { addDays } from '@repo/zoned-time'

/**
 * Special hours that repeat every year (#242).
 *
 * A special-hours entry has a calendar date and, optionally, `repeatsYearly`.
 * A repeating entry applies on the same month and day of every later year (never
 * before its own date). The one rule every channel reads (ordering, Sites, the
 * phone agent, reservations, listing sync, delivery apps, inventory):
 *
 * 1. an entry for exactly that date wins, a one-off before a repeating one;
 * 2. else a repeating entry with the same month and day that started on or
 *    before that date (the most recently started one when several match).
 *
 * Repeating is by calendar month and day, so 29 February applies only in leap
 * years, and holidays that move (Eid, Easter, Thanksgiving) stay one-off.
 */

export type RepeatableSpecialHour = {
	date: string
	repeatsYearly?: boolean | null
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function monthDay(date: string): string {
	return date.slice(5)
}

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Whether `date` is a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(date: string): boolean {
	const match = DATE_RE.exec(date)
	if (!match) return false
	const [year, month, day] = [
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
	]
	if (month < 1 || month > 12 || day < 1) return false
	const days = [
		31,
		isLeapYear(year) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1]!
	return day <= days
}

/**
 * The entry that rules `date`: an exact-date entry first (a one-off before a
 * repeating one), else the latest-started repeating entry on the same month and
 * day. `undefined` when none applies.
 */
export function findSpecialHourForDate<T extends RepeatableSpecialHour>(
	entries: readonly T[] | null | undefined,
	date: string,
): T | undefined {
	if (!entries || entries.length === 0) return undefined
	let exactRepeating: T | undefined
	let yearly: T | undefined
	const md = monthDay(date)
	for (const entry of entries) {
		if (entry.date === date) {
			if (!entry.repeatsYearly) return entry
			exactRepeating ??= entry
			continue
		}
		if (
			entry.repeatsYearly &&
			entry.date < date &&
			monthDay(entry.date) === md &&
			(!yearly || entry.date > yearly.date)
		) {
			yearly = entry
		}
	}
	return exactRepeating ?? yearly
}

/**
 * The next date on or after `from` the entry applies on: its own date while that
 * is still ahead, else (for a repeating one) the next year with that month and
 * day (29 February skips to the next leap year). `null` for a one-off that is
 * in the past.
 */
export function nextSpecialHourDate(
	entry: RepeatableSpecialHour,
	from: string,
): string | null {
	const match = DATE_RE.exec(entry.date)
	if (!match) return null
	if (entry.date >= from) return entry.date
	if (!entry.repeatsYearly) return null
	const month = Number(match[2])
	const day = Number(match[3])
	let year = Number(from.slice(0, 4))
	for (let i = 0; i < 9; i++, year++) {
		const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
		if (candidate >= from && isCalendarDate(candidate)) return candidate
	}
	return null
}

/**
 * The entries as plain dated entries over `fromDate..toDate` (inclusive): each
 * repeating entry becomes one entry per occurrence inside the range
 * (`repeatsYearly` removed), one-off entries stay, and an exact-year entry
 * replaces a repeating one on the same date. Sorted by date. For channels that
 * need a dated list (listing sync, delivery apps, the phone agent's prompt).
 */
export function expandSpecialHours<T extends RepeatableSpecialHour>(
	entries: readonly T[] | null | undefined,
	fromDate: string,
	toDate: string,
): Array<Omit<T, 'repeatsYearly'>> {
	if (!entries || entries.length === 0) return []
	const out = new Map<string, Omit<T, 'repeatsYearly'>>()
	const candidates = new Set<string>()
	for (const entry of entries) {
		if (!DATE_RE.test(entry.date)) continue
		if (entry.date >= fromDate && entry.date <= toDate) {
			candidates.add(entry.date)
		}
		if (entry.repeatsYearly) {
			let next = nextSpecialHourDate(entry, fromDate)
			let guard = 0
			while (next && next <= toDate && guard++ < 12) {
				candidates.add(next)
				next = nextSpecialHourDate(entry, addDays(next, 1))
			}
		}
	}
	for (const date of candidates) {
		const entry = findSpecialHourForDate(entries, date)
		if (!entry) continue
		const { repeatsYearly: ignoredRepeat, ...rest } = entry as T & {
			repeatsYearly?: boolean | null
		}
		out.set(date, { ...rest, date } as unknown as Omit<T, 'repeatsYearly'>)
	}
	return [...out.values()].sort((a, b) =>
		(a as RepeatableSpecialHour).date.localeCompare(
			(b as RepeatableSpecialHour).date,
		),
	)
}

/** One year of lookahead: what listing sync and delivery apps are sent. */
export const SPECIAL_HOURS_HORIZON_DAYS = 365

/** The last date of the lookahead that starts on `from`. */
export function specialHoursHorizonEnd(from: string): string {
	return addDays(from, SPECIAL_HOURS_HORIZON_DAYS)
}
