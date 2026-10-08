/**
 * Text folding shared by catalog search and spoken keypad choices, so that
 * speech-to-text spelling variants compare equal.
 */

// Arabic-Indic (U+0660..) and Extended Arabic-Indic / Persian (U+06F0..) digits.
const ARABIC_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/g

// Tashkeel (harakat, tanween, shadda, sukun, superscript alef, Quranic marks)
// and tatweel. NFKD also splits hamza/madda off alef, which this removes.
const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g

/** Lowercases, strips Latin accents, and folds Arabic spelling variants. */
export function foldText(value: string) {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(ARABIC_MARKS, '')
		.replace(ARABIC_DIGITS, (digit) =>
			String((digit.charCodeAt(0) - 0x0660) % 0x90),
		)
		.replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
		.replace(/\u0629/g, '\u0647')
		.replace(/[\u0649\u06cc]/g, '\u064a')
		.replace(/\u06a9/g, '\u0643')
}

const ARABIC_PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال']

/** Drops a leading Arabic definite article ("ال", "وال", "بال"...). */
export function stripArabicArticle(token: string) {
	for (const prefix of ARABIC_PREFIXES) {
		if (token.startsWith(prefix) && token.length - prefix.length >= 2) {
			return token.slice(prefix.length)
		}
	}
	return token
}

/** Folded words: letters (any script), digits, and the keypad symbols. */
export function wordsOf(value: string) {
	return foldText(value)
		.split(/[^\p{L}\p{N}*#]+/u)
		.filter(Boolean)
		.map(stripArabicArticle)
}

/** Levenshtein distance, giving up once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number) {
	if (Math.abs(a.length - b.length) > max) return max + 1
	let previous = Array.from({ length: b.length + 1 }, (ignored, i) => i)
	for (let i = 1; i <= a.length; i++) {
		const current = [i]
		let rowMin = i
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			const value = Math.min(
				previous[j]! + 1,
				current[j - 1]! + 1,
				previous[j - 1]! + cost,
			)
			current.push(value)
			rowMin = Math.min(rowMin, value)
		}
		if (rowMin > max) return max + 1
		previous = current
	}
	return previous[b.length]!
}
