import { type WaitlistEntry } from '@repo/reservations'
import { foldDigits, normalize } from './book.ts'
import { type DayReservation } from './feed.ts'
import { formatPhone } from './guest.ts'
import { phoneDigits, samePhone } from './phone.ts'

/**
 * Finding a guest the host is already looking at: a booking that repeats one
 * the book holds, a search that matched no one (and what to offer instead),
 * and where in a name the typed words are. Pure, so the rules are tested
 * apart from the screens.
 */

/** Bookings that still count against a repeat: not cancelled, not gone, not a no-show. */
const LIVE = new Set([
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
])

export { samePhone }

const fullName = (...parts: Array<string | null | undefined>) =>
	normalize(parts.filter(Boolean).join(' ')).replace(/\s+/g, ' ')

export type Repeat =
	| { kind: 'booking'; reservation: DayReservation }
	| { kind: 'waitlist'; entry: WaitlistEntry }

/**
 * Whether the person being booked is already in the book or on the waitlist:
 * the same phone number, or exactly the same full name. A first name alone is
 * never enough (two Marias are two parties). A booking is looked for before the
 * waitlist, and the earliest one first.
 */
export function findRepeat(
	who: { first: string; last: string; phone: string },
	reservations: DayReservation[],
	waitlist: WaitlistEntry[],
	/** The location's country calling code: a number typed without one is taken to be in it. */
	options: { countryCode?: string | null } = {},
): Repeat | null {
	const same = (typed: string, stored: string | null | undefined) =>
		samePhone(typed, stored, options)
	const typed = fullName(who.first, who.last)
	const hasFullName = who.first.trim() !== '' && who.last.trim() !== ''
	const nameMatches = (name: string) => hasFullName && fullName(name) === typed
	const live = reservations
		.filter((r) => LIVE.has(r.status))
		.sort((a, b) => a.startAt - b.startAt)
	for (const r of live) {
		if (
			same(who.phone, r.guest?.phone) ||
			nameMatches(
				r.guest?.name || [r.guest?.firstName, r.guest?.lastName].join(' '),
			)
		)
			return { kind: 'booking', reservation: r }
	}
	for (const entry of waitlist) {
		if (!['waiting', 'notified', 'on_the_way'].includes(entry.status)) continue
		if (
			same(who.phone, entry.phone) ||
			nameMatches(entry.displayName || `${entry.firstName} ${entry.lastName}`)
		)
			return { kind: 'waitlist', entry }
	}
	return null
}

/** What a search that found no one turns into: a name, or a number, to start a booking with. */
export type TypedGuest = { first: string; last: string; phone: string }

const capitalize = (word: string) =>
	word.length === 0 ? word : word[0]!.toLocaleUpperCase() + word.slice(1)

/**
 * The typed search as a person: digits (with a plus, spaces, brackets) are a
 * phone number, anything else a name ("rana khalid" is Rana, Khalid). Nothing
 * for a search too short to mean either.
 */
export function guestFromQuery(query: string): TypedGuest {
	const typed = query.trim()
	const digits = phoneDigits(typed)
	if (/^[+\d\s().٠-٩۰-۹-]+$/.test(typed) && digits.length >= 3)
		return {
			first: '',
			last: '',
			phone: formatPhone(typed.startsWith('+') ? `+${digits}` : digits),
		}
	const words = typed.split(/\s+/).filter(Boolean).map(capitalize)
	return {
		first: words[0] ?? '',
		last: words.slice(1).join(' '),
		phone: '',
	}
}

/** The name, for a waitlist entry that has one field for it. */
export const displayNameOf = (who: TypedGuest) =>
	[who.first, who.last].filter(Boolean).join(' ')

/** One character folded the way `normalize` folds a whole text (no trimming). */
const foldChar = (char: string) =>
	foldDigits(char.normalize('NFKD')).replace(/\p{M}/gu, '').toLowerCase()

/**
 * The parts of `text` the typed words match, as [start, end) in `text` itself,
 * merged and in order. Accents and case are ignored ("jose" marks "José"), as
 * the search itself ignores them.
 */
export function highlightRanges(
	text: string,
	query: string,
): Array<[number, number]> {
	const words = normalize(query).split(/\s+/).filter(Boolean)
	if (words.length === 0) return []
	let folded = ''
	const origin: number[] = []
	for (let i = 0; i < text.length; i += 1) {
		const piece = foldChar(text[i]!)
		folded += piece
		for (let k = 0; k < piece.length; k += 1) origin.push(i)
	}
	const found: Array<[number, number]> = []
	for (const word of words) {
		const at = folded.indexOf(word)
		if (at === -1) continue
		let end = origin[at + word.length - 1]! + 1
		// A combining accent belongs to the letter before it.
		while (end < text.length && /\p{M}/u.test(text[end]!)) end += 1
		found.push([origin[at]!, end])
	}
	found.sort((a, b) => a[0] - b[0])
	const merged: Array<[number, number]> = []
	for (const range of found) {
		const last = merged[merged.length - 1]
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
		else merged.push([range[0], range[1]])
	}
	return merged
}

// ---------------------------------------------------------------------------
// A guest who has a booking but walks in as if they had not
// ---------------------------------------------------------------------------

/**
 * A booking a walk-in may really be: someone expected who is late, or whose
 * time has passed unmarked, or who was marked a no-show a while ago.
 */
export type LateGuest = {
	reservation: DayReservation
	/**
	 * What seating them takes: `seat` (the booking is still open: seat it),
	 * `undo` (a no-show the till may still take back), or `reopen` (a no-show
	 * past that: the till asks the server to mark them arrived, which it may
	 * refuse).
	 */
	kind: 'seat' | 'undo' | 'reopen'
}

/** A guest this much of a name is worth suggesting for. */
const MIN_TYPED_LETTERS = 2

/** Bookings of today that are still open but whose time has come (late or missed), as the list calls them. */
const OPEN_STATUSES = new Set(['booked', 'confirmed'])

/**
 * Today's late and missed parties, and no-shows, whose name matches what is
 * typed into a walk-in's name field ("yus" offers "Yusuf B., booked 12:55"):
 * seating one of these re-uses their booking instead of making a second one.
 * Every typed word must start a word of the name. Earliest booking first;
 * nothing for fewer than two letters.
 */
export function findLateGuests(
	reservations: readonly DayReservation[],
	typed: string,
	now: number,
	undoWindowMs: number,
): LateGuest[] {
	const words = normalize(typed).split(/\s+/).filter(Boolean)
	if (words.join('').length < MIN_TYPED_LETTERS) return []
	const found: LateGuest[] = []
	for (const r of reservations) {
		let kind: LateGuest['kind'] | null = null
		if (OPEN_STATUSES.has(r.status) && r.startAt <= now) kind = 'seat'
		else if (r.status === 'no_show')
			kind =
				r.canUndo !== false &&
				typeof r.noShowAt === 'number' &&
				now - r.noShowAt <= undoWindowMs
					? 'undo'
					: 'reopen'
		if (!kind) continue
		const nameWords = normalize(
			r.guest?.name || [r.guest?.firstName, r.guest?.lastName].join(' '),
		)
			.split(/\s+/)
			.filter(Boolean)
		const hit = words.every((word) =>
			nameWords.some((nameWord) => nameWord.startsWith(word)),
		)
		if (hit) found.push({ reservation: r, kind })
	}
	return found.sort((a, b) => a.reservation.startAt - b.reservation.startAt)
}
