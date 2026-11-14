/**
 * The "View your order" link: `/menu/success?order=<id>#link=<token>`. The
 * token arrives in the URL fragment only, so Sites SSR never sees it; the
 * browser sends it to the regional tenant-api as `X-Order-Link`. Scripts on
 * the page (analytics), history sync and screenshots can read the fragment,
 * so the page strips it as its first act: an inline head script parks the raw
 * fragment in sessionStorage (`PENDING_HASH_KEY`) and rewrites the URL, then
 * `claimOrderLink` keeps the token per order in sessionStorage (this tab
 * only; never localStorage, cookies or a query string).
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

/** Where the inline head script parks the raw fragment until it is claimed. */
export const PENDING_HASH_KEY = 'menuza_order_link_pending'

export const orderLinkKey = (orgId: string, orderId: string) =>
	`menuza_order_link_${orgId}_${orderId}`

type LinkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Tokens kept in memory for this page view when sessionStorage throws. */
const memoryTokens = new Map<string, string>()

export type ClaimOrderLinkInput = {
	orgId: string
	orderId: string | null
	location: Pick<Location, 'hash' | 'pathname' | 'search'>
	history: Pick<History, 'replaceState'>
	/** Resolved lazily: reading `sessionStorage` itself can throw. */
	storage: () => LinkStorage | null
	memory?: Map<string, string>
}

/**
 * Takes the link token out of the fragment (or the parked copy), stores it
 * for this order, removes the fragment from the address bar and returns what
 * was found. Without a fragment it returns the token stored earlier for this
 * order, so a reload in the same tab keeps working.
 */
export function claimOrderLink(input: ClaimOrderLinkInput): OrderLinkRead {
	const memory = input.memory ?? memoryTokens
	let storage: LinkStorage | null = null
	try {
		storage = input.storage()
	} catch {
		storage = null
	}
	let hash = input.location.hash
	try {
		const parked = storage?.getItem(PENDING_HASH_KEY)
		if (parked) {
			if (!hash) hash = parked
			storage?.removeItem(PENDING_HASH_KEY)
		}
	} catch {
		/* Nothing parked. */
	}
	if (input.location.hash) {
		try {
			input.history.replaceState(
				null,
				'',
				input.location.pathname + input.location.search,
			)
		} catch {
			/* Leave the address as it is. */
		}
	}
	const read = readOrderLink(hash)
	if (read.status !== 'absent') {
		if (read.status === 'valid' && input.orderId) {
			const key = orderLinkKey(input.orgId, input.orderId)
			memory.set(key, read.token)
			try {
				storage?.setItem(key, read.token)
			} catch {
				/* Memory copy only. */
			}
		}
		return read
	}
	if (!input.orderId) return read
	const key = orderLinkKey(input.orgId, input.orderId)
	let stored: string | null = null
	try {
		stored = storage?.getItem(key) ?? null
	} catch {
		stored = null
	}
	stored ??= memory.get(key) ?? null
	return stored && LINK_TOKEN_PATTERN.test(stored)
		? { status: 'valid', token: stored }
		: read
}
