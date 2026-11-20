/**
 * An extra host of a site (the other form of the primary, an old domain) sends
 * visitors to the primary with a 301 that keeps the path and the query (#139).
 * Null means serve the request as it is.
 */
export function secondaryHostRedirect(input: {
	/** The custom host the request came in on (no port), or null for a slug host. */
	customHost: string | null
	/** The organization's primary host, when it has one. */
	primaryHost: string | null | undefined
	/** The primary answers on its certificate; redirect only then. */
	primaryActive: boolean | undefined
	url: URL
}): string | null {
	const { customHost, url } = input
	const primary = input.primaryHost?.trim().toLowerCase()
	if (!customHost || !primary || !input.primaryActive) return null
	if (customHost.toLowerCase() === primary) return null
	return `${url.protocol}//${primary}${url.pathname}${url.search}`
}
