/**
 * The home page's search engine verification meta tags (#138). Codes come
 * from the App already validated; they are checked again here and rendered
 * as attribute values, which Astro escapes.
 */
const GOOGLE = /^[A-Za-z0-9_-]{10,100}$/
const BING = /^[A-Fa-f0-9]{32}$/

export function verificationMetaTags(
	verification:
		{ google?: readonly string[]; bing?: string | null } | null | undefined,
): Array<{ name: string; content: string }> {
	if (!verification) return []
	const tags = (verification.google ?? [])
		.filter((code) => GOOGLE.test(code))
		.map((content) => ({ name: 'google-site-verification', content }))
	if (verification.bing && BING.test(verification.bing)) {
		tags.push({ name: 'msvalidate.01', content: verification.bing })
	}
	return tags
}
