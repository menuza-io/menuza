import {
	giftCardBalanceRequestSchema,
	giftCardClaimResponseSchema,
	giftCardGuestViewSchema,
	giftCardMineResponseSchema,
	giftCardOptionsSchema,
	giftCardPurchaseResponseSchema,
	giftCardShowTokenResponseSchema,
	type GiftCardOptions,
	type GiftCardPurchaseRequest,
	type GiftCardPurchaseResponse,
	type SavedGiftCardDto,
	type GiftCardGuestViewDto,
} from '@repo/common/gift-card-contract'
import {
	getAccessToken,
	getBrowserTenantApiUrl,
	getOrgBinding,
	tenantFetchResponse,
} from '~/lib/client-auth'
import { acceptCheckoutUrl } from '~/lib/ordering/order-client'

/**
 * The browser-direct gift card client. Every call goes from the guest's
 * browser to the regional tenant-api: codes, names, emails and balances never
 * pass through Sites' server (docs/tenant-data-residency.md). The only call
 * that touches Sites is the opaque payment hand-off (`/api/orders/payment`),
 * which carries the `gc:<id>` reference and its payment token, nothing else.
 */

export class GiftCardClientError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		readonly details: Record<string, unknown> = {},
	) {
		super(code)
		this.name = 'GiftCardClientError'
	}
}

function query(extra: Record<string, string> = {}): string {
	const params = new URLSearchParams({
		...(getOrgBinding() as Record<string, string>),
		...extra,
	})
	return params.toString()
}

async function read(response: Response): Promise<unknown> {
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
	if (!response.ok) {
		const code =
			typeof body.code === 'string'
				? body.code
				: typeof body.error === 'string'
					? body.error
					: 'request_failed'
		throw new GiftCardClientError(code, response.status, body)
	}
	return body
}

/** The device id the region hashes for purchase limits: random, kept in this browser. */
export function deviceId(): string {
	try {
		const existing = localStorage.getItem('gift_card_device')
		if (existing) return existing
		const fresh = crypto.randomUUID()
		localStorage.setItem('gift_card_device', fresh)
		return fresh
	} catch {
		return crypto.randomUUID()
	}
}

export async function fetchOptions(): Promise<GiftCardOptions | null> {
	try {
		const response = await fetch(`${getBrowserTenantApiUrl()}/gift-cards/options?${query()}`, {
			cache: 'no-store',
			headers: { Origin: window.location.origin },
		})
		if (!response.ok) return null
		return giftCardOptionsSchema.parse(await response.json())
	} catch {
		return null
	}
}

export async function purchase(
	input: Omit<GiftCardPurchaseRequest, 'slug' | 'host' | 'deviceId'>,
	idempotencyKey: string,
): Promise<GiftCardPurchaseResponse> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Idempotency-Key': idempotencyKey,
	}
	// A signed-in guest's purchase is theirs (saved to their account when it is for themselves).
	const access = getAccessToken()
	if (access) headers.Authorization = `Bearer ${access}`
	const response = await fetch(`${getBrowserTenantApiUrl()}/gift-cards/purchase`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ ...getOrgBinding(), deviceId: deviceId(), ...input }),
		cache: 'no-store',
	})
	return giftCardPurchaseResponseSchema.parse(await read(response))
}

/** Hands the opaque reference to the hosted checkout and returns where to go. */
export async function startPayment(
	orderRef: string,
	paymentToken: string,
	locale: string,
): Promise<string> {
	const response = await fetch('/api/orders/payment', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...getOrgBinding(), orderId: orderRef, paymentToken, locale }),
	})
	const value = (await read(response)) as { checkoutUrl?: unknown }
	if (typeof value.checkoutUrl !== 'string') {
		throw new GiftCardClientError('payment_unavailable', 502)
	}
	return acceptCheckoutUrl(value.checkoutUrl)
}

export async function checkBalance(
	code: string,
	turnstileToken: string | null,
): Promise<GiftCardGuestViewDto> {
	const body = giftCardBalanceRequestSchema.parse({
		...getOrgBinding(),
		code,
		...(turnstileToken ? { turnstileToken } : {}),
	})
	const response = await fetch(`${getBrowserTenantApiUrl()}/gift-cards/balance`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		cache: 'no-store',
	})
	return giftCardGuestViewSchema.parse(await read(response))
}

export async function listMine(): Promise<SavedGiftCardDto[] | 'signed_out'> {
	const response = await tenantFetchResponse(`/gift-cards/mine?${query()}`)
	if (response.status === 401) return 'signed_out'
	return giftCardMineResponseSchema.parse(await read(response)).cards
}

export async function claim(code: string) {
	const response = await tenantFetchResponse('/gift-cards/claim', {
		method: 'POST',
		body: JSON.stringify({ ...getOrgBinding(), code }),
	})
	return giftCardClaimResponseSchema.parse(await read(response))
}

export async function showToken(cardId: string) {
	const response = await tenantFetchResponse(
		`/gift-cards/${encodeURIComponent(cardId)}/show-token`,
		{ method: 'POST', body: JSON.stringify({ ...getOrgBinding() }) },
	)
	return giftCardShowTokenResponseSchema.parse(await read(response))
}
