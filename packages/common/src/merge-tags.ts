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

/** Schemes a merge tag may produce in a URL-valued HTML attribute. */
export const SAFE_URL_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const

const URL_ATTRIBUTES = new Set([
	'href',
	'src',
	'action',
	'formaction',
	'background',
	'poster',
	'cite',
	'longdesc',
	'xlink:href',
])

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	colon: ':',
	tab: '\t',
	newline: '\n',
	sol: '/',
	lpar: '(',
	rpar: ')',
	period: '.',
}

/** Decode character references once, as a browser does for an attribute. */
function decodeAttributeValue(value: string): string {
	return value.replace(
		/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi,
		(entity, hex?: string, dec?: string, name?: string) => {
			if (hex || dec) {
				const code = hex ? parseInt(hex, 16) : Number(dec)
				return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
			}
			return NAMED_ENTITIES[name!.toLowerCase()] ?? entity
		},
	)
}

/**
 * Whether an HTML attribute value (as written in the markup) is a URL with an
 * allowed scheme, or a relative URL. The value is decoded once, then the
 * characters a URL parser drops (tabs, newlines, leading and trailing control
 * characters and spaces) are removed, so `java&#x09;script:` and
 * `JavaScript:` are caught. Anything before the first `:` that may still be a
 * character reference is refused rather than guessed at.
 */
export function isSafeUrlAttributeValue(attributeValue: string): boolean {
	const url = decodeAttributeValue(attributeValue)
		.replace(/[\t\n\r]/g, '')
		// eslint-disable-next-line no-control-regex
		.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
	if (scheme) {
		return (SAFE_URL_SCHEMES as readonly string[]).includes(
			scheme[1]!.toLowerCase(),
		)
	}
	const colon = url.indexOf(':')
	if (colon === -1) return true
	const beforeColon = url.slice(0, colon)
	// A relative URL whose first `:` comes after a path, query or fragment.
	// eslint-disable-next-line no-control-regex
	if (/[/?#]/.test(beforeColon) && !/[&\u0000-\u0020]/.test(beforeColon)) {
		return true
	}
	return false
}

/**
 * Calls `replace` with every start tag (`<name ...>`) in `html` and splices in
 * its result. Tag boundaries follow the HTML tokenizer's attribute states: a
 * quote opens a value only right after `=` (a quote inside an unquoted value
 * or an attribute name is an ordinary character), and a `>` inside a quoted
 * value does not end the tag. So `<a title="x>y" href="...">` and
 * `<a title=a"b href="...">` are each one tag whose `href` is checked.
 *
 * Fails closed: from a tag that never ends (no `>`, or a quoted value that
 * never closes) every `<` is escaped to `&lt;`, so nothing later in the
 * template is passed through as markup unchecked.
 */
function replaceStartTags(
	html: string,
	replace: (tag: string) => string,
): string {
	const isSpace = (char: string | undefined) =>
		char === ' ' ||
		char === '\t' ||
		char === '\n' ||
		char === '\r' ||
		char === '\f'
	/** Index of the tag's closing `>`, or -1 when a quoted value never closes. */
	function tagEnd(start: number): number {
		let j = start
		while (
			j < html.length &&
			!isSpace(html[j]) &&
			html[j] !== '/' &&
			html[j] !== '>'
		)
			j++
		while (j < html.length) {
			const char = html[j]!
			if (char === '>') return j
			if (isSpace(char) || char === '/') {
				j++
				continue
			}
			// Attribute name (its first character may be `=`).
			j++
			while (
				j < html.length &&
				!isSpace(html[j]) &&
				html[j] !== '/' &&
				html[j] !== '>' &&
				html[j] !== '='
			) {
				j++
			}
			let k = j
			while (isSpace(html[k])) k++
			if (html[k] !== '=') continue
			k++
			while (isSpace(html[k])) k++
			const quote = html[k]
			if (quote === '"' || quote === "'") {
				const close = html.indexOf(quote, k + 1)
				if (close === -1) return -1
				j = close + 1
			} else {
				while (k < html.length && !isSpace(html[k]) && html[k] !== '>') k++
				j = k
			}
		}
		return -1
	}

	let out = ''
	let copied = 0
	let i = html.indexOf('<')
	while (i !== -1 && i < html.length - 1) {
		if (!/[a-zA-Z]/.test(html[i + 1]!)) {
			i = html.indexOf('<', i + 1)
			continue
		}
		const end = tagEnd(i + 1)
		if (end === -1) {
			// Fail closed, in one pass: a browser reads the rest as part of this
			// tag, so escape every `<` from here and stop. Rescanning after each
			// broken tag would be quadratic on input like `<a<a<a...`.
			out += html.slice(copied, i) + html.slice(i).replaceAll('<', '&lt;')
			return out
		}
		out += html.slice(copied, i) + replace(html.slice(i, end + 1))
		copied = end + 1
		i = html.indexOf('<', copied)
	}
	return out + html.slice(copied)
}

const HTML_ATTRIBUTE =
	/(\s)([^\s"'<>/=]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

/**
 * `replaceMergeTokens` for an HTML template. Tokens in text and ordinary
 * attributes are replaced with `resolve` (which must escape its result). In a
 * URL-valued attribute (`href`, `src`, ...) that holds a token, the whole
 * value is checked after replacement: unless it is a relative URL or uses
 * http, https, mailto or tel, the attribute value is emptied, since escaping
 * does not make `javascript:` safe.
 */
export function replaceMergeTokensInHtml(
	template: string,
	resolve: (tag: string, fallback: string, raw: string) => string,
): string {
	if (!template) return ''
	const guardedTags = replaceStartTags(template, (tag) =>
		tag.replace(
			HTML_ATTRIBUTE,
			(
				attribute,
				space: string,
				name: string,
				equals: string,
				doubleQuoted?: string,
				singleQuoted?: string,
				unquoted?: string,
			) => {
				const value = doubleQuoted ?? singleQuoted ?? unquoted ?? ''
				if (
					!URL_ATTRIBUTES.has(name.toLowerCase()) ||
					!createMergeTokenRegex().test(value)
				) {
					return attribute
				}
				const replaced = replaceMergeTokens(value, resolve)
				const safe = isSafeUrlAttributeValue(replaced) ? replaced : ''
				const quote =
					doubleQuoted !== undefined
						? '"'
						: singleQuoted !== undefined
							? "'"
							: '"'
				// Mark the value as done so the outer pass leaves it alone.
				return `${space}${name}${equals}${quote}${protectTokens(safe)}${quote}`
			},
		),
	)
	return restoreTokens(replaceMergeTokens(guardedTags, resolve))
}

// Replaced attribute values can contain `{{...}}` text from a recipient's
// value; this keeps the outer pass from treating it as a token.
const OPEN_BRACES = '\u0000mt-open\u0000'
function protectTokens(value: string): string {
	return value.replaceAll('{{', OPEN_BRACES)
}
function restoreTokens(value: string): string {
	return value.replaceAll(OPEN_BRACES, '{{')
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
