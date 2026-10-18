/**
 * Facts about the table the assistant held or booked on this call. Kept free
 * of the caller's name and number: they feed the call log summary.
 */
export type BookingFacts = {
	outcome: 'held' | 'booked'
	partySize: number
	/** `YYYY-MM-DD`, the restaurant's local date. */
	date: string
	/** `HH:MM`, the restaurant's local time. */
	localTime: string
}

export const RESERVATION_ACTIONS = {
	availability: 'reservations.availability',
	hold: 'reservations.hold',
	book: 'reservations.book',
} as const

/** The path of the booking page a held table's link opens. */
export const RESERVE_PATH = '/reserve'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `19:30` -> `7:30 pm`. */
export function speakTime(localTime: string): string {
	const [h, m] = localTime.split(':').map(Number)
	if (h === undefined || m === undefined || Number.isNaN(h + m))
		return localTime
	const hour = h % 12 === 0 ? 12 : h % 12
	return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** `2026-10-23` -> `Fri` (calendar math, no time zone involved). */
export function weekdayOf(date: string): string {
	const day = new Date(`${date}T12:00:00Z`).getUTCDay()
	return WEEKDAYS[day] ?? date
}

/** "Held a table for 4 on Fri 7:30 pm" (never the guest's name). */
export function describeBooking(facts: BookingFacts): string {
	const verb = facts.outcome === 'booked' ? 'Booked' : 'Held'
	return `${verb} a table for ${facts.partySize} on ${weekdayOf(facts.date)} ${speakTime(facts.localTime)}`
}
