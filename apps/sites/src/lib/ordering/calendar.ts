export type IcsEventInput = {
	title: string
	start: Date
	end: Date
	location?: string | null
	description?: string | null
	url?: string | null
	/** Stable identifier; defaults to a hash of the event fields. */
	uid?: string
	/** Timestamp for DTSTAMP; defaults to now. */
	now?: Date
}

const CRLF = '\r\n'

function pad(value: number): string {
	return value.toString().padStart(2, '0')
}

/** RFC 5545 UTC date-time: 20261009T140000Z */
export function formatIcsUtc(date: Date): string {
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
	)
}

/** Escapes text per RFC 5545 section 3.3.11. */
export function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Folds a content line at 75 octets as required by RFC 5545 section 3.1.
 * Splitting on code points keeps multi-byte characters intact; the limit is
 * approximate for non-ASCII text, which calendar clients tolerate.
 */
function foldLine(line: string): string {
	const chars = Array.from(line)
	if (chars.length <= 75) return line
	const parts: string[] = []
	let index = 0
	let width = 75
	while (index < chars.length) {
		parts.push(chars.slice(index, index + width).join(''))
		index += width
		width = 74
	}
	return parts.join(`${CRLF} `)
}

function simpleHash(value: string): string {
	let hash = 5381
	for (let index = 0; index < value.length; index++) {
		hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
	}
	return hash.toString(36)
}

export function buildIcs(input: IcsEventInput): string {
	const start = input.start
	const end = input.end.getTime() > start.getTime() ? input.end : start
	const stamp = input.now ?? new Date()
	const uid =
		input.uid ??
		`${simpleHash(`${input.title}|${start.toISOString()}|${input.url ?? ''}`)}@menuza`
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Menuza//Sites//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		`DTSTAMP:${formatIcsUtc(stamp)}`,
		`DTSTART:${formatIcsUtc(start)}`,
		`DTEND:${formatIcsUtc(end)}`,
		`SUMMARY:${escapeIcsText(input.title)}`,
	]
	if (input.location) lines.push(`LOCATION:${escapeIcsText(input.location)}`)
	if (input.description)
		lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`)
	if (input.url) lines.push(`URL:${input.url}`)
	lines.push('END:VEVENT', 'END:VCALENDAR')
	return lines.map(foldLine).join(CRLF) + CRLF
}

/** `data:text/calendar;charset=utf-8,...` URL usable as an `<a download>` href. */
export function buildIcsDataUrl(input: IcsEventInput): string {
	return `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(input))}`
}
