import { buildLink } from '@repo/common/links'
import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * The "Back to your order" link in a cart reminder (#150): a capability for one
 * guest's left-behind cart, valid 7 days. The token is `<expiry>.<guest id>.<hmac>`: an
 * HMAC (`AUTH_HMAC_SECRET`) over a purpose label, the organization, the guest
 * and the expiry, so it cannot be moved to another guest, organization or
 * expiry. It rides in the URL fragment only (`#cart=`), so the site's server
 * never sees it, and tenant-api reads it from the `X-Cart-Token` header. It
 * never signs anyone in and reveals ids and quantities only: no contact, no
 * address.
 *
 * It also dies with the snapshot: an order, an emptied cart, the 7-day cleanup
 * and person erasure all delete `customer_carts`, which the reader checks.
 */

export const CART_LINK_PURPOSE = 'cart-link:v1'
export const CART_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const CART_TOKEN_HEADER = 'X-Cart-Token'

const TOKEN_PATTERN = /^(\d{10,16})\.([A-Za-z0-9_-]{1,64})\.([0-9a-f]{64})$/

function sign(orgId: string, customerId: string, expiresAt: number): string {
	return hmacHash(`${CART_LINK_PURPOSE}:${orgId}:${customerId}:${expiresAt}`)
}

/** `<expiry>.<guest id>.<hmac>`: the guest id is an opaque id, never contact data. */
export function issueCartToken(input: {
	orgId: string
	customerId: string
	now?: number
}): string {
	const expiresAt = (input.now ?? Date.now()) + CART_LINK_TTL_MS
	return `${expiresAt}.${input.customerId}.${sign(input.orgId, input.customerId, expiresAt)}`
}

/**
 * The guest a presented token names, or null: malformed, forged (the HMAC
 * covers the organization, the guest and the expiry), or expired. The caller
 * still checks that the guest's cart snapshot exists.
 */
export function verifyCartToken(input: {
	orgId: string
	presented: string | null | undefined
	now?: number
}): { customerId: string } | null {
	const match = TOKEN_PATTERN.exec(input.presented ?? '')
	if (!match) return null
	const expiresAt = Number(match[1])
	const customerId = match[2]!
	if (!Number.isFinite(expiresAt) || (input.now ?? Date.now()) > expiresAt) {
		return null
	}
	return timingSafeEqualString(
		match[3]!,
		sign(input.orgId, customerId, expiresAt),
	)
		? { customerId }
		: null
}

/**
 * `<site origin>/menu#cart=<token>`, built by the shared link registry
 * (`@repo/common/links`, type `cart`; website only, the app has no cart). The
 * origin is the organization's public site as the control plane resolves it,
 * never a browser-sent value. Null when the origin is missing or not http(s).
 */
export function buildCartLinkUrl(input: {
	siteOrigin: string | null | undefined
	token: string
}): string | null {
	return buildLink('cart', { cart: input.token }, { origin: input.siteOrigin })
}
