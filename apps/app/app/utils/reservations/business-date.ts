import { currentBusinessDate, isValidTimeZone } from '@repo/reservations'

export type BusinessDateStyle = 'short' | 'medium' | 'long'

const BUSINESS_DATE_STYLES: Record<
	BusinessDateStyle,
	Intl.DateTimeFormatOptions
> = {
	/** `Sun, Oct 18` */
	short: { weekday: 'short', month: 'short', day: 'numeric' },
	/** `Oct 18, 2026` */
	medium: { year: 'numeric', month: 'short', day: 'numeric' },
	/** `Sunday, October 18, 2026` */
	long: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
}

/**
 * The one way to show a `YYYY-MM-DD` business date to a person, in the app
 * locale. A business date is already the calendar day at the location (see
 * `serviceDayBusinessDate`), so it is formatted as a plain calendar date (noon
 * UTC, `timeZone: 'UTC'`): converting it through the viewer's or the
 * location's zone again would shift it by a day. Never render the raw string in
 * JSX; unparseable input comes back unchanged.
 */
export function formatBusinessDate(
	date: string,
	locale: string,
	style: BusinessDateStyle | Intl.DateTimeFormatOptions = 'medium',
): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
	const parsed = new Date(`${date}T12:00:00Z`)
	if (Number.isNaN(parsed.getTime())) return date
	try {
		return new Intl.DateTimeFormat(locale, {
			...(typeof style === 'string' ? BUSINESS_DATE_STYLES[style] : style),
			timeZone: 'UTC',
		}).format(parsed)
	} catch {
		return date
	}
}

/** `Oct 18, 2026`, or `Oct 18, 2026 → Oct 20, 2026` for a range. */
export function formatBusinessDateRange(
	from: string,
	to: string,
	locale: string,
	style: BusinessDateStyle = 'medium',
): string {
	const start = formatBusinessDate(from, locale, style)
	if (from === to) return start
	return `${start} → ${formatBusinessDate(to, locale, style)}`
}

/** Matches the tenant-api default for `rsvLocationSettings.dayStartMin`. */
export const DEFAULT_DAY_START_MIN = 240

/**
 * The business date an instant falls on for a location: the calendar date in
 * the location's time zone of (instant - day start). The UTC date is wrong for
 * most of the evening west of UTC and in the early hours of the next day.
 */
export function serviceDayBusinessDate(
	nowMs: number,
	timeZone: string | null | undefined,
	dayStartMin: number | null | undefined = DEFAULT_DAY_START_MIN,
): string {
	const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC'
	const start =
		typeof dayStartMin === 'number' && Number.isFinite(dayStartMin)
			? dayStartMin
			: DEFAULT_DAY_START_MIN
	return currentBusinessDate(nowMs, zone, start)
}
