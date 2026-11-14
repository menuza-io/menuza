import crypto from 'node:crypto'
import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * The "View your order" link in guest order messages: a read-only capability
 * for one order. The token is an HMAC (`AUTH_HMAC_SECRET`) over a purpose label,
 * the organization and the order, so it is never the receipt token, the payment
 * token, or a token for another order or organization. It is deterministic, so
 * a resent message carries the same link, and it lapses 90 days after the
 * order was placed, checked here on every use. It never signs anyone in.
 *
 * The token rides in the URL fragment only (`#link=`), so the site's server
 * never sees it; the page sends it to tenant-api from the browser.
 *
 * Person erasure replaces the order's `receipt_token_hash` with a random value
 * so its receipt link dies; verification checks that hash too, so the order
 * link of an erased order dies with it.
 */

export const ORDER_LINK_PURPOSE = 'order-link:v1'
export const ORDER_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

function toMs(value: Date | number | null | undefined): number | null {
	if (value === null || value === undefined) return null
	const ms = value instanceof Date ? value.getTime() : value
	return Number.isFinite(ms) ? ms : null
}

export function deriveOrderLinkToken(orgId: string, orderId: string): string {
	return hmacHash(`${ORDER_LINK_PURPOSE}:${orgId}:${orderId}`)
}

/**
 * The `receipt_token_hash` an order keeps until it is erased: SHA-256 of its
 * receipt token (`deriveReceiptToken` in `services/order-service.ts`).
 */
function liveReceiptTokenHash(orgId: string, orderId: string): string {
	return crypto
		.createHash('sha256')
		.update(hmacHash(`restaurant-receipt:${orgId}:${orderId}`))
		.digest('hex')
}

/**
 * Whether `presented` is this order's link token, the link is still within its
 * 90 days, and the order was not erased (`receiptTokenHash` is the order row's
 * `receipt_token_hash`). An order without a creation time cannot be proven
 * fresh and is refused.
 */
export function verifyOrderLinkToken(input: {
	orgId: string
	orderId: string
	presented: string | null | undefined
	createdAt: Date | number | null | undefined
	receiptTokenHash: string
	now?: Date | number
}): boolean {
	const presented = input.presented ?? ''
	if (!TOKEN_PATTERN.test(presented)) return false
	const createdAt = toMs(input.createdAt)
	if (createdAt === null) return false
	const now = toMs(input.now ?? Date.now()) ?? Date.now()
	if (now - createdAt > ORDER_LINK_TTL_MS) return false
	const matches = timingSafeEqualString(
		presented,
		deriveOrderLinkToken(input.orgId, input.orderId),
	)
	const live = timingSafeEqualString(
		input.receiptTokenHash,
		liveReceiptTokenHash(input.orgId, input.orderId),
	)
	return matches && live
}

/** When the link stops working (epoch ms), or null without a creation time. */
export function orderLinkExpiresAt(
	createdAt: Date | number | null | undefined,
): number | null {
	const ms = toMs(createdAt)
	return ms === null ? null : ms + ORDER_LINK_TTL_MS
}

/**
 * `<site origin>/menu/success?order=<id>#link=<token>`. The origin is the
 * organization's public site as the control plane resolves it from its slug
 * and custom domain (the same `siteOrigin` reservation emails use), never a
 * browser-sent value. Null when the origin is missing or not http(s).
 */
export function buildOrderLinkUrl(input: {
	siteOrigin: string | null | undefined
	orgId: string
	orderId: string
}): string | null {
	if (!input.siteOrigin) return null
	let origin: URL
	try {
		origin = new URL(input.siteOrigin)
	} catch {
		return null
	}
	if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null
	const url = new URL('/menu/success', origin.origin)
	url.searchParams.set('order', input.orderId)
	url.hash = `link=${deriveOrderLinkToken(input.orgId, input.orderId)}`
	return url.toString()
}
