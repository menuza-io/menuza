import {
	parseLocalizedString,
	type SiteContentLocale,
} from '@repo/common/site-locales'
import { z } from 'zod'
import { type MenuHealth } from './menu-health.ts'

/**
 * Review suggestions: the card stack behind the Menu health card's "Review
 * suggestions" button. Pure, so the server (which builds and checks them) and
 * the browser (which shows them) agree on the shapes.
 *
 * Only four kinds, in this order: a missing translation, a missing
 * description, an empty category and a dish unavailable for more than a week.
 * Photos, zero prices and allergens stay as filtered lists: allergens are
 * safety data and are never suggested.
 */

export const MENU_SUGGESTION_KINDS = [
	'translation',
	'description',
	'empty_category',
	'long_unavailable',
] as const

export type MenuSuggestionKind = (typeof MENU_SUGGESTION_KINDS)[number]

/** Suggestions made per request; the AI is asked about at most this many. */
export const MENU_SUGGESTION_BATCH_SIZE = 10

/** Seen suggestions the browser may send back so a batch skips them. */
export const MENU_SUGGESTION_SEEN_MAX = 500

export const MENU_SUGGESTION_LIMITS = {
	name: 120,
	description: 300,
	/** A short description reads in one breath. */
	descriptionWords: 40,
} as const

export type MenuSuggestionCandidate =
	| {
			kind: 'translation'
			id: string
			itemId: string
			locale: SiteContentLocale
			needsName: boolean
			needsDescription: boolean
	  }
	| { kind: 'description'; id: string; itemId: string }
	| { kind: 'empty_category'; id: string; categoryId: string }
	| { kind: 'long_unavailable'; id: string; itemId: string }

type DishCard = {
	/** In the menu's source language. */
	dishName: string
	imageUrl: string | null
}

export type MenuSuggestion =
	| (DishCard & {
			kind: 'translation'
			id: string
			itemId: string
			locale: SiteContentLocale
			sourceLocale: SiteContentLocale
			name: string | null
			description: string | null
	  })
	| (DishCard & {
			kind: 'description'
			id: string
			itemId: string
			locale: SiteContentLocale
			description: string
			/** How many dishes already have a description (the tone it copied). */
			styleExamples: number
	  })
	| {
			kind: 'empty_category'
			id: string
			categoryId: string
			categoryName: string
	  }
	| (DishCard & {
			kind: 'long_unavailable'
			id: string
			itemId: string
			/** Days since the dish was last changed (it stands in for "since"). */
			days: number
	  })

export type MenuSuggestionBatch = {
	suggestions: MenuSuggestion[]
	/**
	 * Every candidate this batch looked at, including ones the AI could not
	 * answer. The browser adds them to `seen` so the next batch moves on.
	 */
	considered: string[]
	/** Candidates left after this batch, not counting seen ones. */
	remaining: number
	/** All candidates, not counting seen ones, when the batch was made. */
	total: number
	/** Some AI suggestions could not be made (not configured or failed). */
	aiUnavailable: boolean
}

export type MenuSuggestionItem = {
	id: string
	displayName: string
	description: string | null
}

/**
 * Every suggestion that could be made, most useful first. Ids are stable
 * (`<kind>:<record>[:<locale>]`) so the browser can say which ones it has
 * already seen. Hidden items and categories never show up: `computeMenuHealth`
 * already leaves them out.
 */
export function buildMenuSuggestionCandidates(input: {
	health: MenuHealth
	items: MenuSuggestionItem[]
	locales: readonly SiteContentLocale[]
	defaultLocale: SiteContentLocale
}): MenuSuggestionCandidate[] {
	const idsOf = (key: string) =>
		input.health.checks.find((check) => check.key === key)
	const itemsById = new Map(input.items.map((item) => [item.id, item]))
	const candidates: MenuSuggestionCandidate[] = []

	const translationCheck = idsOf('missing_translation')
	const translationLocales = (translationCheck?.locales ?? []).filter(
		(locale) => locale !== input.defaultLocale,
	)
	for (const itemId of translationCheck?.itemIds ?? []) {
		const item = itemsById.get(itemId)
		if (!item) continue
		const name = parseLocalizedString(item.displayName, input.defaultLocale)
		const description = parseLocalizedString(
			item.description,
			input.defaultLocale,
		)
		// Translate from the source language only; a dish without a source
		// name has nothing to translate yet.
		if (!hasText(name[input.defaultLocale])) continue
		const hasSourceDescription = hasText(description[input.defaultLocale])
		for (const locale of translationLocales) {
			const needsName = !hasText(name[locale])
			const needsDescription =
				hasSourceDescription && !hasText(description[locale])
			if (!needsName && !needsDescription) continue
			candidates.push({
				kind: 'translation',
				id: `translation:${itemId}:${locale}`,
				itemId,
				locale,
				needsName,
				needsDescription,
			})
		}
	}

	for (const itemId of idsOf('no_description')?.itemIds ?? []) {
		const item = itemsById.get(itemId)
		if (!item) continue
		const name = parseLocalizedString(item.displayName, input.defaultLocale)
		if (!hasText(name[input.defaultLocale])) continue
		candidates.push({
			kind: 'description',
			id: `description:${itemId}`,
			itemId,
		})
	}

	for (const categoryId of idsOf('empty_category')?.categoryIds ?? []) {
		candidates.push({
			kind: 'empty_category',
			id: `empty_category:${categoryId}`,
			categoryId,
		})
	}

	for (const itemId of idsOf('long_unavailable')?.itemIds ?? []) {
		candidates.push({
			kind: 'long_unavailable',
			id: `long_unavailable:${itemId}`,
			itemId,
		})
	}

	return candidates
}

/** The next batch: candidates not yet seen, at most `size` of them. */
export function pickSuggestionBatch(
	candidates: MenuSuggestionCandidate[],
	seen: Iterable<string>,
	size: number = MENU_SUGGESTION_BATCH_SIZE,
): {
	batch: MenuSuggestionCandidate[]
	remaining: number
	total: number
} {
	const seenIds = new Set(seen)
	const unseen = candidates.filter((candidate) => !seenIds.has(candidate.id))
	const batch = unseen.slice(0, size)
	return {
		batch,
		remaining: unseen.length - batch.length,
		total: unseen.length,
	}
}

function hasText(value: string | undefined | null): boolean {
	return Boolean(value?.trim())
}

/**
 * Control characters, zero-width characters and bidi overrides: they can hide
 * or reorder text on the menu. Built from a string so the pattern stays
 * readable escapes rather than invisible characters.
 */
const INVISIBLE = new RegExp(
	// oxlint-disable-next-line no-control-regex -- matching them is the point
	'[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]',
	'g',
)

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&quot;': '"',
	'&#39;': "'",
	'&#x27;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
}

/**
 * Clean text that came from a model or a translation service before it is
 * shown or saved: no tags, no angle brackets, no control characters, no
 * Markdown emphasis or wrapping quotes, one line, and at most `max`
 * characters (cut at a word where possible). Returns '' when nothing is left.
 */
export function sanitizeSuggestionText(raw: unknown, max: number): string {
	if (typeof raw !== 'string') return ''
	let text = raw
		// Tags first (repeat: `<scr<b>ipt>` leaves a tag after one pass).
		.replace(/<!--[\s\S]*?-->/g, ' ')
	let previous: string
	do {
		previous = text
		text = text.replace(/<[^<>]*>/g, ' ')
	} while (text !== previous)
	text = text
		.replace(/&(amp|quot|#39|#x27|apos|nbsp);/g, (entity) => {
			return ENTITIES[entity] ?? ' '
		})
		// What is left of a tag, and anything that could start one.
		.replace(/[<>]/g, ' ')
		.replace(INVISIBLE, ' ')
		.replace(/\*\*|__|`/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	// A reply wrapped in quotes: "Crispy..." -> Crispy...
	const quoted = /^["'“”«»](.*)["'“”«»]$/u.exec(text)
	if (quoted?.[1]) text = quoted[1].trim()
	if (text.length <= max) return text
	const cut = text.slice(0, max)
	const space = cut.lastIndexOf(' ')
	return (space > max * 0.6 ? cut.slice(0, space) : cut).trim()
}

/** A model reply for a batch of descriptions, before it is cleaned. */
export const DescriptionReplySchema = z.object({
	descriptions: z
		.array(
			z.object({
				id: z.string().min(1).max(60),
				description: z.string().max(2_000),
			}),
		)
		.max(MENU_SUGGESTION_BATCH_SIZE * 2),
})

/**
 * Parse a model reply (JSON, maybe inside a code fence) into cleaned
 * descriptions by id. Ids not asked about are dropped, so a reply cannot
 * write to another dish. Over-long or empty answers are dropped too.
 */
export function parseDescriptionReply(
	text: string,
	askedIds: ReadonlySet<string>,
): Map<string, string> {
	const result = new Map<string, string>()
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start === -1 || end <= start) return result
	let raw: unknown
	try {
		raw = JSON.parse(text.slice(start, end + 1))
	} catch {
		return result
	}
	const parsed = DescriptionReplySchema.safeParse(raw)
	if (!parsed.success) return result
	for (const entry of parsed.data.descriptions) {
		if (!askedIds.has(entry.id) || result.has(entry.id)) continue
		const words = entry.description.trim().split(/\s+/).length
		if (words > MENU_SUGGESTION_LIMITS.descriptionWords * 2) continue
		const clean = sanitizeSuggestionText(
			entry.description,
			MENU_SUGGESTION_LIMITS.description,
		)
		if (clean) result.set(entry.id, clean)
	}
	return result
}

/** One localized text change on a dish: a value, or null to clear it. */
export const MenuTextChangeSchema = z.object({
	field: z.enum(['displayName', 'description']),
	locale: z.string().min(2).max(10),
	value: z
		.string()
		.max(MENU_SUGGESTION_LIMITS.description * 2)
		.nullable(),
})

export type MenuTextChange = z.infer<typeof MenuTextChangeSchema>
