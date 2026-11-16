import {
	GIFT_CARD_SCOPES,
	giftCardFeaturesSchema,
	type GiftCardLedgerKind,
	type GiftCardScope,
	type GiftCardStatus,
} from '@repo/common/gift-cards'
import { z } from 'zod'

/**
 * The browser-direct client for `/operator/gift-cards/*` on the regional
 * node. The App only mints a short-lived `gft+jwt` (`/:org/gift-cards-token`);
 * every card, code, balance and guest detail travels between the browser and
 * the region, never through the App server.
 */

const REFRESH_SKEW_MS = 60_000

/** A failed regional call. `code` is the API's machine-readable error code. */
export class GiftCardApiError extends Error {
	status: number
	code: string | null
	body: Record<string, unknown>
	constructor(
		message: string,
		status: number,
		code: string | null = null,
		body: Record<string, unknown> = {},
	) {
		super(message)
		this.name = 'GiftCardApiError'
		this.status = status
		this.code = code
		this.body = body
	}
}

const tokenResponseSchema = z.object({
	jwt: z.string().min(1),
	tenantApiUrl: z.string().url(),
	expiresAt: z.number(),
	scope: z.enum(GIFT_CARD_SCOPES),
	features: giftCardFeaturesSchema,
})
type TokenResponse = z.infer<typeof tokenResponseSchema>

export type GiftCardSummary = {
	id: string
	last4: string
	externalLast4: string | null
	status: GiftCardStatus
	balanceMinor: number
	currency: string
	source: 'online' | 'pos' | 'import' | 'print'
	locationId: string | null
	batchId: string | null
	designKey: string | null
	createdAt: number
	activatedAt: number | null
	lastUsedAt: number | null
	expiresAt: number | null
	holdReason: 'first_buyer' | 'provider_risk' | 'manual' | null
	holdUntil: number | null
	freezeReason: string | null
	paymentStatus: string
	purchaseAmountMinor: number | null
	imported: boolean
}

export type GiftCardHistoryEntry = {
	id: string
	kind: GiftCardLedgerKind
	amountMinor: number
	sourceType: string
	sourceId: string | null
	channel: string
	locationId: string | null
	actorName: string | null
	reason: string | null
	note: string | null
	refEntryId: string | null
	at: number
}

export type GiftCardDetail = {
	card: GiftCardSummary
	history: GiftCardHistoryEntry[]
	people: {
		purchaserName: string | null
		purchaserEmail: string | null
		recipientName: string | null
		recipientEmail: string | null
		senderName: string | null
		message: string | null
		deliverAt: number | null
		deliveredAt: number | null
	}
	originalLast4: string | null
}

export type GiftCardListFilters = {
	status?: GiftCardStatus
	last4?: string
	needsReview?: boolean
	locationId?: string
	before?: number
}

export type GiftCardClient = {
	list(filters?: GiftCardListFilters): Promise<{ cards: GiftCardSummary[]; next: number | null }>
	lookup(code: string): Promise<GiftCardSummary>
	detail(cardId: string): Promise<GiftCardDetail>
	adjust(input: {
		cardId: string
		expectedBalanceMinor: number
		deltaMinor: number
		reason: string
		key: string
	}): Promise<{ balanceMinor: number }>
	void(input: { cardId: string; reason: string; key: string }): Promise<unknown>
	charge(input: {
		cardId: string
		amountMinor: number
		note: string
		attachTo?: { kind: 'restaurant_order' | 'quote' | 'payment_link'; id: string } | null
		clientRequestId: string
	}): Promise<{ chargeId: string; balanceMinor: number }>
	refundCharge(input: {
		cardId: string
		chargeId: string
		amountMinor: number
		clientRequestId: string
	}): Promise<{ balanceMinor: number }>
	approve(cardId: string): Promise<unknown>
	refundPurchase(cardId: string, key: string, amountMinor?: number): Promise<{
		refundMinor: number
		currency: string
		sessionId: string | null
		processor: 'connect' | 'checkout' | null
		paymentId: string | null
		voided: boolean
	}>
	token(scope: GiftCardScope): Promise<TokenResponse>
}

export function createGiftCardClient({
	orgSlug,
	fetchImpl = fetch,
}: {
	orgSlug: string
	fetchImpl?: typeof fetch
}): GiftCardClient {
	const cached = new Map<GiftCardScope, TokenResponse>()
	const inFlight = new Map<GiftCardScope, Promise<TokenResponse>>()

	async function mint(scope: GiftCardScope): Promise<TokenResponse> {
		const response = await fetchImpl(
			`/${encodeURIComponent(orgSlug)}/gift-cards-token?${new URLSearchParams({ scope })}`,
			{
				headers: { Accept: 'application/json' },
				credentials: 'same-origin',
				cache: 'no-store',
			},
		)
		if (!response.ok) {
			throw new GiftCardApiError(
				`Failed to mint gift card token (${response.status})`,
				response.status,
			)
		}
		return tokenResponseSchema.parse(await response.json())
	}

	async function token(scope: GiftCardScope): Promise<TokenResponse> {
		const existing = cached.get(scope)
		if (existing && existing.expiresAt - Date.now() > REFRESH_SKEW_MS) return existing
		const pending = inFlight.get(scope)
		if (pending) return pending
		const promise = mint(scope)
			.then((value) => {
				cached.set(scope, value)
				return value
			})
			.finally(() => inFlight.delete(scope))
		inFlight.set(scope, promise)
		return promise
	}

	async function request<T>(
		scope: GiftCardScope,
		path: string,
		options: {
			method?: 'GET' | 'POST'
			query?: Record<string, string | number | boolean | undefined>
			body?: unknown
			key?: string
		} = {},
	): Promise<T> {
		const run = async (retried: boolean): Promise<T> => {
			const granted = await token(scope)
			const url = new URL(`${granted.tenantApiUrl.replace(/\/+$/, '')}/operator/gift-cards${path}`)
			for (const [name, value] of Object.entries(options.query ?? {})) {
				if (value !== undefined) url.searchParams.set(name, String(value))
			}
			const headers: Record<string, string> = {
				Accept: 'application/json',
				Authorization: `Bearer ${granted.jwt}`,
			}
			if (options.key) headers['Idempotency-Key'] = options.key
			let body: string | undefined
			if (options.body !== undefined) {
				headers['Content-Type'] = 'application/json'
				body = JSON.stringify(options.body)
			}
			let response: Response
			try {
				response = await fetchImpl(url.toString(), {
					method: options.method ?? 'GET',
					headers,
					body,
					cache: 'no-store',
				})
			} catch {
				throw new GiftCardApiError('Network error', 0)
			}
			if (response.status === 401 && !retried) {
				cached.delete(scope)
				return run(true)
			}
			const text = await response.text()
			let parsed: Record<string, unknown> = {}
			try {
				parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
			} catch {
				// A non-JSON error body.
			}
			if (!response.ok) {
				throw new GiftCardApiError(
					typeof parsed.error === 'string' ? parsed.error : 'Request failed',
					response.status,
					typeof parsed.code === 'string' ? parsed.code : null,
					parsed,
				)
			}
			return parsed as T
		}
		return run(false)
	}

	return {
		token,
		list: (filters = {}) =>
			request('read', '', {
				query: {
					status: filters.status,
					last4: filters.last4,
					needsReview: filters.needsReview ? 'true' : undefined,
					locationId: filters.locationId,
					before: filters.before,
				},
			}),
		lookup: (code) => request('read', '/lookup', { method: 'POST', body: { code } }),
		detail: (cardId) => request('read', `/${encodeURIComponent(cardId)}`),
		adjust: ({ cardId, key, ...body }) =>
			request('write', `/${encodeURIComponent(cardId)}/adjust`, { method: 'POST', body, key }),
		void: ({ cardId, key, ...body }) =>
			request('write', `/${encodeURIComponent(cardId)}/void`, { method: 'POST', body, key }),
		charge: ({ cardId, clientRequestId, ...body }) =>
			request('write', `/${encodeURIComponent(cardId)}/charges`, {
				method: 'POST',
				body: { ...body, clientRequestId },
				key: `charge-${clientRequestId}`,
			}),
		refundCharge: ({ cardId, chargeId, clientRequestId, ...body }) =>
			request('write', `/${encodeURIComponent(cardId)}/charges/${encodeURIComponent(chargeId)}/refund`, {
				method: 'POST',
				body: { ...body, clientRequestId },
				key: `charge-refund-${clientRequestId}`,
			}),
		approve: (cardId) =>
			request('write', `/${encodeURIComponent(cardId)}/approve`, { method: 'POST', body: {} }),
		refundPurchase: (cardId, key, amountMinor) =>
			request('write', `/${encodeURIComponent(cardId)}/refund-purchase`, {
				method: 'POST',
				body: amountMinor === undefined ? {} : { amountMinor },
				key,
			}),
	}
}
