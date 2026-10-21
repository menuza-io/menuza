function icsEscape(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n')
}

function icsStamp(ms: number): string {
	return new Date(ms)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '')
}

/** RFC 5545 folding: lines over 75 octets continue on a line that starts with a space. */
function fold(line: string): string {
	const bytes = Buffer.from(line, 'utf8')
	if (bytes.length <= 75) return line
	const parts: string[] = []
	let start = 0
	let limit = 75
	while (start < bytes.length) {
		let end = Math.min(start + limit, bytes.length)
		while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
		parts.push(bytes.subarray(start, end).toString('utf8'))
		start = end
		limit = 74
	}
	return parts.join('\r\n ')
}

export function buildReservationIcs(params: {
	reservationId: string
	confirmationCode: string
	restaurantName: string
	locationName: string | null
	address: string | null
	startAt: number
	endAt: number
	partySize: number
	now: number
}): string {
	const place = [params.locationName, params.address]
		.filter((part): part is string => Boolean(part))
		.join(', ')
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Menuza//Reservations//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'BEGIN:VEVENT',
		`UID:${params.reservationId}@reservations`,
		`DTSTAMP:${icsStamp(params.now)}`,
		`DTSTART:${icsStamp(params.startAt)}`,
		`DTEND:${icsStamp(params.endAt)}`,
		`SUMMARY:${icsEscape(`Reservation at ${params.restaurantName}`)}`,
		`LOCATION:${icsEscape(place || params.restaurantName)}`,
		`DESCRIPTION:${icsEscape(`Confirmation ${params.confirmationCode}. Party of ${params.partySize}.`)}`,
		'END:VEVENT',
		'END:VCALENDAR',
	]
	return `${lines.map(fold).join('\r\n')}\r\n`
}
