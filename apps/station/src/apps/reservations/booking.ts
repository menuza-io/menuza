import { type Availability } from './feed.ts'

/**
 * The small rules of the booking and change forms, apart from the sheets that
 * draw them: which chosen time survives a change of size, which days are one
 * tap away, how a quick note is added and taken back, why a Book button is
 * off, and whether a form holds anything worth asking about before it closes.
 */

type Slots = Availability['slots']

/**
 * The time chosen before the size changed, kept only while it is still an open
 * slot for the new size; otherwise cleared (never left chosen but hidden, so a
 * Save can never send a time that is no longer offered).
 */
export function keepOpenTime(
	chosen: number | null,
	slots: Pick<Slots[number], 'available' | 'localStartMin'>[],
): number | null {
	if (chosen === null) return null
	return slots.some((s) => s.available && s.localStartMin === chosen)
		? chosen
		: null
}

/** `date` (YYYY-MM-DD) moved by whole days, with no time zone in the way. */
export function addDays(date: string, days: number): string {
	const [y = 1970, m = 1, d = 1] = date.split('-').map(Number)
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export type DayChip = { date: string; kind: 'today' | 'tomorrow' | 'day' }

/** Today, tomorrow and the days after, one tap each: a host books for the week ahead by phone. */
export function dayChips(today: string, count = 7): DayChip[] {
	return Array.from({ length: count }, (_, i) => ({
		date: addDays(today, i),
		kind: i === 0 ? 'today' : i === 1 ? 'tomorrow' : 'day',
	}))
}

/** Quick notes for the team: each is a phrase added to, or taken from, the staff note. */
export const NOTE_PHRASES = [
	'High chair',
	'Window',
	'Quiet',
	'Wheelchair',
	'Birthday',
] as const

const sameText = (a: string, b: string) =>
	a.trim().toLowerCase() === b.trim().toLowerCase()
const noteParts = (notes: string) =>
	notes
		.split(/\s*[,;\n]\s*/)
		.map((part) => part.trim())
		.filter(Boolean)

/** Whether the note already says the phrase (any case, as a whole piece of it). */
export const hasNote = (notes: string, phrase: string) =>
	noteParts(notes).some((part) => sameText(part, phrase))

/** The note with the phrase added at the end, or taken out when it is there: "High chair, Window". */
export function toggleNote(notes: string, phrase: string, maxLength = 500) {
	const parts = noteParts(notes)
	if (parts.some((part) => sameText(part, phrase)))
		return parts.filter((part) => !sameText(part, phrase)).join(', ')
	const next = [...parts, phrase].join(', ')
	return next.length > maxLength ? notes : next
}

/** Why the Book button is off, in the order a host fixes it (null: nothing in the way). */
export function bookingBlocker({
	time,
	first,
	phoneProblem,
}: {
	time: number | null
	first: string
	phoneProblem: boolean
}): 'time' | 'first' | 'phone' | null {
	if (time === null) return 'time'
	if (first.trim().length === 0) return 'first'
	if (phoneProblem) return 'phone'
	return null
}

type BookingFields = {
	first: string
	last: string
	phone: string
	notes: string
}

/**
 * Something typed that a stray tap would lose: a name, a number or a note.
 * What the form was started with (a guest to book again, a number searched
 * for) is not the host's work: only a change from it counts.
 */
export const bookingDirty = (
	form: BookingFields,
	started: BookingFields = { first: '', last: '', phone: '', notes: '' },
) =>
	(['first', 'last', 'phone', 'notes'] as const).some(
		(field) => form[field].trim() !== started[field].trim(),
	)

/** The walk-in form holds something: a name, or a party size other than the start. */
export const walkInDirty = (form: { name: string; size: number }) =>
	form.name.trim() !== '' || form.size !== 2

/** The waitlist form holds something: a name, a number, or a party size other than the start. */
export const waitlistDirty = (
	form: { name: string; phone: string; size: number },
	started: { name: string; phone: string } = { name: '', phone: '' },
) =>
	form.name.trim() !== started.name.trim() ||
	form.phone.trim() !== started.phone.trim() ||
	form.size !== 2
