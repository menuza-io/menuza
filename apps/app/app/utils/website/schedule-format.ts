import { localParts, zonedLocalToUtc } from '@repo/zoned-time'

/**
 * Times for scheduled publishes and announcement windows (#180, #238): stored
 * in UTC, shown and entered in the site's time zone, so a daylight-saving
 * change never moves "Friday 18:00".
 */

/** "Fri, Jul 4, 18:00" (a date and time) in a time zone and language. */
export function formatSiteDateTime(
	isoOrMs: string | number | Date,
	timeZone: string,
	locale = 'en',
) {
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(isoOrMs))
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The `datetime-local` value (`YYYY-MM-DDTHH:mm`) showing an instant in a zone. */
export function toDateTimeInputValue(
	isoOrMs: string | number | Date,
	timeZone: string,
) {
	const p = localParts(new Date(isoOrMs).getTime(), timeZone)
	return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * The instant a wall-clock `datetime-local` value names in a zone, or null when
 * it is empty, malformed, or does not exist there (the hour skipped when the
 * clocks go forward).
 */
export function fromDateTimeInputValue(
	value: string | null | undefined,
	timeZone: string,
): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(
		value?.trim() ?? '',
	)
	if (!match) return null
	const [, year, month, day, hour, minute] = match.map(Number) as number[]
	const ms = zonedLocalToUtc(year!, month!, day!, hour!, minute!, timeZone)
	if (!Number.isFinite(ms)) return null
	// A wall time inside a skipped hour comes back shifted: refuse it.
	return toDateTimeInputValue(ms, timeZone) === value!.trim()
		? new Date(ms)
		: null
}
