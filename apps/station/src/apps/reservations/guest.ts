import { type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/macro'
import { type useLingui } from '@lingui/react'
import { type DayReservation } from './feed.ts'
import { callingCodeOf, foldDigits } from './phone.ts'

type Translate = ReturnType<typeof useLingui>['_']

/**
 * What the host knows about a guest and a booking, as words: the allergy line,
 * the tags, the guest's history, how and when it was booked, the deposit, and
 * the phone number grouped the way it is read out. Pure (the words take the
 * translator), so each rule is tested apart from the sheet.
 */

// ---------------------------------------------------------------------------
// Dietary codes
// ---------------------------------------------------------------------------

/** Codes that are an allergy (a safety matter) and not a preference (the server's own list). */
const ALLERGEN_CODES = new Set([
	'nut_allergy',
	'peanut_allergy',
	'shellfish_allergy',
	'egg_allergy',
	'soy_allergy',
	'fish_allergy',
	'sesame_allergy',
])

/** Lower case, so it reads in a sentence: "Allergy: shellfish, tree nuts". */
const ALLERGEN_LABEL: Record<string, MessageDescriptor> = {
	nut_allergy: msg`tree nuts`,
	peanut_allergy: msg`peanuts`,
	shellfish_allergy: msg`shellfish`,
	egg_allergy: msg`eggs`,
	soy_allergy: msg`soy`,
	fish_allergy: msg`fish`,
	sesame_allergy: msg`sesame`,
}

const DIET_LABEL: Record<string, MessageDescriptor> = {
	vegetarian: msg`Vegetarian`,
	vegan: msg`Vegan`,
	gluten_free: msg`Gluten free`,
	halal: msg`Halal`,
	kosher: msg`Kosher`,
	dairy_free: msg`Dairy free`,
}

const humanize = (code: string) => code.replace(/[_-]+/g, ' ').trim()

/**
 * The booking's coded dietary values, split into allergens (said first, in a
 * warning) and preferences (a quiet chip). An unknown code shows as itself.
 */
export function dietaryOf(
	_: Translate,
	r: Pick<DayReservation, 'dietaryCodes'>,
): { allergens: string[]; diets: string[] } {
	const allergens: string[] = []
	const diets: string[] = []
	for (const code of r.dietaryCodes) {
		if (ALLERGEN_CODES.has(code))
			allergens.push(
				ALLERGEN_LABEL[code] ? _(ALLERGEN_LABEL[code]) : humanize(code),
			)
		else diets.push(DIET_LABEL[code] ? _(DIET_LABEL[code]) : humanize(code))
	}
	return { allergens, diets }
}

const KNOWN_CODES = new Set([...ALLERGEN_CODES, ...Object.keys(DIET_LABEL)])

const codeOfToken = (token: string) =>
	token
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_')

/**
 * What is left of a stored dietary note once the coded values (which are said
 * in words already) are taken out: the free text a manager typed, or null when
 * the note was only codes. The server keeps both in one string.
 */
export function freeDietaryText(notes: string | null | undefined) {
	const left = (notes ?? '')
		.split(/[,;\n]/)
		.map((part) => part.trim())
		.filter((part) => part !== '' && !KNOWN_CODES.has(codeOfToken(part)))
	return left.length > 0 ? left.join(', ') : null
}

export const hasAllergenCodes = (r: Pick<DayReservation, 'dietaryCodes'>) =>
	r.dietaryCodes.some((code) => ALLERGEN_CODES.has(code))

/** Whether the booking carries an allergy of any kind (a flag, or a coded allergen). */
export const hasAnyAllergy = (
	r: Pick<DayReservation, 'hasAllergy' | 'dietaryCodes'>,
) => r.hasAllergy || hasAllergenCodes(r)

/**
 * The words about an allergy the signed-in person may read: the guest's own
 * allergy note, or the free text of the booking's dietary note.
 */
export const allergyTextOf = (
	r: Pick<DayReservation, 'guest' | 'dietaryNotes'>,
	canReadGuest: boolean,
): string | null =>
	canReadGuest
		? r.guest?.allergyNotes?.trim() || freeDietaryText(r.dietaryNotes)
		: null

/**
 * Whether a mark for an allergy is warranted. The server raises `hasAllergy`
 * for ANY dietary note ("vegan", "halal"), so the flag alone is a warning only
 * to someone who cannot read what it is about: with the guest grant, a mark
 * needs a coded allergen or allergy text; without it, an unexplained flag is
 * treated as an allergy (the safe way round).
 */
export function showsAllergyMark(
	r: Pick<
		DayReservation,
		'hasAllergy' | 'dietaryCodes' | 'guest' | 'dietaryNotes'
	>,
	canReadGuest: boolean,
): boolean {
	if (hasAllergenCodes(r)) return true
	if (canReadGuest) return allergyTextOf(r, true) !== null
	return r.hasAllergy
}

/**
 * What the sheet says about food, once, in the weight it deserves: an allergy
 * is a warning; a preference ("Dietary: Vegan") is a quiet line; a note the
 * signed-in person cannot read is said as a note, not as an allergy.
 */
export type DietaryNote =
	| { kind: 'allergy'; allergens: string[]; text: string | null }
	| { kind: 'diet'; diets: string[] }
	| { kind: 'unreadable' }

export function dietaryNoteOf(
	_: Translate,
	r: Pick<
		DayReservation,
		'hasAllergy' | 'dietaryCodes' | 'guest' | 'dietaryNotes'
	>,
	canReadGuest: boolean,
): DietaryNote | null {
	const { allergens, diets } = dietaryOf(_, r)
	const text = allergyTextOf(r, canReadGuest)
	if (allergens.length > 0 || text) return { kind: 'allergy', allergens, text }
	if (!r.hasAllergy) return null
	// Flagged, with no allergen and nothing readable: a diet, or a note we may not read.
	if (!canReadGuest) return { kind: 'unreadable' }
	return diets.length > 0 ? { kind: 'diet', diets } : null
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export type TagChip = { id: string; label: string; tone: 'vip' | 'plain' }

/**
 * The guest's tags as chips, the VIP tag first. "First visit" is left out: the
 * history line already says it (and says it with the facts to hand).
 */
export function tagChips(r: Pick<DayReservation, 'guest'>): TagChip[] {
	const tags = (r.guest?.tags ?? []).filter(
		(tag) => tag.systemKey !== 'first_visit' && tag.name.trim() !== '',
	)
	const chips = tags.map<TagChip>((tag) => ({
		id: tag.id,
		label: tag.name,
		tone: /\bvip\b/i.test(tag.name) ? 'vip' : 'plain',
	}))
	return [
		...chips.filter((c) => c.tone === 'vip'),
		...chips.filter((c) => c.tone === 'plain'),
	]
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The warning level of a history: this many no-shows or late cancels. */
export const HISTORY_WARN_AT = 2

/**
 * "9 past visits · last Oct 3 · 0 no-shows". A guest with no visit says so
 * ("No past visits"), whatever else is on record, so it never contradicts
 * itself. Warns at two no-shows or late cancels.
 */
export function historyLine(
	_: Translate,
	guest: NonNullable<DayReservation['guest']>,
	formatDay: (epochMs: number) => string,
): { text: string; warn: boolean } {
	const { visits, noShows, lateCancels } = guest
	const parts: string[] = []
	if (visits > 0) {
		parts.push(
			_(plural(visits, { one: '# past visit', other: '# past visits' })),
		)
		if (typeof guest.lastVisitAt === 'number') {
			const when = formatDay(guest.lastVisitAt)
			parts.push(_(msg`last ${when}`))
		}
	} else parts.push(_(msg`No past visits`))
	if (visits > 0 || noShows > 0)
		parts.push(_(plural(noShows, { one: '# no-show', other: '# no-shows' })))
	if (lateCancels > 0)
		parts.push(
			_(plural(lateCancels, { one: '# late cancel', other: '# late cancels' })),
		)
	return {
		text: parts.join(' · '),
		warn: noShows >= HISTORY_WARN_AT || lateCancels >= HISTORY_WARN_AT,
	}
}

// ---------------------------------------------------------------------------
// How it was booked
// ---------------------------------------------------------------------------

/** Channels a guest books through (the restaurant's website, its apps, the phone agent). */
export const isGuestChannel = (channel: string) =>
	channel === 'online' ||
	channel === 'native' ||
	channel === 'voice' ||
	channel === 'voice_agent'

/** "Online", "iOS app", "Phone", "Host stand": where a booking came from. */
export function sourceLabel(
	_: Translate,
	r: Pick<DayReservation, 'channel' | 'client'>,
): string {
	const client = r.client?.toLowerCase()
	switch (r.channel) {
		case 'online':
		case 'native':
			if (client === 'ios') return _(msg`iOS app`)
			if (client === 'android') return _(msg`Android app`)
			return r.channel === 'native' ? _(msg`App`) : _(msg`Online`)
		case 'phone':
			return _(msg`Phone`)
		case 'host':
			return _(msg`Host stand`)
		case 'operator':
			return _(msg`Staff`)
		case 'walk_in':
			return _(msg`Walk-in`)
		case 'waitlist':
			return _(msg`Waitlist`)
		case 'voice':
		case 'voice_agent':
			return _(msg`Phone agent`)
		default:
			return humanize(r.channel)
	}
}

/** "Online · code WHSNGV · booked Oct 20": enough to verify a caller. */
export function bookingMeta(
	_: Translate,
	r: Pick<
		DayReservation,
		'channel' | 'client' | 'confirmationCode' | 'createdAt'
	>,
	formatDay: (epochMs: number) => string,
): { source: string; code: string; booked: string } {
	const day = typeof r.createdAt === 'number' ? formatDay(r.createdAt) : null
	return {
		source: sourceLabel(_, r),
		code: r.confirmationCode,
		booked: day === null ? '' : _(msg`booked ${day}`),
	}
}

export type DepositState = 'paid' | 'card' | 'awaiting'

/** The deposit, when the booking has one: paid, a card held, or still awaited. */
export function depositState(
	r: Pick<DayReservation, 'paymentStatus' | 'status'>,
): DepositState | null {
	if (r.status === 'pending_payment' || r.paymentStatus === 'pending')
		return 'awaiting'
	if (r.paymentStatus === 'paid') return 'paid'
	if (r.paymentStatus === 'guaranteed') return 'card'
	return null
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** Digits in groups of 3, with the last group 3 or 4 (never a lone digit). */
function groupNational(digits: string): string {
	if (digits.length <= 4) return digits
	const groups: string[] = []
	let rest = digits
	while (rest.length > 4) {
		groups.push(rest.slice(0, 3))
		rest = rest.slice(3)
	}
	groups.push(rest)
	return groups.join(' ')
}

/**
 * A number the way it is read out: the country code, then groups.
 * `+14155550142` is `+1 415 555 0142`, `+966512345678` is `+966 512 345 678`.
 * One that is not international (no plus) is only grouped. Safe to call on
 * what a person is typing: it keeps what was typed and only spaces it.
 */
export function formatPhone(value: string): string {
	const trimmed = foldDigits(value).trim()
	const digits = trimmed.replace(/\D/g, '')
	if (!digits) return trimmed.startsWith('+') ? '+' : ''
	if (!trimmed.startsWith('+')) return groupNational(digits)
	const code = callingCodeOf(digits)
	const national = digits.slice(code.length)
	return national ? `+${code} ${groupNational(national)}` : `+${code}`
}

/** What a phone field holds as it is typed: spaced as it is read out, nothing else kept. */
export const formatPhoneTyping = (value: string) => formatPhone(value)

/**
 * A list said the way the language says it: "shellfish, tree nuts" in English,
 * with the Arabic comma and "و" in Arabic. Falls back to commas where the
 * runtime has no list formatter.
 */
export function listText(items: readonly string[], locale: string): string {
	if (items.length < 2) return items.join('')
	try {
		return new Intl.ListFormat(locale, {
			type: 'conjunction',
			style: 'narrow',
		}).format(items)
	} catch {
		return items.join(', ')
	}
}

// ---------------------------------------------------------------------------
// What a table's tile says about its guest
// ---------------------------------------------------------------------------

/** A signal a table's tile can carry in its corner. */
export type TileSignal = 'allergy' | 'vip' | 'occasion' | 'deposit'

/** The most signals a tile has room for. */
export const MAX_TILE_SIGNALS = 2

/**
 * The corner marks of a table, from the booking on it (the party seated, or
 * the next one due): an allergy first (it matters most at the table), then a
 * VIP, then an occasion, then a paid deposit. Never more than two.
 */
export function tileSignals(
	r: Pick<
		DayReservation,
		| 'hasAllergy'
		| 'dietaryCodes'
		| 'dietaryNotes'
		| 'guest'
		| 'occasion'
		| 'paymentStatus'
		| 'status'
	>,
	canReadGuest: boolean,
): TileSignal[] {
	const all: TileSignal[] = []
	if (showsAllergyMark(r, canReadGuest)) all.push('allergy')
	if ((r.guest?.tags ?? []).some((tag) => /\bvip\b/i.test(tag.name)))
		all.push('vip')
	if (r.occasion) all.push('occasion')
	if (depositState(r) === 'paid') all.push('deposit')
	return all.slice(0, MAX_TILE_SIGNALS)
}
