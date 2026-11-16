import {
	giftCardClaimResponseSchema,
	giftCardMineResponseSchema,
	giftCardOptionsSchema,
	giftCardShowTokenResponseSchema,
	type GiftCardGuestViewDto,
	type SavedGiftCardDto,
} from '@repo/common/gift-card-contract'
import {
	GIFT_CARD_ERROR_CODES,
	type GiftCardErrorCode,
} from '@repo/common/gift-cards'
import { type z } from 'zod'
import { ApiError, ORGANIZATION_INACTIVE } from '../api/api-error'
import { type HttpMethod, type HttpTransport } from '../api/http'
import { buildUrl, performRequest, type QueryItems } from '../api/request'
import { type CustomerSession } from '../session/customer-session'
import { authOriginHeader, siteQuery } from '../support/site-address'

export type { GiftCardGuestViewDto, SavedGiftCardDto }

/** Codes this client adds to the server's gift card codes. */
export type GiftCardsClientOnlyCode =
	/** No customer token, or the region refused it and refreshing was refused too. */
	| 'signed_out'
	/** The token belongs to another organization than this site. */
	| 'organization_mismatch'
	/** The region does not serve this site. */
	| 'organization_not_found'
	/** The request never got an answer (offline, DNS, timeout). */
	| 'network'
	/** The answer did not match the published contract. */
	| 'invalid_response'
	| 'unknown'

export type GiftCardsClientErrorCode =
	GiftCardErrorCode | GiftCardsClientOnlyCode

/** What ends the customer's session on this device. */
export function isSessionEndCode(code: GiftCardsClientErrorCode): boolean {
	return code === 'signed_out' || code === 'organization_mismatch'
}

export function isGiftCardErrorCode(
	value: unknown,
): value is GiftCardErrorCode {
	return (
		typeof value === 'string' &&
		(GIFT_CARD_ERROR_CODES as readonly string[]).includes(value)
	)
}

export class GiftCardsClientError extends Error {
	readonly code: GiftCardsClientErrorCode
	readonly status: number
	/** From the answer's `retryAfterSeconds`; `null` otherwise. */
	readonly retryAfterSeconds: number | null

	constructor(
		code: GiftCardsClientErrorCode,
		status: number,
		retryAfterSeconds: number | null = null,
	) {
		super(code)
		this.name = 'GiftCardsClientError'
		this.code = code
		this.status = status
		this.retryAfterSeconds = retryAfterSeconds
	}
}

export function giftCardsErrorCode(error: unknown): GiftCardsClientErrorCode {
	return error instanceof GiftCardsClientError ? error.code : 'unknown'
}

/** True when repeating the same request may succeed. */
export function isRetryableGiftCardsError(error: unknown): boolean {
	if (!(error instanceof GiftCardsClientError)) return true
	return (
		error.code === 'network' ||
		error.code === 'rate_limited' ||
		error.code === 'gift_cards_unavailable' ||
		error.status >= 500
	)
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

/**
 * Maps a failed answer to one typed code. Gift card routes answer
 * `{ error, code }` with a stable code; the shared auth and organization
 * guards in front of them answer plain `{ error }` bodies, so those fall back
 * to the status.
 */
export function giftCardsErrorCodeFrom(
	status: number,
	body: unknown,
): GiftCardsClientErrorCode {
	const record = asRecord(body)
	for (const value of [record.code, record.error]) {
		if (isGiftCardErrorCode(value)) return value
		if (value === 'organization_mismatch') return 'organization_mismatch'
	}
	if (status === 401) return 'signed_out'
	if (status === 403 && record.code === ORGANIZATION_INACTIVE)
		return 'signed_out'
	if (status === 404) return 'organization_not_found'
	if (status === 429) return 'rate_limited'
	if (status === 503) return 'gift_cards_unavailable'
	if (status === 400 || status === 413 || status === 422)
		return 'invalid_request'
	return 'unknown'
}

function retryAfterFrom(body: unknown): number | null {
	const hint = asRecord(body).retryAfterSeconds
	return typeof hint === 'number' && Number.isFinite(hint)
		? Math.max(1, Math.ceil(hint))
		: null
}

export function giftCardsErrorFromResponse(
	status: number,
	body: unknown,
): GiftCardsClientError {
	return new GiftCardsClientError(
		giftCardsErrorCodeFrom(status, body),
		status,
		retryAfterFrom(body),
	)
}

/** The `X-Client` value; tenant-api records channel `native` for both. */
export type GiftCardsClientPlatform = 'ios' | 'android'

export type GiftCardsClientOptions = {
	platform: GiftCardsClientPlatform
	transport?: HttpTransport
}

type Call<Schema extends z.ZodTypeAny> = {
	method: HttpMethod
	path: string
	schema: Schema
	/** Where tenant-api reads the slug or host hint for this route. */
	binding: 'query' | 'body'
	body?: Record<string, unknown>
}

/**
 * Carries a gift card failure through `CustomerSession.authorized`, which only
 * refreshes and retries for an `ApiError` 401.
 */
class GiftCardsRequestFailure extends ApiError {
	readonly failure: GiftCardsClientError

	constructor(failure: GiftCardsClientError) {
		super(failure.status, failure.code, failure.code)
		this.failure = failure
	}
}

/**
 * Typed client for the customer `/gift-cards/*` routes of the regional
 * tenant-api, called straight from the app with the customer token (nothing is
 * proxied through the control plane). tenant-api resolves the organization from
 * the site `Origin` plus the slug or host hint, never from an id this client
 * sends. Nothing here logs tokens, codes or response bodies.
 */
export class GiftCardsClient {
	readonly platform: GiftCardsClientPlatform
	readonly #session: CustomerSession
	readonly #transport: HttpTransport

	constructor(session: CustomerSession, options: GiftCardsClientOptions) {
		this.#session = session
		this.platform = options.platform
		this.#transport = options.transport ?? session.client.transport
	}

	get isSignedIn(): boolean {
		return this.#session.isSignedIn
	}

	/**
	 * Whether this site sells and takes gift cards; `null` while they are off
	 * (the region answers a uniform 404). Needs no sign-in.
	 */
	async available(): Promise<boolean | null> {
		try {
			const data = await this.#send(
				{
					method: 'GET',
					path: '/gift-cards/options',
					schema: giftCardOptionsSchema,
					binding: 'query',
				},
				null,
			)
			return data.enabled
		} catch (error) {
			const failure = this.#failure(error)
			if (failure.code === 'not_found') return null
			throw failure
		}
	}

	/** The signed-in guest's saved cards, with their recent activity. */
	async mine(): Promise<SavedGiftCardDto[]> {
		const data = await this.#member({
			method: 'GET',
			path: '/gift-cards/mine',
			schema: giftCardMineResponseSchema,
			binding: 'query',
		})
		return data.cards
	}

	/** Saves a card to the account by its full code (moves it from another account). */
	claim(
		code: string,
	): Promise<{ card: GiftCardGuestViewDto; alreadyMine: boolean }> {
		return this.#member({
			method: 'POST',
			path: '/gift-cards/claim',
			schema: giftCardClaimResponseSchema,
			binding: 'body',
			body: { code },
		})
	}

	/** A short-lived, one-use token the till scans. It is not the card code. */
	showToken(cardId: string): Promise<{ token: string; expiresAt: number }> {
		return this.#member({
			method: 'POST',
			path: `/gift-cards/${encodeURIComponent(cardId)}/show-token`,
			schema: giftCardShowTokenResponseSchema,
			binding: 'body',
			body: {},
		})
	}

	/** A member call: the customer token, refreshed once on a 401 by the session. */
	async #member<Schema extends z.ZodTypeAny>(
		call: Call<Schema>,
	): Promise<z.output<Schema>> {
		try {
			return await this.#session.authorized((token) => this.#send(call, token))
		} catch (error) {
			throw this.#failure(error)
		}
	}

	async #send<Schema extends z.ZodTypeAny>(
		call: Call<Schema>,
		accessToken: string | null,
	): Promise<z.output<Schema>> {
		const address = this.#session.client.configuration.siteAddress
		const site = siteQuery(address)
		const query: QueryItems = []
		if (site && call.binding === 'query') query.push([site.name, site.value])
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'X-Client': this.platform,
		}
		if (accessToken) headers.Authorization = `Bearer ${accessToken}`
		const origin = authOriginHeader(address)
		if (origin) headers.Origin = origin
		const body =
			call.body && site && call.binding === 'body'
				? { ...call.body, [site.name]: site.value }
				: call.body
		const response = await performRequest(
			this.#transport,
			{
				method: call.method,
				url: buildUrl(this.#session.client.regionalBaseUrl(), call.path, query),
				headers,
				json: body,
				timeoutMs: this.#session.client.configuration.requestTimeoutMs,
			},
			(status, text) =>
				new GiftCardsRequestFailure(
					giftCardsErrorFromResponse(status, parseJson(text)),
				),
		)
		const parsed = call.schema.safeParse(parseJson(response.body))
		if (!parsed.success) {
			throw new GiftCardsClientError('invalid_response', response.status)
		}
		return parsed.data as z.output<Schema>
	}

	#failure(error: unknown): GiftCardsClientError {
		if (error instanceof GiftCardsRequestFailure) return error.failure
		if (error instanceof GiftCardsClientError) return error
		if (error instanceof ApiError) {
			if (error.code === 'region_unavailable') {
				return new GiftCardsClientError('organization_not_found', 0)
			}
			if (error.isTransportFailure)
				return new GiftCardsClientError('network', 0)
			// Anything else came from the session: no token, or a refresh that
			// was refused (the session is gone) or failed for now (it is kept).
			if (error.endsSession || !this.#session.isSignedIn) {
				return new GiftCardsClientError('signed_out', 401)
			}
			return new GiftCardsClientError('network', 0)
		}
		return new GiftCardsClientError('unknown', 0)
	}
}
