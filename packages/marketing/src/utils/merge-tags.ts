import {
	replaceMergeTokens,
	replaceMergeTokensInHtml,
	resolveWithFallback,
} from '@repo/common/merge-tags'

export function interpolateMergeTags(
	template: string,
	vars: Record<string, string | null | undefined>,
): string {
	return replaceMergeTokens(template, (tag, fallback) =>
		resolveWithFallback(vars[tag], fallback),
	)
}

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

const HTML_UNESCAPES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&#x27;': "'",
	'&apos;': "'",
}

/** Undoes `escapeHtml`, or React's escaping (`&#x27;`), in one pass. */
function unescapeHtml(value: string): string {
	return value.replace(
		/&(?:amp|lt|gt|quot|apos|#39|#x27);/g,
		(entity) => HTML_UNESCAPES[entity] ?? entity,
	)
}

/**
 * Interpolate merge tags into an HTML body, escaping each substituted value so
 * customer data cannot inject markup. Use the plain `interpolateMergeTags` for
 * the text part.
 *
 * A fallback is part of the HTML template, so it usually arrives escaped
 * (React escaped it when the email was designed). It is unescaped first, so
 * escaped and raw fallbacks both come out escaped once.
 *
 * In a URL attribute (`href`, `src`, ...) the result must also be a relative
 * URL or use http, https, mailto or tel, or the attribute is emptied.
 */
export function interpolateMergeTagsHtml(
	template: string,
	vars: Record<string, string | null | undefined>,
): string {
	return replaceMergeTokensInHtml(template, (tag, fallback) =>
		escapeHtml(resolveWithFallback(vars[tag], unescapeHtml(fallback))),
	)
}

export function buildRecipientMergeTags(recipient: {
	name?: string | null
	email?: string | null
	phone?: string | null
	organizationName?: string | null
}) {
	const displayName = recipient.name || recipient.email || 'there'
	const firstName = displayName.split(/\s+/)[0] || displayName

	return {
		name: displayName,
		firstName,
		email: recipient.email || '',
		phone: recipient.phone || '',
		organizationName: recipient.organizationName || '',
	}
}
