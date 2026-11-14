/**
 * The "View your order" link: `/menu/success?order=<id>#link=<token>`. The
 * token lives in the URL fragment only, so Sites SSR never sees it; the
 * browser sends it to the regional tenant-api as `X-Order-Link`. Nothing here
 * logs, stores or rewrites it.
 */

/** A link token is 64 hex characters; anything else is not one of ours. */
const LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/

/** A fragment longer than this is refused before it is parsed. */
const MAX_HASH_LENGTH = 512

export type OrderLinkRead =
	| { status: 'absent' }
	| { status: 'invalid' }
	| { status: 'valid'; token: string }

/**
 * Reads `link=<token>` from a location hash. `absent` means no `link`
 * parameter; `invalid` means one was present but malformed or over-long.
 */
export function readOrderLink(hash: string): OrderLinkRead {
	if (hash.length > MAX_HASH_LENGTH) {
		return hash.includes('link=') ? { status: 'invalid' } : { status: 'absent' }
	}
	const raw = hash.startsWith('#') ? hash.slice(1) : hash
	const params = new URLSearchParams(raw)
	if (!params.has('link')) return { status: 'absent' }
	const token = params.get('link')?.trim().toLowerCase() ?? ''
	return LINK_TOKEN_PATTERN.test(token)
		? { status: 'valid', token }
		: { status: 'invalid' }
}

export type OrderCredential =
	{ kind: 'link'; token: string } | { kind: 'receipt'; token: string }

/**
 * The credential to read an order with: the link token when the page was
 * opened from the link, otherwise the receipt token saved in this browser.
 */
export function chooseOrderCredential(input: {
	link: OrderLinkRead
	receiptToken: string | null | undefined
}): OrderCredential | null {
	if (input.link.status === 'valid') {
		return { kind: 'link', token: input.link.token }
	}
	return input.receiptToken
		? { kind: 'receipt', token: input.receiptToken }
		: null
}

/** The request header that carries a credential. */
export function credentialHeaders(
	credential: OrderCredential,
): Record<string, string> {
	return credential.kind === 'link'
		? { 'X-Order-Link': credential.token }
		: { Authorization: `Bearer ${credential.token}` }
}
