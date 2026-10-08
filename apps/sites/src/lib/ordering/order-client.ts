import {
	createdOrderSchema,
	orderCapabilitySchema,
	orderPaymentRequestSchema,
	type CreatedOrder,
	type OrderCapability,
} from '@repo/common/order-receipt'
import { type PublicOrderingOptions } from '@repo/common/restaurant-orders'
import { type CartItem } from './types.ts'
import { getAccessToken, getOrgBinding } from '~/lib/client-auth'

export class OrderRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code)
		this.name = 'OrderRequestError'
	}
}

/** Only catalog IDs and choices are submitted; prices and names are discarded. */
export function orderLines(cart: CartItem[]) {
	return cart.map((line) => ({
		itemId: line.itemId,
		variantId: line.variantId,
		quantity: line.quantity,
		instructions: line.instructions,
		options: line.options
			// Variation choices are priced from `variantId`; sending them as
			// modifier options would be rejected as unknown modifier groups.
			.filter((option) => !option.variation)
			.map((option) => ({
				groupId: option.groupId,
				optionId: option.optionId,
				half: option.half,
				quantity: option.quantity,
			})),
	}))
}

function regionalUrl() {
	const url = document.documentElement.dataset.tenantApiUrl
	if (!url) throw new OrderRequestError('region_unavailable', 503)
	return url.replace(/\/$/, '')
}

async function responseJson(response: Response): Promise<unknown> {
	const value: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const code =
			value &&
			typeof value === 'object' &&
			'error' in value &&
			typeof value.error === 'string'
				? value.error
				: 'order_failed'
		throw new OrderRequestError(code, response.status)
	}
	return value
}

const capabilityKey = (orgId: string, orderId: string) =>
	`menuza_order_receipt_${orgId}_${orderId}`

export function saveOrderCapability(orgId: string, order: CreatedOrder) {
	sessionStorage.setItem(
		capabilityKey(orgId, order.order.id),
		JSON.stringify({
			receiptToken: order.receiptToken,
			paymentToken: order.paymentToken,
		}),
	)
}

export function loadOrderCapability(
	orgId: string,
	orderId: string,
): OrderCapability | null {
	try {
		const raw = sessionStorage.getItem(capabilityKey(orgId, orderId))
		if (!raw) return null
		const result = orderCapabilitySchema.safeParse(JSON.parse(raw))
		return result.success ? result.data : null
	} catch {
		return null
	}
}

/** Persist only a one-way fingerprint, never customer contact fields. */
async function fingerprintPayload(payload: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(payload))
	if (globalThis.crypto?.subtle) {
		const digest = await crypto.subtle.digest('SHA-256', bytes)
		return Array.from(new Uint8Array(digest), (b) =>
			b.toString(16).padStart(2, '0'),
		).join('')
	}
	// Plain-http dev hosts are not secure contexts and lack WebCrypto; an
	// FNV-1a hash still distinguishes payload changes for idempotency reuse.
	let hash = 0x811c9dc5
	for (const byte of bytes) {
		hash ^= byte
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, '0')
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The regional API requires a UUID; non-secure dev contexts lack randomUUID. */
function randomAttemptKey(): string {
	if (
		typeof crypto !== 'undefined' &&
		typeof crypto.randomUUID === 'function'
	) {
		return crypto.randomUUID()
	}
	const hex = (count: number) =>
		Array.from({ length: count }, () =>
			Math.floor(Math.random() * 16).toString(16),
		).join('')
	return `${hex(8)}-${hex(4)}-4${hex(3)}-${(Math.floor(Math.random() * 4) + 8).toString(16)}${hex(3)}-${hex(12)}`
}

const attemptKey = (orgId: string) => `menuza_order_attempt_${orgId}`

/** Persist only a one-way fingerprint, never customer contact fields. */
export async function checkoutAttemptKey(
	orgId: string,
	payload: unknown,
): Promise<string> {
	const probe = `menuza_order_storage_probe_${orgId}`
	sessionStorage.setItem(probe, '1')
	sessionStorage.removeItem(probe)
	const fingerprint = await fingerprintPayload(payload)
	const key = attemptKey(orgId)
	try {
		const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as {
			fingerprint?: string
			key?: string
		} | null
		if (
			saved?.fingerprint === fingerprint &&
			typeof saved.key === 'string' &&
			UUID_PATTERN.test(saved.key)
		)
			return saved.key
	} catch {
		/* A corrupt attempt is replaced, not reused. */
	}
	const attempt = randomAttemptKey()
	sessionStorage.setItem(key, JSON.stringify({ fingerprint, key: attempt }))
	return attempt
}

/** Forget the attempt after success so a new order gets a fresh key. */
export function clearCheckoutAttempt(orgId: string): void {
	try {
		sessionStorage.removeItem(attemptKey(orgId))
	} catch {
		// Storage unavailable: the next attempt simply mints a new key.
	}
}

/**
 * Public ordering capabilities (online payment, opening state, fulfillment
 * and tip flags). Availability only — no customer data crosses this call.
 */
export async function fetchOrderingOptions(input: {
	locationId: string
	dropSlug?: string | null
}): Promise<PublicOrderingOptions> {
	const params = new URLSearchParams(getOrgBinding())
	params.set('locationId', input.locationId)
	if (input.dropSlug) params.set('dropSlug', input.dropSlug)
	const response = await fetch(
		`${regionalUrl()}/orders/options?${params.toString()}`,
		{ cache: 'no-store' },
	)
	const value: unknown = await responseJson(response)
	if (
		!value ||
		typeof value !== 'object' ||
		!('onlinePayment' in value) ||
		!('ordering' in value)
	) {
		throw new OrderRequestError('options_unavailable', 502)
	}
	return value as PublicOrderingOptions
}

export async function submitRegionalOrder(
	body: Record<string, unknown>,
): Promise<CreatedOrder> {
	const accessToken = getAccessToken()
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (accessToken) headers.Authorization = `Bearer ${accessToken}`
	const response = await fetch(`${regionalUrl()}/orders`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...body, ...getOrgBinding() }),
	})
	return createdOrderSchema.parse(await responseJson(response))
}

/** Receipt capability is sent to the region only, never to App or Sites SSR. */
export async function fetchOrderReceipt(
	orgId: string,
	orderId: string,
): Promise<unknown> {
	const capability = loadOrderCapability(orgId, orderId)
	if (!capability) throw new OrderRequestError('receipt_unavailable', 401)
	const params = new URLSearchParams(getOrgBinding())
	const response = await fetch(
		`${regionalUrl()}/orders/${encodeURIComponent(orderId)}?${params}`,
		{
			headers: { Authorization: `Bearer ${capability.receiptToken}` },
			cache: 'no-store',
		},
	)
	return responseJson(response)
}

/** Opaque payment reference only. Explicit projection prevents PII transit. */
export async function startOrderPayment(
	orgId: string,
	orderId: string,
	locale: string,
) {
	const capability = loadOrderCapability(orgId, orderId)
	if (!capability?.paymentToken)
		throw new OrderRequestError('payment_unavailable', 409)
	const body = orderPaymentRequestSchema.parse({
		...getOrgBinding(),
		orderId,
		paymentToken: capability.paymentToken,
		locale,
	})
	const response = await fetch('/api/orders/payment', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const value = await responseJson(response)
	if (
		!value ||
		typeof value !== 'object' ||
		!('checkoutUrl' in value) ||
		typeof value.checkoutUrl !== 'string'
	) {
		throw new OrderRequestError('payment_unavailable', 502)
	}
	const url = new URL(value.checkoutUrl)
	if (url.protocol !== 'https:')
		throw new OrderRequestError('payment_unavailable', 502)
	return url.toString()
}
