import { type CapitalStyle } from './menu-cards.ts'
import { MENU_WORD_LIST, MENU_WORD_SET } from './polish-words.ts'

/** Text rules for the polish cards. Pure; one locale's value at a time. */

// --- Edit distance --------------------------------------------------------------

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1
	const cols = b.length + 1
	const d: number[][] = Array.from({ length: rows }, () =>
		new Array<number>(cols).fill(0),
	)
	for (let i = 0; i < rows; i++) d[i]![0] = i
	for (let j = 0; j < cols; j++) d[0]![j] = j
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			let best = Math.min(
				d[i - 1]![j]! + 1,
				d[i]![j - 1]! + 1,
				d[i - 1]![j - 1]! + cost,
			)
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, d[i - 2]![j - 2]! + 1)
			}
			d[i]![j] = best
		}
	}
	return d[a.length]![b.length]!
}

// --- Typos ----------------------------------------------------------------------

export const TYPO_MIN_LETTERS = 5
export const TYPO_MAX_FIXES = 10

/** Allowed edit distance for a word: 1, or 2 from 8 letters. */
export function typoLimit(word: string): number {
	return word.length >= 8 ? 2 : 1
}

function isKnownWord(lower: string): boolean {
	if (MENU_WORD_SET.has(lower)) return true
	const stems = [
		lower.replace(/s$/, ''),
		lower.replace(/es$/, ''),
		lower.replace(/ies$/, 'y'),
		lower.replace(/ed$/, ''),
		lower.replace(/ed$/, 'e'),
		lower.replace(/ing$/, ''),
		lower.replace(/ing$/, 'e'),
		lower.replace(/d$/, ''),
	]
	return stems.some((stem) => stem !== lower && MENU_WORD_SET.has(stem))
}

export function isKnownMenuWord(word: string): boolean {
	const lower = word.toLowerCase()
	// The singular of a listed plural ("lentil" for "lentils") is a word too.
	return (
		isKnownWord(lower) ||
		MENU_WORD_SET.has(`${lower}s`) ||
		MENU_WORD_SET.has(`${lower}es`)
	)
}

const LATIN_WORD = /^[A-Za-zÀ-ÿ]+$/

/** The menu word a Latin word is one small slip away from, or null. */
export function nearMenuWord(word: string): string | null {
	const lower = word.toLowerCase()
	if (lower.length < TYPO_MIN_LETTERS || !LATIN_WORD.test(lower)) return null
	if (isKnownMenuWord(lower)) return null
	const limit = typoLimit(lower)
	let best: { word: string; distance: number } | null = null
	for (const candidate of MENU_WORD_LIST) {
		if (candidate.length < TYPO_MIN_LETTERS) continue
		if (candidate[0] !== lower[0]) continue
		if (Math.abs(candidate.length - lower.length) > limit) continue
		const distance = editDistance(lower, candidate)
		if (distance === 0 || distance > limit) continue
		if (!best || distance < best.distance) best = { word: candidate, distance }
	}
	return best?.word ?? null
}

export type TypoSuspect = { from: string; to: string }

/**
 * Words of an English text that look like a slip of a known menu word, once
 * per word (case-insensitive), at most `TYPO_MAX_FIXES`. Words with digits
 * or non-Latin letters (Arabic, transliterations) are never suspects, and a
 * word that is not near a menu word never is: names like Shawarma pass.
 */
export function findTypoSuspects(text: string): TypoSuspect[] {
	const out: TypoSuspect[] = []
	const seen = new Set<string>()
	for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
		const word = match[0]
		if (/\d/.test(word) || !LATIN_WORD.test(word)) continue
		const key = word.toLowerCase()
		if (seen.has(key)) continue
		const near = nearMenuWord(word)
		if (!near) continue
		seen.add(key)
		out.push({ from: word, to: matchCase(word, near) })
		if (out.length >= TYPO_MAX_FIXES) break
	}
	return out
}

/** `replacement` in the case of `found` (ALL CAPS, Capitalized, or lower). */
export function matchCase(found: string, replacement: string): string {
	const lower = replacement.toLowerCase()
	if (found.length > 1 && found === found.toUpperCase()) {
		return lower.toUpperCase()
	}
	if (found[0] && found[0] !== found[0].toLowerCase()) {
		return lower.charAt(0).toUpperCase() + lower.slice(1)
	}
	return lower
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace whole words (any case), keeping each one's case. */
export function replaceWholeWord(
	text: string,
	from: string,
	to: string,
): string {
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`,
		'giu',
	)
	return text.replace(pattern, (found) => matchCase(found, to))
}

export function containsWholeWord(text: string, word: string): boolean {
	return new RegExp(
		`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`,
		'iu',
	).test(text)
}

// --- Capitals --------------------------------------------------------------------

const SMALL_WORDS = new Set([
	'a',
	'an',
	'and',
	'or',
	'the',
	'of',
	'in',
	'on',
	'at',
	'to',
	'for',
	'with',
	'by',
	'de',
	'la',
	'le',
	'el',
	'du',
	'au',
])

const hasUpper = (text: string) => /\p{Lu}/u.test(text)
const hasLower = (text: string) => /\p{Ll}/u.test(text)

function capitalize(lower: string): string {
	const [first = '', ...rest] = Array.from(lower)
	return first.toUpperCase() + rest.join('')
}

function convertSegment(
	segment: string,
	style: CapitalStyle,
	index: number,
): string {
	if (!hasUpper(segment) && !hasLower(segment)) return segment
	if (style === 'upper') return segment.toUpperCase()
	const letters = Array.from(segment)
	// BBQ, BLT: short all-caps words stay.
	if (
		letters.length >= 2 &&
		letters.length <= 3 &&
		segment === segment.toUpperCase()
	) {
		return segment
	}
	// McFlurry, iPhone: a capital inside a word is the brand's own.
	const inner = letters.slice(1).join('')
	if (hasUpper(inner) && hasLower(segment)) return segment
	const lower = segment.toLowerCase()
	if (style === 'title') {
		return index > 0 && SMALL_WORDS.has(lower) ? lower : capitalize(lower)
	}
	return index === 0 ? capitalize(lower) : lower
}

/** A name rewritten in a style; words with digits are left as they are. */
export function toCapitalStyle(name: string, style: CapitalStyle): string {
	let index = 0
	return name.replace(/\S+/g, (token) => {
		if (/\d/.test(token)) {
			index += 1
			return token
		}
		return token.replace(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu, (segment) =>
			convertSegment(segment, style, index++),
		)
	})
}

/** Names with letters of an uncased script mostly are not judged at all. */
export function isCasedName(name: string): boolean {
	const letters = name.match(/\p{L}/gu)?.length ?? 0
	const cased = name.match(/[\p{Lu}\p{Ll}]/gu)?.length ?? 0
	return cased > 0 && cased * 2 >= letters
}

/** The styles a name already is in (several for "Burger"; none for "BuRGer"). */
export function matchingCapitalStyles(name: string): CapitalStyle[] {
	return (['title', 'sentence', 'upper'] as const).filter(
		(style) => toCapitalStyle(name, style) === name,
	)
}

export function titleCaseWords(text: string): string {
	return text.replace(/[\p{L}\p{M}]+/gu, (word) =>
		hasLower(word) || hasUpper(word) ? capitalize(word.toLowerCase()) : word,
	)
}

// --- Normalizing names ---------------------------------------------------------------

/** Lowercase, no diacritics or Arabic marks, letters and digits only. */
export function normalizeName(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ًͯ-ٰٟـ]/g, '')
		.toLowerCase()
		.replace(/[أإآٱ]/g, 'ا')
		.replace(/ى/g, 'ي')
		.replace(/ة/g, 'ه')
		.replace(/\([^)]*\)/g, ' ')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function stemWord(word: string): string {
	let out = word
	if (/^[a-z]+$/.test(out) && out.length > 3) {
		if (out.endsWith('ies')) out = `${out.slice(0, -3)}y`
		else if (out.endsWith('es') && /(?:ch|sh|x|s|z|o)es$/.test(out)) {
			out = out.slice(0, -2)
		} else if (out.endsWith('s') && !out.endsWith('ss')) out = out.slice(0, -1)
	} else if (/[؀-ۿ]/.test(out)) {
		if (out.startsWith('ال') && out.length > 4) out = out.slice(2)
		if (out.endsWith('ات') && out.length > 4) out = out.slice(0, -2)
	}
	return out
}

/** Singular/plural-insensitive key of a name, word by word. */
export function stemmedName(text: string): string {
	return normalizeName(text).split(' ').filter(Boolean).map(stemWord).join(' ')
}

/** Does one stemmed name contain the other, on word boundaries? */
export function namesOverlap(a: string, b: string): boolean {
	const left = stemmedName(a)
	const right = stemmedName(b)
	if (!left || !right) return false
	return (
		` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `)
	)
}

// --- "Choice of X" -----------------------------------------------------------------

const CHOICE_EN: RegExp[] = [
	/\b(?:choice\s+of|choose\s+your|pick\s+your)\s+([^.;:!?()\n]+)/i,
]
const CHOICE_AR: RegExp[] = [
	/(?:اختيارك\s+من|اختر(?:\s+من)?)\s+([^.؛;:!?؟()\n]+)/u,
]

export const CHOICE_PHRASE_MAX = 40

/**
 * The thing a description says the guest chooses ("side" in "your choice of
 * side"), or null: none found, a list of options ("fries or salad"), empty
 * or too long.
 */
export function extractChoicePhrase(
	text: string,
	locale: string,
): string | null {
	const patterns =
		locale === 'ar' ? CHOICE_AR : locale === 'en' ? CHOICE_EN : []
	for (const pattern of patterns) {
		const raw = pattern.exec(text)?.[1]
		if (!raw) continue
		const cut =
			locale === 'ar'
				? raw.split(/\s+(?:مع|في|على|من|ل)\s+/u)[0]
				: raw.split(
						/\s+(?:with|from|for|in|on|at|to|of|served|that|which|per)\b/i,
					)[0]
		let phrase = (cut ?? '').trim()
		if (!phrase) continue
		const list =
			locale === 'ar'
				? /،|,|\/|&|\+|\s(?:أو|او|و)\s/u
				: /,|\/|&|\+|\s(?:or|and)\s/i
		if (list.test(phrase)) continue
		if (locale === 'en') {
			phrase = phrase.replace(/^(?:a|an|the|your|any|one|1)\s+/i, '')
			phrase = phrase.replace(/^(?:a|an|the|your|any|one|1)\s+/i, '')
		}
		phrase = phrase.replace(/\s+/g, ' ').trim()
		if (!phrase || phrase.length > CHOICE_PHRASE_MAX) continue
		if (phrase.split(' ').length > 4) continue
		return phrase
	}
	return null
}

// --- Order helpers -----------------------------------------------------------------

/**
 * Sort only the sortable entries, into the slots sortable entries occupy;
 * the others keep their place. Stable. Returns a new array.
 */
export function sortIntoSlots<T>(
	list: readonly T[],
	rank: (entry: T) => number | null,
): T[] {
	const slots: number[] = []
	const sortable: Array<{ entry: T; rank: number; at: number }> = []
	list.forEach((entry, at) => {
		const value = rank(entry)
		if (value === null) return
		slots.push(at)
		sortable.push({ entry, rank: value, at })
	})
	sortable.sort((a, b) => a.rank - b.rank || a.at - b.at)
	const out = [...list]
	slots.forEach((slot, i) => {
		out[slot] = sortable[i]!.entry
	})
	return out
}
