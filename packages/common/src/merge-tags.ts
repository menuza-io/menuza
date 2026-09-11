/**
 * Merge tags shared by marketing emails and automation messages.
 *
 * A tag is stored in plain text as `{{tag}}`, or `{{tag|fallback}}` when a
 * fallback should be used if the recipient has no value for that field. The
 * value is a plain string (not a separate field), so text stays copy-pasteable
 * and needs no schema change when tags change.
 */

export const MERGE_TOKENS = [
	{ tag: 'firstName', label: 'First name', sample: 'Alex' },
	{ tag: 'lastName', label: 'Last name', sample: 'Morgan' },
	{ tag: 'name', label: 'Full name', sample: 'Alex Morgan' },
	{ tag: 'email', label: 'Email', sample: 'alex@example.com' },
	{ tag: 'phone', label: 'Phone', sample: '+1 555 0100' },
	{ tag: 'organizationName', label: 'Company', sample: 'Acme' },
] as const

export type MergeTagName = (typeof MERGE_TOKENS)[number]['tag']

export const MERGE_TAG_NAMES = MERGE_TOKENS.map((entry) => entry.tag)

export function isMergeTagName(value: string): value is MergeTagName {
	return MERGE_TAG_NAMES.includes(value as MergeTagName)
}

export function getMergeTagMeta(tag: string) {
	return MERGE_TOKENS.find((entry) => entry.tag === tag) ?? null
}

/** Human label for a tag, falling back to the raw tag for unknown/custom tags. */
export function mergeTagLabel(tag: string): string {
	return getMergeTagMeta(tag)?.label ?? tag
}

const MERGE_TOKEN_SOURCE =
	'\\{\\{\\s*([a-zA-Z0-9_]+)\\s*(?:\\|\\s*([^{}]*?)\\s*)?\\}\\}'

export function createMergeTokenRegex(): RegExp {
	return new RegExp(MERGE_TOKEN_SOURCE, 'g')
}

export type MergeToken = {
	tag: string
	fallback: string
}

export type MergeSegment =
	| { type: 'text'; value: string; start: number; end: number }
	| {
			type: 'tag'
			tag: string
			fallback: string
			raw: string
			start: number
			end: number
	  }

/** Build the stored text for a tag, including an optional fallback. */
export function buildMergeToken(tag: string, fallback = ''): string {
	const trimmed = fallback.trim()
	return trimmed ? `{{${tag}|${trimmed}}}` : `{{${tag}}}`
}

/**
 * Split text into plain-text and merge-tag segments. Adjacent text is emitted
 * as a single segment so the result can be rendered directly.
 */
export function parseMergeSegments(text: string): MergeSegment[] {
	const segments: MergeSegment[] = []
	const regex = createMergeTokenRegex()
	let lastIndex = 0
	let match: RegExpExecArray | null

	while ((match = regex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			segments.push({
				type: 'text',
				value: text.slice(lastIndex, match.index),
				start: lastIndex,
				end: match.index,
			})
		}
		segments.push({
			type: 'tag',
			tag: match[1]!,
			fallback: match[2] ?? '',
			raw: match[0],
			start: match.index,
			end: match.index + match[0].length,
		})
		lastIndex = match.index + match[0].length
	}

	if (lastIndex < text.length) {
		segments.push({
			type: 'text',
			value: text.slice(lastIndex),
			start: lastIndex,
			end: text.length,
		})
	}

	return segments
}

/** The merge-tag segment containing `offset`, if the caret sits inside one. */
export function findMergeSegmentAt(
	text: string,
	offset: number,
): (MergeSegment & { type: 'tag' }) | null {
	for (const segment of parseMergeSegments(text)) {
		if (segment.type !== 'tag') continue
		if (offset >= segment.start && offset <= segment.end) return segment
	}
	return null
}

/** All distinct merge-tag names used in a piece of text. */
export function collectMergeTags(text: string): string[] {
	const tags = new Set<string>()
	for (const segment of parseMergeSegments(text)) {
		if (segment.type === 'tag') tags.add(segment.tag)
	}
	return [...tags]
}

/**
 * Replace every merge tag using `resolve`. Literal text is passed through
 * untouched, so the caller controls escaping of the resolved values. `raw` is
 * the original token text, useful for preserving unknown tags verbatim.
 */
export function replaceMergeTokens(
	text: string,
	resolve: (tag: string, fallback: string, raw: string) => string,
): string {
	if (!text) return ''
	return text.replace(
		createMergeTokenRegex(),
		(match, tag: string, fallback?: string) =>
			resolve(tag, fallback ?? '', match),
	)
}

/** Resolve a tag to a non-empty value, preferring the value then the fallback. */
export function resolveWithFallback(
	value: string | null | undefined,
	fallback: string,
	builtinDefault = '',
): string {
	const trimmed = value?.trim() ?? ''
	if (trimmed) return trimmed
	return fallback.trim() || builtinDefault
}
