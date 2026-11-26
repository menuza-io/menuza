import { z } from 'zod'

/**
 * Pay-what-you-owe links for restaurant orders and Station phone orders (#163).
 *
 * The link carries a versioned, expiring HMAC capability token in the URL
 * fragment (`/menu/pay#p=<kind>.<orderId>.<version>.<expiresAtSec>.<mac>`).
 * It never contains contact details and is never stored in plain text.
 */

export const ORDER_PAY_LINKS_FLAG_KEY = 'ordering.pay_links'
export const ORDER_PAY_LINK_TOKEN_PURPOSE = 'order-pay-link:v1'
export const ORDER_PAY_LINK_HEADER = 'X-Pay-Link-Token'
/** A pay link expires 7 days after issuance (or sooner when the order closes). */
export const ORDER_PAY_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type OrderPayLinkKind = 'o' | 'p'

export type ParsedOrderPayLinkToken = {
	kind: OrderPayLinkKind
	orderId: string
	version: number
	expiresAtSec: number
	mac: string
}

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/

export function serializeOrderPayLinkToken(
	parts: ParsedOrderPayLinkToken,
): string {
	return `${parts.kind}.${parts.orderId}.${parts.version}.${parts.expiresAtSec}.${parts.mac}`
}

export function parseOrderPayLinkToken(
	raw: unknown,
): ParsedOrderPayLinkToken | null {
	if (typeof raw !== 'string' || raw.length < 75 || raw.length > 220) {
		return null
	}
	const segments = raw.split('.')
	if (segments.length !== 5) return null
	const [kind, orderId, versionStr, expStr, mac] = segments
	if (kind !== 'o' && kind !== 'p') return null
	if (!orderId || !ORDER_ID_PATTERN.test(orderId)) return null
	if (!versionStr || !/^[1-9]\d{0,8}$/.test(versionStr)) return null
	if (!expStr || !/^[1-9]\d{8,11}$/.test(expStr)) return null
	if (!mac || !HEX64_PATTERN.test(mac)) return null
	const version = Number(versionStr)
	const expiresAtSec = Number(expStr)
	if (!Number.isSafeInteger(version) || !Number.isSafeInteger(expiresAtSec)) {
		return null
	}
	return { kind, orderId, version, expiresAtSec, mac }
}

export const ORDER_PAY_LINK_CHANNELS = ['sms', 'email', 'copy'] as const
export type OrderPayLinkChannel = (typeof ORDER_PAY_LINK_CHANNELS)[number]

export const sendOrderPayLinkRequestSchema = z.strictObject({
	channel: z.enum(ORDER_PAY_LINK_CHANNELS).default('copy'),
	/** Optional override recipient (email or phone) when the order lacks one. */
	recipient: z.string().trim().min(1).max(200).optional(),
})
export type SendOrderPayLinkRequest = z.infer<
	typeof sendOrderPayLinkRequestSchema
>

export type OrderPayLinkLineSummary = {
	name: string
	quantity: number
	totalCents: number
}

export type OrderPayLinkSummary = {
	kind: OrderPayLinkKind
	orderId: string
	number: string
	locationName: string
	currency: string
	totalCents: number
	paidCents: number
	amountDueCents: number
	status: string
	paymentStatus: string
	payable: boolean
	expiresAt: number
	lines: OrderPayLinkLineSummary[]
}

export type OrderPayLinkStart = {
	orderRef: string
	paymentToken: string
	amountDueCents: number
	currency: string
}

/** Computes how much is still owed on an order, clamped at 0. */
export function computeOrderAmountDueCents(input: {
	totalCents: number
	paidCents: number
	giftCardCents?: number
}): number {
	const paid = Math.max(0, input.paidCents)
	const gift = Math.max(0, input.giftCardCents ?? 0)
	return Math.max(0, input.totalCents - paid - gift)
}
