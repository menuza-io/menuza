/**
 * Small, dependency-free time zone helpers built on Intl. All instants are
 * epoch milliseconds (UTC). "Local" values are wall-clock values in an IANA
 * zone. Dates are `YYYY-MM-DD` strings in the scope timezone.
 *
 * DST rules used everywhere in staffing:
 *  - A wall-clock time that does not exist (spring-forward gap) resolves to the
 *    instant after the gap, using the offset in force before the change.
 *  - A wall-clock time that happens twice (fall-back) resolves to the first
 *    (earlier) instant.
 */
const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
		})
		formatters.set(timeZone, formatter)
	}
	return formatter
}

export function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value })
		return true
	} catch {
		return false
	}
}

export type LocalParts = {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	second: number
}

export function localParts(ms: number, timeZone: string): LocalParts {
	const out: Record<string, number> = {}
	for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
		if (part.type !== 'literal') out[part.type] = Number(part.value)
	}
	return {
		year: out.year!,
		month: out.month!,
		day: out.day!,
		hour: out.hour! === 24 ? 0 : out.hour!,
		minute: out.minute!,
		second: out.second!,
	}
}

/** Offset of the zone from UTC at an instant, in milliseconds (local minus UTC). */
export function tzOffsetMs(ms: number, timeZone: string): number {
	const p = localParts(ms, timeZone)
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
	return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * Convert a wall-clock time in `timeZone` to an instant. `month` is 1-12.
 * Minutes may exceed 59 and hours may exceed 23; the wall-clock value is
 * normalized first (so 24:00 is midnight of the next day).
 */
export function zonedLocalToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): number {
	const naive = Date.UTC(year, month - 1, day, hour, minute, 0)
	const before = tzOffsetMs(naive - MS_PER_DAY, timeZone)
	const after = tzOffsetMs(naive + MS_PER_DAY, timeZone)
	const candidates = [...new Set([before, after])]
		.map((offset) => naive - offset)
		.sort((a, b) => a - b)
	for (const candidate of candidates) {
		if (tzOffsetMs(candidate, timeZone) + candidate === naive) return candidate
	}
	// Wall-clock time falls in a spring-forward gap: use the earlier offset so
	// the result lands just after the gap.
	return naive - before
}

export function formatDate(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseDate(date: string): {
	year: number
	month: number
	day: number
} {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return { year, month, day }
}

/** Add whole calendar days to a `YYYY-MM-DD` date (pure calendar math). */
export function addDays(date: string, days: number): string {
	const { year, month, day } = parseDate(date)
	const d = new Date(Date.UTC(year, month - 1, day + days))
	return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** Alias for `addDays`. */
export const addLocalDays = addDays

/** Day of week for a calendar date: 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: string): number {
	const { year, month, day } = parseDate(date)
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** First day of the workweek containing `date`. `weekStartsOn`: 0 = Sunday. */
export function weekStartFor(date: string, weekStartsOn: number): string {
	const back = (dayOfWeek(date) - weekStartsOn + 7) % 7
	return addDays(date, -back)
}

/** The instant a business day begins: local midnight plus `workdayStartMinute`. */
export function businessDayStartMs(
	date: string,
	timeZone: string,
	workdayStartMinute: number,
): number {
	const { year, month, day } = parseDate(date)
	return zonedLocalToUtc(
		year,
		month,
		day,
		Math.floor(workdayStartMinute / 60),
		workdayStartMinute % 60,
		timeZone,
	)
}

/** Local midnight (`00:00`) for `date` in `timeZone`. */
export function startOfLocalDay(date: string, timeZone: string): number {
	return businessDayStartMs(date, timeZone, 0)
}

/** Minutes since local midnight (`0..1439`) for `ms` in `timeZone`. */
export function localMinutesSinceMidnight(
	ms: number,
	timeZone: string,
): number {
	const p = localParts(ms, timeZone)
	return p.hour * 60 + p.minute
}

/** Parse a `YYYY-MM-DDTHH:mm` (or `YYYY-MM-DD HH:mm`) wall-clock string in `timeZone` to epoch ms. */
export function parseLocalTimestamp(
	timestamp: string,
	timeZone: string,
): number {
	const match =
		/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
			timestamp.trim(),
		)
	if (!match) {
		throw new Error(`Invalid local timestamp: ${timestamp}`)
	}
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const hour = Number(match[4])
	const minute = Number(match[5])
	const second = match[6] ? Number(match[6]) : 0
	// Reject values the calendar would silently roll over (Feb 31, 25:99).
	const rolled = new Date(Date.UTC(year, month - 1, day))
	if (
		month < 1 ||
		month > 12 ||
		rolled.getUTCMonth() !== month - 1 ||
		rolled.getUTCDate() !== day ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new Error(`Invalid local timestamp: ${timestamp}`)
	}
	return (
		zonedLocalToUtc(year, month, day, hour, minute, timeZone) + second * 1000
	)
}

/**
 * The business date an instant belongs to. With `workdayStartMinute` of 0 this
 * is the plain local calendar date; with 240 a 02:00 punch belongs to the
 * previous day's business date. Resolved against actual day-start instants so
 * it stays consistent across DST changes.
 */
export function businessDateOf(
	ms: number,
	timeZone: string,
	workdayStartMinute = 0,
): string {
	const p = localParts(ms, timeZone)
	let date = formatDate(p.year, p.month, p.day)
	if (ms < businessDayStartMs(date, timeZone, workdayStartMinute)) {
		date = addDays(date, -1)
	} else if (
		ms >= businessDayStartMs(addDays(date, 1), timeZone, workdayStartMinute)
	) {
		date = addDays(date, 1)
	}
	return date
}

export function minutesBetween(startMs: number, endMs: number): number {
	return Math.round((endMs - startMs) / MS_PER_MINUTE)
}

export function floorToMinute(ms: number): number {
	return Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
	const a = parseDate(from)
	const b = parseDate(to)
	return Math.round(
		(Date.UTC(b.year, b.month - 1, b.day) -
			Date.UTC(a.year, a.month - 1, a.day)) /
			MS_PER_DAY,
	)
}
