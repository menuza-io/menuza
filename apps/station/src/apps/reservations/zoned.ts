/**
 * Calendar and clock helpers for a location's own time zone. The stand shows
 * one business date at a time and every time in the location's zone, whatever
 * the tablet's zone is. Dates are `YYYY-MM-DD`; clock times are minutes after
 * local midnight.
 */

const formats = new Map<string, Intl.DateTimeFormat>()

function formatFor(timeZone: string) {
	let format = formats.get(timeZone)
	if (!format) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		})
		formats.set(timeZone, format)
	}
	return format
}

/** The zone's wall clock at an instant. */
function wallClock(epochMs: number, timeZone: string) {
	const parts: Record<string, number> = {}
	for (const part of formatFor(timeZone).formatToParts(epochMs)) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value)
	}
	return {
		year: parts.year!,
		month: parts.month!,
		day: parts.day!,
		minutes: (parts.hour! % 24) * 60 + parts.minute!,
		seconds: parts.second!,
	}
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The calendar date in the zone at an instant. */
export function zonedDate(epochMs: number, timeZone: string): string {
	const w = wallClock(epochMs, timeZone)
	return `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

/** Minutes after local midnight in the zone at an instant. */
export function zonedMinutes(epochMs: number, timeZone: string): number {
	return wallClock(epochMs, timeZone).minutes
}

/** The instant a wall-clock time (minutes after midnight) happens on a date in the zone. */
export function zonedEpoch(
	date: string,
	minutes: number,
	timeZone: string,
): number {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const asUtc = Date.UTC(year, month - 1, day, 0, minutes)
	const offset = (guess: number) => {
		const w = wallClock(guess, timeZone)
		return (
			Date.UTC(w.year, w.month - 1, w.day, 0, w.minutes, w.seconds) -
			Math.floor(guess / 1000) * 1000
		)
	}
	// Settle on the instant whose wall clock reads the asked time (two passes cover a DST edge).
	let epoch = asUtc - offset(asUtc)
	epoch = asUtc - offset(epoch)
	return epoch
}

/** A calendar date a number of days later (or earlier). */
export function addDays(date: string, days: number): string {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const moved = new Date(Date.UTC(year, month - 1, day + days))
	return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`
}

/** `07:30` for minutes after midnight (24 hour, the server's slot format). */
export function clockLabel(minutes: number): string {
	const m = ((minutes % 1440) + 1440) % 1440
	return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

export const isDateString = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
