import {
	CATERING_BALANCE_TOKEN_HEADER,
	CATERING_QUOTE_TOKEN_HEADER,
} from '@repo/common/catering'
import {
	getAccessToken,
	getBrowserTenantApiUrl,
	getOrgBinding,
} from '~/lib/client-auth'
import { acceptCheckoutUrl } from '~/lib/ordering/order-client'

/**
 * The browser-direct catering client. Every call goes from the guest's browser
 * to the regional tenant-api: a guest's name, phone, email, notes and a quote
 * never pass through Sites' server (docs/tenant-data-residency.md). The only
 * call that touches Sites is the opaque payment hand-off
 * (`/api/orders/payment`), which carries the `quote:<id>` / `bal:<id>` /
 * order reference and its payment token, nothing else. The quote and balance
 * links are capabilities kept in the URL fragment and in session storage.
 */

export class CateringClientError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		readonly details: Record<string, unknown> = {},
	) {
		super(code)
		this.name = 'CateringClientError'
	}
}

async function read(response: Response): Promise<Record<string, unknown>> {
	const body = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>
	if (!response.ok) {
		const code =
			typeof body.code === 'string'
				? body.code
				: typeof body.error === 'string'
					? body.error
					: 'request_failed'
		throw new CateringClientError(
			code,
			response.status,
			(body.details as Record<string, unknown> | undefined) ?? {},
		)
	}
	return body
}

function binding(): Record<string, string> {
	return getOrgBinding() as Record<string, string>
}

function url(path: string, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams({ ...binding(), ...extra })
	return `${getBrowserTenantApiUrl()}${path}?${params.toString()}`
}

export type CateringOptions = {
	serverNow: number
	timeZone: string
	cutoffs: Array<{
		id: string
		from: string
		to: string
		orderByAtMs: number
		closed: boolean
		note: string | null
	}>
}

export async function fetchOptions(
	locationId: string,
	locale: string,
): Promise<CateringOptions | null> {
	try {
		const response = await fetch(
			url('/catering/options', { locationId, locale }),
			{
				cache: 'no-store',
			},
		)
		if (!response.ok) return null
		return (await response.json()) as CateringOptions
	} catch {
		return null
	}
}

export async function placeOrder(
	body: Record<string, unknown>,
): Promise<{ orderId: string; paymentToken: string }> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	const access = getAccessToken()
	if (access) headers.Authorization = `Bearer ${access}`
	const response = await fetch(`${getBrowserTenantApiUrl()}/orders`, {
		method: 'POST',
		headers,
		cache: 'no-store',
		body: JSON.stringify({ ...binding(), ...body }),
	})
	const value = await read(response)
	const order = value.order as { id?: string } | undefined
	if (!order?.id || typeof value.paymentToken !== 'string') {
		throw new CateringClientError('request_failed', 502)
	}
	return { orderId: order.id, paymentToken: value.paymentToken }
}

export async function requestQuote(
	body: Record<string, unknown>,
): Promise<void> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	const access = getAccessToken()
	if (access) headers.Authorization = `Bearer ${access}`
	const response = await fetch(
		`${getBrowserTenantApiUrl()}/catering/quote-requests`,
		{
			method: 'POST',
			headers,
			cache: 'no-store',
			body: JSON.stringify({ ...binding(), ...body }),
		},
	)
	await read(response)
}

export type GuestQuote = {
	id: string
	status: string
	payable: boolean
	eventAt: number | null
	guestCount: number | null
	note: string | null
	lines: Array<{
		itemName: string
		variantNames: string[]
		options: string[]
		quantity: number
		totalCents: number
	}>
	charges: Array<{ label: string; amountCents: number }>
	currency: string
	taxCents: number
	totalCents: number
	deposit: {
		percent: number | null
		depositCents: number
		balanceCents: number
	}
	expiresAt: number | null
}

export async function getQuote(id: string, token: string): Promise<GuestQuote> {
	const response = await fetch(
		url(`/catering/quotes/${encodeURIComponent(id)}`),
		{
			cache: 'no-store',
			headers: { [CATERING_QUOTE_TOKEN_HEADER]: token },
		},
	)
	return (await read(response)) as unknown as GuestQuote
}

export type PaymentStart = { orderRef: string; paymentToken: string }

export async function payQuote(
	id: string,
	token: string,
): Promise<PaymentStart> {
	const response = await fetch(
		`${getBrowserTenantApiUrl()}/catering/quotes/${encodeURIComponent(id)}/pay`,
		{
			method: 'POST',
			cache: 'no-store',
			headers: {
				'Content-Type': 'application/json',
				[CATERING_QUOTE_TOKEN_HEADER]: token,
			},
			body: JSON.stringify(binding()),
		},
	)
	return (await read(response)) as unknown as PaymentStart
}

export type GuestBalance = {
	number: string
	status: 'none' | 'awaiting_deposit' | 'due' | 'overdue' | 'paid' | 'void'
	payable: boolean
	eventAt: number | null
	currency: string
	owedCents: number
	dueAt: number | null
}

export async function getBalance(
	id: string,
	token: string,
): Promise<GuestBalance> {
	const response = await fetch(
		url(`/catering/balance/${encodeURIComponent(id)}`),
		{
			cache: 'no-store',
			headers: { [CATERING_BALANCE_TOKEN_HEADER]: token },
		},
	)
	return (await read(response)) as unknown as GuestBalance
}

export async function payBalance(
	id: string,
	token: string,
): Promise<PaymentStart> {
	const response = await fetch(
		`${getBrowserTenantApiUrl()}/catering/balance/${encodeURIComponent(id)}/pay`,
		{
			method: 'POST',
			cache: 'no-store',
			headers: {
				'Content-Type': 'application/json',
				[CATERING_BALANCE_TOKEN_HEADER]: token,
			},
			body: JSON.stringify(binding()),
		},
	)
	return (await read(response)) as unknown as PaymentStart
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
		body: JSON.stringify({
			...binding(),
			orderId: orderRef,
			paymentToken,
			locale,
		}),
	})
	const value = await read(response)
	if (typeof value.checkoutUrl !== 'string') {
		throw new CateringClientError('payment_unavailable', 502)
	}
	return acceptCheckoutUrl(value.checkoutUrl)
}

/** A capability link from the URL fragment: kept in session storage, then removed from the address bar. */
export function takeCapability(kind: 'quote' | 'balance'): {
	id: string
	token: string
} | null {
	const key = `menuza:catering:${kind}`
	const fromHash = new URLSearchParams(location.hash.replace(/^#/, ''))
	const raw = fromHash.get(kind === 'quote' ? 'q' : 'b')
	try {
		if (raw) {
			sessionStorage.setItem(key, raw)
			history.replaceState(null, '', location.pathname + location.search)
		}
		const token = raw ?? sessionStorage.getItem(key)
		if (!token) return null
		const id = token.split('.')[0]
		return id ? { id, token } : null
	} catch {
		return raw ? { id: raw.split('.')[0]!, token: raw } : null
	}
}
