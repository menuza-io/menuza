/**
 * Display helpers for the Time clock screens. Times are shown in the
 * scope's own time zone (the zone stored with each entry), never the
 * viewer's, because "9:03 AM" only means something where the workplace is.
 */

/** "9:03 AM" in the given zone. Falls back to the viewer's zone for a bad name. */
export function formatClockTime(
	at: number,
	timeZone: string,
	locale = 'en',
): string {
	const options: Intl.DateTimeFormatOptions = {
		hour: 'numeric',
		minute: '2-digit',
	}
	try {
		return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(at)
	} catch {
		return new Intl.DateTimeFormat(locale, options).format(at)
	}
}

/** 192 -> "3h 12m", 45 -> "45m", 0 -> "0m". Never negative. */
export function formatDuration(
	totalMinutes: number,
	units: { hour: string; minute: string } = { hour: 'h', minute: 'm' },
): string {
	const minutes = Math.max(0, Math.floor(totalMinutes))
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	if (hours === 0) return `${rest}${units.minute}`
	if (rest === 0) return `${hours}${units.hour}`
	return `${hours}${units.hour} ${rest}${units.minute}`
}

export function minutesBetween(from: number, to: number): number {
	return Math.max(0, Math.floor((to - from) / 60_000))
}

/** "2 minutes ago", "just now", "3 days ago". `null` means never. */
export function formatRelativeTime(
	at: number,
	now: number,
	locale = 'en',
): string {
	const seconds = Math.round((at - now) / 1000)
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
	const abs = Math.abs(seconds)
	if (abs < 45) return rtf.format(0, 'second')
	if (abs < 45 * 60) return rtf.format(Math.round(seconds / 60), 'minute')
	if (abs < 22 * 3600) return rtf.format(Math.round(seconds / 3600), 'hour')
	return rtf.format(Math.round(seconds / 86_400), 'day')
}

/** Whole minutes and seconds left, "9:41", never below "0:00". */
export function formatCountdown(remainingMs: number): string {
	const total = Math.max(0, Math.ceil(remainingMs / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** A device that has not been seen for this long is shown as quiet. */
export const DEVICE_QUIET_AFTER_MS = 15 * 60 * 1000

function localDateKey(at: number, timeZone: string): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at)
	} catch {
		return new Intl.DateTimeFormat('en-CA').format(at)
	}
}

/**
 * Like `formatClockTime`, but names the weekday when the moment is not on the
 * same local day as `now` ("Sun 3:21 PM"), so a shift that was never closed
 * does not read as if it started a few hours ago.
 */
export function formatClockDateTime(
	at: number,
	now: number,
	timeZone: string,
	locale = 'en',
): string {
	const time = formatClockTime(at, timeZone, locale)
	if (localDateKey(at, timeZone) === localDateKey(now, timeZone)) return time
	let weekday: string
	try {
		weekday = new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			timeZone,
		}).format(at)
	} catch {
		weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at)
	}
	return `${weekday} ${time}`
}
