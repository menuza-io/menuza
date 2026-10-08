import { type PhoneAgentSettings, type Pronunciation } from './settings.ts'

/** Deepgram accepts a limited keyterm list; owner terms go first. */
export const MAX_KEYTERMS = 100

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces each term with its spoken form before text reaches the voice, so
 * "Nguyen" is read as "win". Longer terms win over shorter overlaps.
 */
export function applyPronunciations(
	text: string,
	pronunciations: readonly Pronunciation[],
) {
	if (!pronunciations.length || !text) return text
	const sorted = [...pronunciations].sort(
		(a, b) => b.term.length - a.term.length,
	)
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}])(${sorted.map((entry) => escapeRegExp(entry.term)).join('|')})(?![\\p{L}\\p{N}])`,
		'giu',
	)
	const byTerm = new Map(
		sorted.map((entry) => [entry.term.toLocaleLowerCase(), entry.sayAs]),
	)
	return text.replace(
		pattern,
		(match) => byTerm.get(match.toLocaleLowerCase()) ?? match,
	)
}

/**
 * Words speech recognition should expect: the owner's key terms, the
 * business name, then the vertical's terms (see `PhoneAgentVertical.keyterms`)
 * until the list is full.
 */
export function buildKeyterms(input: {
	settings: Pick<PhoneAgentSettings, 'keyterms' | 'pronunciations'>
	businessName: string
	extraTerms?: readonly string[]
}) {
	const seen = new Set<string>()
	const out: string[] = []
	const add = (value: string) => {
		const term = value.trim()
		const key = term.toLocaleLowerCase()
		if (
			!term ||
			term.length > 60 ||
			seen.has(key) ||
			out.length >= MAX_KEYTERMS
		)
			return
		seen.add(key)
		out.push(term)
	}
	input.settings.keyterms.forEach(add)
	input.settings.pronunciations.forEach((entry) => add(entry.term))
	add(input.businessName)
	input.extraTerms?.forEach(add)
	return out
}
