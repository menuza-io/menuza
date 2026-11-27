/**
 * Counting stock by voice (#488). Pure: no I/O, no model.
 *
 * A speech model (in the organization's own region, see the tenant-api's
 * `speech-reader.ts`) turns what a person said into text. This file turns that
 * text into PROPOSED lines (an item, an amount and one of the item's own
 * units), or into a question when it cannot be sure:
 *
 * - a word that matches no item, or more than one, becomes "Which one?" with
 *   the closest items, never a guess;
 * - a unit the item does not have ("two cases" of an item with no case unit)
 *   becomes "Which unit?" with the units it has;
 * - nothing is saved here. The person confirms, edits or drops each line, and
 *   only then do the lines go through the same count entry route as typed ones.
 *
 * English and Arabic, Arabic-Indic digits, and English item names spoken inside
 * an Arabic sentence. The same words work for a transcript the person edited.
 */

import { STANDARD_UNIT_SPECS, type StandardUnit } from './units.ts'

export type VoiceItem = {
	id: string
	name: string
	/** The item's Arabic name (label name), matched too when it has one. */
	nameAr?: string | null
	baseUnit: 'g' | 'ml' | 'piece'
	/** The unit the item is counted in here; used when no unit was spoken. */
	countUnit: string | null
	/** The item's named units ("Case", "Bag"). */
	units: { id: string; name: string }[]
}

export type VoiceUnitOption = {
	/** A standard unit key or `unit:<id>`. */
	ref: string
	label: string
}

export type VoiceLine = {
	itemId: string
	itemName: string
	amount: number
	unit: string
	unitLabel: string
	/** No unit was spoken: the item's count unit was used. */
	unitAssumed: boolean
	/** The item words as heard. */
	heard: string
	/** `close` when the item words were not an exact match (shown for a second look). */
	match: 'exact' | 'close'
}

export type VoiceQuestion =
	| {
			kind: 'which_item'
			heard: string
			amount: number | null
			unitWords: string | null
			reason: 'no_match' | 'ambiguous'
			/** The closest items, best first (up to four). */
			candidates: { itemId: string; name: string }[]
	  }
	| {
			kind: 'which_unit'
			heard: string
			itemId: string
			itemName: string
			amount: number
			unitWords: string
			/** The units this item has. */
			options: VoiceUnitOption[]
	  }

export type VoiceParse = {
	transcript: string
	lines: VoiceLine[]
	questions: VoiceQuestion[]
}

// ── Normalising ─────────────────────────────────────────────────────────────

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/**
 * Lower case, ASCII digits, no vowel marks, one spelling of the Arabic letters
 * that vary, punctuation reduced to the few marks the parser reads.
 */
export function normalizeSpeech(text: string): string {
	let out = text.normalize('NFKC').toLowerCase()
	out = out.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
	out = out.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
	out = out
		.replace(/٫/g, '.')
		.replace(/[،؛]/g, ',')
		// Vowel marks and the stretching line.
		.replace(/[ً-ٰٟـ]/g, '')
		.replace(/[أإآٱ]/g, 'ا')
		.replace(/ى/g, 'ي')
		.replace(/ة/g, 'ه')
		.replace(/[^\p{L}\p{N}.,\s]/gu, ' ')
		// A full stop is only a decimal point between digits.
		.replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
		.replace(/,/g, ' , ')
		.replace(/\s+/g, ' ')
		.trim()
	return out
}

/** Singular form of a word, for English and Arabic plurals, for matching only. */
function stem(word: string): string {
	let w = word
	if (/^[a-z]+$/.test(w)) {
		if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
		if (w.length > 4 && /(ches|shes|sses|xes|oes)$/.test(w)) return w.slice(0, -2)
		if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
		return w
	}
	// Arabic: the definite article and the common plural endings.
	if (w.length > 4 && w.startsWith('ال')) w = w.slice(2)
	if (w.length > 4 && (w.endsWith('ات') || w.endsWith('ون') || w.endsWith('ين'))) {
		w = w.slice(0, -2)
	}
	return w
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const EN_UNITS: Record<string, number> = {
	zero: 0,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19,
}
const EN_TENS: Record<string, number> = {
	twenty: 20,
	thirty: 30,
	forty: 40,
	fourty: 40,
	fifty: 50,
	sixty: 60,
	seventy: 70,
	eighty: 80,
	ninety: 90,
}

// Arabic, after `normalizeSpeech` (taa marbuta is ha, alef variants are alef).
const AR_UNITS: Record<string, number> = {
	صفر: 0,
	واحد: 1,
	واحده: 1,
	اثنين: 2,
	اثنان: 2,
	اثنتين: 2,
	ثنتين: 2,
	اتنين: 2,
	ثلاثه: 3,
	ثلاث: 3,
	تلاته: 3,
	اربعه: 4,
	اربع: 4,
	خمسه: 5,
	خمس: 5,
	سته: 6,
	ست: 6,
	سبعه: 7,
	سبع: 7,
	ثمانيه: 8,
	ثماني: 8,
	ثمان: 8,
	تمانيه: 8,
	تسعه: 9,
	تسع: 9,
	عشره: 10,
	عشر: 10,
	احدعشر: 11,
	اثناعشر: 12,
}
const AR_TENS: Record<string, number> = {
	عشرين: 20,
	ثلاثين: 30,
	اربعين: 40,
	خمسين: 50,
	ستين: 60,
	سبعين: 70,
	ثمانين: 80,
	تسعين: 90,
}

const NUMBER_WORD_SET = new Set([
	...Object.keys(EN_UNITS),
	...Object.keys(EN_TENS),
	...Object.keys(AR_UNITS),
	...Object.keys(AR_TENS),
	'hundred',
	'half',
	'dozen',
	'نصف',
	'مائه',
	'مايه',
	'دزينه',
])

type NumberAt = { value: number; next: number }

const isDigits = (token: string | undefined) =>
	token !== undefined && /^\d+(\.\d+)?$/.test(token)

/** "and a half" / "and half" / "ونصف" after a whole number. */
function halfAt(tokens: string[], i: number): number {
	const a = tokens[i]
	const b = tokens[i + 1]
	const c = tokens[i + 2]
	if (a === 'and' && b === 'a' && c === 'half') return 3
	if (a === 'and' && b === 'half') return 2
	if (a === 'و' && b === 'نصف') return 2
	if (a === 'ونصف') return 1
	return 0
}

/** The number that starts at `tokens[i]` (digits or words), and where it ends. */
export function numberAt(tokens: string[], i: number): NumberAt | null {
	const first = tokens[i]
	if (first === undefined) return null
	// A leading Arabic "wa" glued to a number word: handled by the splitter.
	if (isDigits(first)) {
		let value = Number(first)
		let next = i + 1
		if (tokens[next] === 'dozen' || tokens[next] === 'دزينه') {
			value *= 12
			next += 1
		}
		const half = halfAt(tokens, next)
		if (half) {
			value += 0.5
			next += half
		}
		return { value, next }
	}
	if (first === 'half' || first === 'نصف') return { value: 0.5, next: i + 1 }
	if (first === 'a' && tokens[i + 1] === 'dozen') {
		return { value: 12, next: i + 2 }
	}
	if (first === 'a' && tokens[i + 1] === 'half') {
		return { value: 0.5, next: i + 2 }
	}
	// "a case of tomatoes": one.
	if (
		(first === 'a' || first === 'an') &&
		tokens[i + 1] !== undefined &&
		conceptOfWord(tokens[i + 1]!) !== null
	) {
		return { value: 1, next: i + 1 }
	}
	if (first === 'dozen' || first === 'دزينه') return { value: 12, next: i + 1 }

	let value = 0
	let next = i
	// English: [units|tens [units]] [hundred [and] [tens [units]]] [dozen] [point digits]
	const eatUnits = (): number | null => {
		const word = tokens[next]
		if (word !== undefined && word in EN_UNITS && word !== 'zero') {
			next += 1
			return EN_UNITS[word]!
		}
		return null
	}
	const eatBelowHundred = (): number | null => {
		const word = tokens[next]
		if (word === undefined) return null
		if (word in EN_TENS) {
			next += 1
			const unit = eatUnits()
			return EN_TENS[word]! + (unit !== null && unit < 10 ? unit : 0)
		}
		return eatUnits()
	}
	if (first in EN_UNITS || first in EN_TENS) {
		const below = eatBelowHundred()
		value = below ?? 0
		if (tokens[next] === 'hundred') {
			next += 1
			value = (value || 1) * 100
			if (tokens[next] === 'and') {
				const saved = next
				next += 1
				const rest = eatBelowHundred()
				if (rest === null) next = saved
				else value += rest
			} else {
				const rest = eatBelowHundred()
				if (rest !== null) value += rest
			}
		}
		if (tokens[next] === 'dozen') {
			value *= 12
			next += 1
		}
		if (tokens[next] === 'point' && isDigitWord(tokens[next + 1])) {
			let decimals = ''
			next += 1
			while (isDigitWord(tokens[next])) {
				decimals += String(EN_UNITS[tokens[next]!] ?? tokens[next])
				next += 1
			}
			value = Number(`${value}.${decimals}`)
		}
		const half = halfAt(tokens, next)
		if (half) {
			value += 0.5
			next += half
		}
		return { value, next }
	}

	// Arabic: unit, or unit "wa" tens ("خمسه وعشرين"), or tens alone.
	if (first in AR_UNITS || first in AR_TENS) {
		const word = first
		value = word in AR_UNITS ? AR_UNITS[word]! : AR_TENS[word]!
		next = i + 1
		// "five and twenty"
		const glued = tokens[next]
		if (word in AR_UNITS && glued !== undefined) {
			const tensGlued = glued.startsWith('و') ? glued.slice(1) : null
			if (tensGlued && tensGlued in AR_TENS) {
				value += AR_TENS[tensGlued]!
				next += 1
			} else if (glued === 'و' && tokens[next + 1] && tokens[next + 1]! in AR_TENS) {
				value += AR_TENS[tokens[next + 1]!]!
				next += 2
			}
		}
		const half = halfAt(tokens, next)
		if (half) {
			value += 0.5
			next += half
		}
		return { value, next }
	}
	return null
}

const isDigitWord = (token: string | undefined) =>
	token !== undefined && (token in EN_UNITS || /^\d$/.test(token))

// ── Units ───────────────────────────────────────────────────────────────────

type UnitConcept =
	| { kind: 'standard'; unit: StandardUnit }
	| { kind: 'pack'; concept: string }

const UNIT_WORDS: Array<[UnitConcept, string[]]> = [
	[{ kind: 'standard', unit: 'kg' }, ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'كيلو', 'كيلوجرام', 'كجم', 'كغ', 'كيلوغرام']],
	[{ kind: 'standard', unit: 'g' }, ['g', 'gm', 'gms', 'gram', 'grams', 'جرام', 'غرام', 'جم', 'غ']],
	[{ kind: 'standard', unit: 'lb' }, ['lb', 'lbs', 'pound', 'pounds', 'رطل', 'باوند']],
	[{ kind: 'standard', unit: 'oz' }, ['oz', 'ounce', 'ounces', 'اوقيه', 'اونصه']],
	[{ kind: 'standard', unit: 'l' }, ['l', 'ltr', 'liter', 'liters', 'litre', 'litres', 'لتر', 'لترات']],
	[{ kind: 'standard', unit: 'ml' }, ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'مل', 'ملل', 'ميلي']],
	[{ kind: 'standard', unit: 'gal' }, ['gal', 'gallon', 'gallons', 'جالون', 'جالونات']],
	[{ kind: 'standard', unit: 'qt' }, ['qt', 'quart', 'quarts']],
	[{ kind: 'standard', unit: 'fl_oz' }, ['floz']],
	[{ kind: 'standard', unit: 'piece' }, ['piece', 'pieces', 'pc', 'pcs', 'each', 'حبه', 'حبات', 'قطعه', 'قطع']],
	[{ kind: 'pack', concept: 'case' }, ['case', 'cases']],
	[{ kind: 'pack', concept: 'carton' }, ['carton', 'cartons', 'كرتون', 'كراتين', 'كرتونه']],
	[{ kind: 'pack', concept: 'box' }, ['box', 'boxes', 'صندوق', 'صناديق', 'علبه كبيره']],
	[{ kind: 'pack', concept: 'bag' }, ['bag', 'bags', 'كيس', 'اكياس', 'كيسين']],
	[{ kind: 'pack', concept: 'sack' }, ['sack', 'sacks', 'شوال', 'اشولة', 'شوالات']],
	[{ kind: 'pack', concept: 'bottle' }, ['bottle', 'bottles', 'زجاجه', 'زجاجات', 'قارورة', 'قاروره', 'قوارير']],
	[{ kind: 'pack', concept: 'can' }, ['can', 'cans', 'tin', 'tins', 'علبه', 'علب']],
	[{ kind: 'pack', concept: 'tray' }, ['tray', 'trays', 'صينيه', 'صواني']],
	[{ kind: 'pack', concept: 'bunch' }, ['bunch', 'bunches', 'حزمه', 'حزم', 'ربطه', 'ربطات']],
	[{ kind: 'pack', concept: 'crate' }, ['crate', 'crates', 'كريت', 'كراتيت']],
	[{ kind: 'pack', concept: 'pack' }, ['pack', 'packs', 'packet', 'packets', 'package', 'packages', 'باكيت', 'عبوه', 'عبوات']],
	[{ kind: 'pack', concept: 'jar' }, ['jar', 'jars', 'برطمان', 'برطمانات']],
	[{ kind: 'pack', concept: 'bucket' }, ['bucket', 'buckets', 'pail', 'pails', 'سطل', 'سطول']],
	[{ kind: 'pack', concept: 'roll' }, ['roll', 'rolls', 'رول', 'لفه', 'لفات']],
	[{ kind: 'pack', concept: 'tub' }, ['tub', 'tubs']],
	[{ kind: 'pack', concept: 'bundle' }, ['bundle', 'bundles', 'رزمه', 'رزم']],
]

const UNIT_BY_WORD = new Map<string, UnitConcept>()
for (const [concept, words] of UNIT_WORDS) {
	for (const word of words) UNIT_BY_WORD.set(normalizeSpeech(word), concept)
}

/** The concept a unit word names (a named unit's own name is read the same way). */
function conceptOfWord(word: string): UnitConcept | null {
	return UNIT_BY_WORD.get(word) ?? UNIT_BY_WORD.get(stem(word)) ?? null
}

/** The concept a named unit ("Case", "Bag of 5 kg") is, from its first matching word. */
function conceptOfNamedUnit(name: string): UnitConcept | null {
	for (const token of normalizeSpeech(name).split(' ')) {
		const concept = conceptOfWord(token)
		if (concept?.kind === 'pack') return concept
	}
	return null
}

const sameConcept = (a: UnitConcept, b: UnitConcept) =>
	a.kind === 'pack' && b.kind === 'pack' && a.concept === b.concept

export function standardUnitLabel(unit: string): string {
	return unit === 'fl_oz' ? 'fl oz' : unit
}

/** The units an item has: its standard units and its named ones. */
export function unitOptionsOf(item: VoiceItem): VoiceUnitOption[] {
	const standard = (Object.keys(STANDARD_UNIT_SPECS) as StandardUnit[])
		.filter((unit) => STANDARD_UNIT_SPECS[unit].base === item.baseUnit)
		.map((unit) => ({ ref: unit, label: standardUnitLabel(unit) }))
	const named = item.units.map((unit) => ({
		ref: `unit:${unit.id}`,
		label: unit.name,
	}))
	return [...named, ...standard]
}

function defaultUnit(item: VoiceItem): VoiceUnitOption {
	const options = unitOptionsOf(item)
	const chosen = item.countUnit
		? options.find((option) => option.ref === item.countUnit)
		: undefined
	if (chosen) return chosen
	const fallback: StandardUnit =
		item.baseUnit === 'piece' ? 'piece' : item.baseUnit === 'g' ? 'kg' : 'l'
	return { ref: fallback, label: standardUnitLabel(fallback) }
}

// ── Matching items ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
	'of',
	'the',
	'a',
	'an',
	'some',
	'and',
	'then',
	'plus',
	'also',
	'i',
	'have',
	'we',
	'has',
	'there',
	'are',
	'is',
	'count',
	'counted',
	'total',
	'من',
	'و',
	'ثم',
	'عندي',
	'عندنا',
])

const FILLER_START = new Set([
	'i',
	'we',
	'have',
	'has',
	'there',
	'are',
	'is',
	'count',
	'counted',
	'total',
	'ثم',
	'عندي',
	'عندنا',
	'then',
	'also',
	'plus',
])

function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
	for (let i = 1; i <= a.length; i++) {
		const current = [i]
		let best = i
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			const value = Math.min(
				previous[j]! + 1,
				current[j - 1]! + 1,
				previous[j - 1]! + cost,
			)
			current.push(value)
			if (value < best) best = value
		}
		if (best > max) return max + 1
		previous = current
	}
	return previous[b.length]!
}

function tokenScore(heard: string, item: string): number {
	if (heard === item) return 1
	if (heard.length >= 4 && item.length >= 4) {
		if (item.startsWith(heard) || heard.startsWith(item)) return 0.8
	}
	if (heard.length >= 5 && item.length >= 5 && editDistance(heard, item, 1) <= 1) {
		return 0.85
	}
	if (heard.length >= 8 && item.length >= 8 && editDistance(heard, item, 2) <= 2) {
		return 0.7
	}
	return 0
}

const wordsOf = (text: string): string[] =>
	normalizeSpeech(text)
		.split(' ')
		.filter((word) => word && word !== ',' && !STOPWORDS.has(word))
		.map(stem)

/** How well the heard words name an item: coverage of what was said, and precision of the name. */
function scoreName(heard: string[], name: string): number {
	const words = wordsOf(name)
	if (heard.length === 0 || words.length === 0) return 0
	let covered = 0
	let used = 0
	const taken = new Set<number>()
	for (const word of heard) {
		let best = 0
		let bestAt = -1
		words.forEach((candidate, index) => {
			if (taken.has(index)) return
			const score = tokenScore(word, candidate)
			if (score > best) {
				best = score
				bestAt = index
			}
		})
		if (bestAt >= 0) {
			taken.add(bestAt)
			used += 1
		}
		covered += best
	}
	const coverage = covered / heard.length
	const precision = used / words.length
	if (coverage === 1 && precision === 1) return 1
	return 0.65 * coverage + 0.35 * precision
}

type Ranked = { item: VoiceItem; score: number }

function rank(heard: string[], items: readonly VoiceItem[]): Ranked[] {
	return items
		.map((item) => ({
			item,
			score: Math.max(
				scoreName(heard, item.name),
				item.nameAr ? scoreName(heard, item.nameAr) : 0,
			),
		}))
		.filter((row) => row.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.item.name.localeCompare(b.item.name) ||
				(a.item.id < b.item.id ? -1 : 1),
		)
}

/** A match is sure when it clearly beats the next one. */
const SURE = 0.75
const MARGIN = 0.15
const CLOSE = 0.3

// ── Clauses ─────────────────────────────────────────────────────────────────

type Clause = {
	amount: number | null
	unitWords: string[]
	itemWords: string[]
}

/** Splits a glued Arabic "wa" off a number word or digits ("وثلاثه", "و3"). */
function tokensOf(transcript: string): string[] {
	const out: string[] = []
	for (const token of normalizeSpeech(transcript).split(' ')) {
		if (!token) continue
		if (token.length > 1 && token.startsWith('و')) {
			const rest = token.slice(1)
			if (
				NUMBER_WORD_SET.has(rest) ||
				isDigits(rest) ||
				rest in AR_UNITS ||
				rest in AR_TENS
			) {
				out.push('و', rest)
				continue
			}
		}
		out.push(token)
	}
	return out
}

const isBoundary = (token: string) =>
	token === 'and' || token === 'و' || token === ',' || token === 'then'

function clausesOf(tokens: string[]): Clause[] {
	const clauses: Clause[] = []
	let i = 0
	while (i < tokens.length) {
		const token = tokens[i]!
		if (isBoundary(token) || FILLER_START.has(token)) {
			i += 1
			continue
		}
		const number = numberAt(tokens, i)
		if (number) {
			// Quantity first: "2 cases of tomatoes".
			let next = number.next
			const unitWords: string[] = []
			const maybeUnit = tokens[next]
			if (maybeUnit !== undefined && conceptOfWord(maybeUnit)) {
				unitWords.push(maybeUnit)
				next += 1
			}
			if (tokens[next] === 'of' || tokens[next] === 'من') next += 1
			const itemWords: string[] = []
			while (next < tokens.length) {
				const word = tokens[next]!
				if (isBoundary(word)) break
				// A number starts the next clause only when something is said after it.
				if (numberAt(tokens, next) && itemWords.length > 0) break
				if (!STOPWORDS.has(word)) itemWords.push(word)
				next += 1
			}
			clauses.push({ amount: number.value, unitWords, itemWords })
			i = next
			continue
		}
		// Item first: "tomatoes two cases".
		let next = i
		const itemWords: string[] = []
		while (next < tokens.length && !numberAt(tokens, next)) {
			const word = tokens[next]!
			if (isBoundary(word)) break
			if (!STOPWORDS.has(word)) itemWords.push(word)
			next += 1
		}
		const after = numberAt(tokens, next)
		if (after && itemWords.length > 0) {
			let end = after.next
			const unitWords: string[] = []
			const maybeUnit = tokens[end]
			if (maybeUnit !== undefined && conceptOfWord(maybeUnit)) {
				unitWords.push(maybeUnit)
				end += 1
			}
			clauses.push({ amount: after.value, unitWords, itemWords })
			i = end
			continue
		}
		// Words with no number anywhere near: an item the person named without an amount.
		if (itemWords.length > 0) {
			clauses.push({ amount: null, unitWords: [], itemWords })
		}
		i = Math.max(next, i + 1)
	}
	return clauses
}

// ── The parser ──────────────────────────────────────────────────────────────

/** An amount a person might count: above zero, a sane size. */
const validAmount = (value: number | null): value is number =>
	value !== null && Number.isFinite(value) && value > 0 && value <= 1_000_000

/**
 * Proposes count lines for what was said. Never saves, never guesses: a word
 * that matches nothing or several items, or a unit the item does not have,
 * comes back as a question.
 */
export function parseSpokenCount(
	transcript: string,
	items: readonly VoiceItem[],
): VoiceParse {
	const lines: VoiceLine[] = []
	const questions: VoiceQuestion[] = []
	for (const clause of clausesOf(tokensOf(transcript))) {
		const heardWords = clause.itemWords.map(stem)
		const heard = clause.itemWords.join(' ')
		const unitWords = clause.unitWords.join(' ')
		const ranked = rank(heardWords, items)
		const best = ranked[0]
		const second = ranked[1]
		const sure =
			best !== undefined &&
			best.score >= SURE &&
			(second === undefined || best.score - second.score >= MARGIN)
		if (!sure || !best) {
			const candidates = ranked
				.filter((row) => row.score >= CLOSE)
				.filter((row) => !best || row.score >= best.score - MARGIN || ranked.length <= 4)
				.slice(0, 4)
				.map((row) => ({ itemId: row.item.id, name: row.item.name }))
			questions.push({
				kind: 'which_item',
				heard,
				amount: clause.amount,
				unitWords: unitWords || null,
				reason: best && best.score >= SURE ? 'ambiguous' : 'no_match',
				candidates,
			})
			continue
		}
		if (!validAmount(clause.amount)) {
			// An item named with no usable amount: ask nothing silly, say it was not counted.
			questions.push({
				kind: 'which_item',
				heard,
				amount: null,
				unitWords: unitWords || null,
				reason: 'no_match',
				candidates: [{ itemId: best.item.id, name: best.item.name }],
			})
			continue
		}
		const item = best.item
		const options = unitOptionsOf(item)
		let unit: VoiceUnitOption | null = null
		let assumed = false
		if (clause.unitWords.length === 0) {
			unit = defaultUnit(item)
			assumed = true
		} else {
			const concept = conceptOfWord(clause.unitWords[0]!)
			if (concept?.kind === 'standard') {
				unit = options.find((option) => option.ref === concept.unit) ?? null
			} else if (concept) {
				const named = item.units.filter((candidate) => {
					const own = conceptOfNamedUnit(candidate.name)
					return own !== null && sameConcept(own, concept)
				})
				if (named.length === 1) {
					unit = { ref: `unit:${named[0]!.id}`, label: named[0]!.name }
				}
			}
		}
		if (!unit) {
			questions.push({
				kind: 'which_unit',
				heard,
				itemId: item.id,
				itemName: item.name,
				amount: clause.amount,
				unitWords,
				options,
			})
			continue
		}
		lines.push({
			itemId: item.id,
			itemName: item.name,
			amount: clause.amount,
			unit: unit.ref,
			unitLabel: unit.label,
			unitAssumed: assumed,
			heard,
			match: best.score >= 0.95 ? 'exact' : 'close',
		})
	}
	return { transcript, lines, questions }
}
