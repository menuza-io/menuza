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

/** The most a note for the team holds. */
export const NOTE_MAX = 500

const sameText = (a: string, b: string) =>
	a.trim().toLowerCase() === b.trim().toLowerCase()
/** Where a note is cut into its pieces: a comma, a semicolon, a new line (with the space round it). */
const SEPARATOR = /\s*[,;\n]\s*/

/** The note's pieces, each with where it sits in the text as typed. */
function notePieces(notes: string) {
	const pieces: Array<{ text: string; from: number; to: number }> = []
	let from = 0
	const cut = new RegExp(SEPARATOR.source, 'g')
	for (const match of notes.matchAll(cut)) {
		pieces.push({ text: notes.slice(from, match.index), from, to: match.index })
		from = match.index + match[0].length
	}
	pieces.push({ text: notes.slice(from), from, to: notes.length })
	return pieces.filter((piece) => piece.text.trim() !== '')
}

/** Whether the note already says the phrase (any case, as a whole piece of it). */
export const hasNote = (notes: string, phrase: string) =>
	notePieces(notes).some((piece) => sameText(piece.text, phrase))

/**
 * The note with the phrase added at the end, or taken out when it is there:
 * "High chair, Window". What the host typed is never rewritten: taking a
 * phrase out removes that piece and one separator beside it, and the rest
 * stays as it was typed (its spacing, its case, its separators). A phrase
 * that would not fit leaves the note exactly as it was.
 */
export function toggleNote(
	notes: string,
	phrase: string,
	maxLength = NOTE_MAX,
) {
	const pieces = notePieces(notes)
	const at = pieces.findIndex((piece) => sameText(piece.text, phrase))
	if (at !== -1) {
		const piece = pieces[at]!
		const before = notes.slice(0, piece.from)
		const after = notes.slice(piece.to)
		// Take one separator with it: the one after it, else the one before.
		const rest = after.replace(new RegExp(`^${SEPARATOR.source}`), '')
		if (rest !== after || before === '') return `${before}${rest}`
		return `${before.replace(new RegExp(`${SEPARATOR.source}$`), '')}${after}`
	}
	const base = notes.replace(/\s+$/, '')
	const joiner =
		base === '' || /[,;]$/.test(base) ? (base === '' ? '' : ' ') : ', '
	const next = `${base}${joiner}${phrase}`
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
	started: { name: string; phone: string; size?: number } = {
		name: '',
		phone: '',
	},
) =>
	form.name.trim() !== started.name.trim() ||
	form.phone.trim() !== started.phone.trim() ||
	form.size !== (started.size ?? 2)
