import {
	replaceMergeTokens,
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

/**
 * Interpolate merge tags into an HTML body, escaping each substituted value so
 * customer data cannot inject markup. Use the plain `interpolateMergeTags` for
 * the text part.
 */
export function interpolateMergeTagsHtml(
	template: string,
	vars: Record<string, string | null | undefined>,
): string {
	return replaceMergeTokens(template, (tag, fallback) =>
		escapeHtml(resolveWithFallback(vars[tag], fallback)),
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
