/**
 * The address an operator pastes to connect a Google Calendar (#319), turned
 * into the public iCalendar feed to read. Accepted: the calendar's public or
 * secret iCal address, a `webcal://` link, the "embed" link (`?src=`) and a
 * calendar id. Always https; the host is checked again before every fetch.
 */

export type CalendarAddress =
	| { ok: true; url: string; hint: string }
	| { ok: false; error: 'invalid_calendar_address' }

const MAX_LENGTH = 2000
const GOOGLE_HOSTS = new Set(['calendar.google.com', 'www.google.com'])
const CALENDAR_ID = /^[A-Za-z0-9._%+-]{1,200}@[A-Za-z0-9.-]{1,200}$/u

export function normalizeCalendarAddress(input: unknown): CalendarAddress {
	const fail: CalendarAddress = { ok: false, error: 'invalid_calendar_address' }
	if (typeof input !== 'string') return fail
	const raw = input.trim()
	if (!raw || raw.length > MAX_LENGTH) return fail

	if (CALENDAR_ID.test(raw)) {
		return googleIcal(raw)
	}
	let url: URL
	try {
		url = new URL(raw.replace(/^webcal:\/\//iu, 'https://'))
	} catch {
		return fail
	}
	if (url.protocol !== 'https:' || url.username || url.password) return fail
	// The embed link carries the calendar id in `src`.
	if (
		GOOGLE_HOSTS.has(url.hostname.toLowerCase()) &&
		url.searchParams.has('src')
	) {
		const src = url.searchParams.get('src') ?? ''
		if (CALENDAR_ID.test(src)) return googleIcal(src)
		return fail
	}
	// Any other address is read as it is: the feed is whatever it points at, and
	// the fetch refuses private hosts and anything that is not a calendar.
	return { ok: true, url: url.toString(), hint: hintOf(url) }
}

function googleIcal(calendarId: string): CalendarAddress {
	const url = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`
	return { ok: true, url, hint: 'calendar.google.com' }
}

/** The host only: safe to show, never the path (it can hold the secret). */
export function hintOf(url: URL) {
	return url.hostname.toLowerCase()
}
