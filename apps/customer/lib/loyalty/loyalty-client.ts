import {
	isLoyaltyErrorCode,
	loyaltyApprovalResponseSchema,
	loyaltyApprovalsResponseSchema,
	type LoyaltyCustomerApproval,
	type LoyaltyErrorCode,
	type LoyaltyHistoryEntry,
	loyaltyHistoryResponseSchema,
	loyaltyMemberCodeResponseSchema,
	loyaltyProgramResponseSchema,
	type LoyaltyPublicProgram,
	type LoyaltyWallet,
	loyaltyWalletResponseSchema,
} from '@repo/loyalty'
import { randomUUID } from 'expo-crypto'
import { type z } from 'zod'
import { ApiError, ORGANIZATION_INACTIVE } from '../api/api-error'
import { type HttpMethod, type HttpTransport } from '../api/http'
import { buildUrl, performRequest, type QueryItems } from '../api/request'
import { type CustomerSession } from '../session/customer-session'
import { authOriginHeader, siteQuery } from '../support/site-address'

export type {
	LoyaltyCustomerApproval,
	LoyaltyHistoryEntry,
	LoyaltyPublicProgram,
	LoyaltyWallet,
}

/** Codes the client adds to the server's loyalty codes (the same set as Sites). */
export type LoyaltyClientOnlyCode =
	/**
	 * No customer token, or the region refused it and refreshing was refused
	 * too. A refresh that failed for now reports 'network' instead.
	 */
	| 'signed_out'
	/** The token belongs to another organization than this site. */
	| 'organization_mismatch'
	/** The region does not serve this site (unknown, unprovisioned, no node for its region). */
	| 'organization_not_found'
	/** The request never got an answer (offline, DNS, timeout). */
	| 'network'
	/** The answer did not match the published contract. */
	| 'invalid_response'
	| 'unknown'

export type LoyaltyClientErrorCode = LoyaltyErrorCode | LoyaltyClientOnlyCode

/** What ends the customer's session on this device. */
export type LoyaltySessionEndCode = Extract<
	LoyaltyClientErrorCode,
	'signed_out' | 'organization_mismatch'
>

export function isSessionEndCode(
	code: LoyaltyClientErrorCode,
): code is LoyaltySessionEndCode {
	return code === 'signed_out' || code === 'organization_mismatch'
}

export class LoyaltyClientError extends Error {
	readonly code: LoyaltyClientErrorCode
	readonly status: number
	/** From the answer's `retryAfterSeconds` or `Retry-After`; `null` otherwise. */
	readonly retryAfterSeconds: number | null

	constructor(
		code: LoyaltyClientErrorCode,
		status: number,
		retryAfterSeconds: number | null = null,
	) {
		super(code)
		this.name = 'LoyaltyClientError'
		this.code = code
		this.status = status
		this.retryAfterSeconds = retryAfterSeconds
	}
}

export function loyaltyErrorCode(error: unknown): LoyaltyClientErrorCode {
	return error instanceof LoyaltyClientError ? error.code : 'unknown'
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
 * Maps a failed answer to one typed code. Loyalty routes send
 * `{ error, code }` with a stable code; the shared auth and organization
 * guards in front of them answer plain `{ error }` bodies with English text,
 * so those fall back to the status.
 */
export function loyaltyErrorCodeFrom(
	status: number,
	body: unknown,
): LoyaltyClientErrorCode {
	const record = asRecord(body)
	for (const value of [record.code, record.error]) {
		if (isLoyaltyErrorCode(value)) return value
		if (value === 'organization_mismatch') return 'organization_mismatch'
	}
	if (status === 401) return 'signed_out'
	if (status === 403 && record.code === ORGANIZATION_INACTIVE)
		return 'signed_out'
	if (status === 404) return 'organization_not_found'
	if (status === 429) return 'rate_limited'
	if (status === 503) return 'loyalty_unavailable'
	if (status === 400 || status === 422) return 'invalid_request'
	return 'unknown'
}

/** Whole seconds, from the body hint first, else the `Retry-After` header (seconds or a date). */
function retryAfterFrom(
	body: unknown,
	headers: Readonly<Record<string, string>>,
	now: number,
): number | null {
	const hint = asRecord(body).retryAfterSeconds
	if (typeof hint === 'number' && Number.isFinite(hint))
		return Math.max(1, Math.ceil(hint))
	const raw = headers['retry-after']?.trim()
	if (!raw) return null
	if (/^\d+$/.test(raw)) return Math.max(1, Number.parseInt(raw, 10))
	const at = Date.parse(raw)
	if (Number.isNaN(at)) return null
	return Math.max(1, Math.ceil((at - now) / 1000))
}

export function loyaltyErrorFromResponse(
	status: number,
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
	now: number = Date.now(),
): LoyaltyClientError {
	return new LoyaltyClientError(
		loyaltyErrorCodeFrom(status, body),
		status,
		retryAfterFrom(body, headers, now),
	)
}

/** True when repeating the same request with the same key may succeed. */
export function isRetryableLoyaltyError(error: unknown): boolean {
	if (!(error instanceof LoyaltyClientError)) return true
	return (
		error.code === 'network' ||
		error.code === 'rate_limited' ||
		error.code === 'loyalty_unavailable' ||
		error.status >= 500
	)
}

/** `crypto.randomUUID` where the runtime has it (tests, web), else the native module. */
export function defaultNewKey(): string {
	const native = globalThis.crypto
	if (native && typeof native.randomUUID === 'function')
		return native.randomUUID()
	return randomUUID()
}

/**
 * One `Idempotency-Key` per user intent. Retrying the same intent after a
 * network failure, a 5xx or a 429 sends the same key, so the region replays
 * the first result instead of acting twice; a definitive answer (success or
 * a refusal) forgets the key so the next intent gets a fresh one.
 */
export function createAttemptKeys(newKey: () => string = defaultNewKey) {
	const keys = new Map<string, string>()
	return {
		key(intent: string): string {
			let key = keys.get(intent)
			if (!key) {
				key = newKey()
				keys.set(intent, key)
			}
			return key
		},
		/** Call with the error on failure, without one on success. */
		settle(intent: string, error?: unknown): void {
			if (error !== undefined && isRetryableLoyaltyError(error)) return
			keys.delete(intent)
		},
		clear(): void {
			keys.clear()
		},
	}
}

export type AttemptKeys = ReturnType<typeof createAttemptKeys>

/**
 * When to treat a member code as expired on this device. The answer carries
 * only the server's `expiresAt`, so a device clock that runs fast or slow
 * would show a wrong countdown; the deadline is never later than one TTL
 * after the code arrived, and never already past on arrival.
 */
export function memberCodeDeadline(
	expiresAt: number,
	receivedAt: number,
	ttlMs: number,
): number {
	const remaining = expiresAt - receivedAt
	if (!Number.isFinite(remaining) || remaining <= 0 || remaining > ttlMs) {
		return receivedAt + ttlMs
	}
	return expiresAt
}

/** The `X-Client` value; tenant-api records channel `native` for both. */
export type LoyaltyClientPlatform = 'ios' | 'android'

export type LoyaltyDecision = 'approve' | 'decline'

export type LoyaltyClientOptions = {
	platform: LoyaltyClientPlatform
	transport?: HttpTransport
	newKey?: () => string
}

type Query = Record<string, string | number | null | undefined>

type Call<Schema extends z.ZodTypeAny> = {
	method: HttpMethod
	path: string
	schema: Schema
	/** Where tenant-api reads the slug or host hint for this route. */
	binding: 'query' | 'body'
	query?: Query
	body?: Record<string, unknown>
	idempotencyKey?: string
}

/**
 * Carries a loyalty failure through `CustomerSession.authorized`, which only
 * refreshes and retries for an `ApiError` 401.
 */
class LoyaltyRequestFailure extends ApiError {
	readonly failure: LoyaltyClientError

	constructor(failure: LoyaltyClientError) {
		super(failure.status, failure.code, failure.code)
		this.failure = failure
	}
}

/**
 * Typed client for the customer `/loyalty/*` routes of the regional
 * tenant-api, called straight from the app with the customer token (nothing
 * is proxied through the control plane). tenant-api resolves the organization
 * from the site `Origin` plus the slug or host hint, never from an id this
 * client sends, and refuses a token of another organization with
 * `organization_mismatch`. Nothing here logs tokens or response bodies.
 */
export class LoyaltyClient {
	readonly platform: LoyaltyClientPlatform
	readonly #session: CustomerSession
	readonly #transport: HttpTransport
	readonly #newKey: () => string

	constructor(session: CustomerSession, options: LoyaltyClientOptions) {
		this.#session = session
		this.platform = options.platform
		this.#transport = options.transport ?? session.client.transport
		this.#newKey = options.newKey ?? defaultNewKey
	}

	get isSignedIn(): boolean {
		return this.#session.isSignedIn
	}

	/** The public program and its rewards; `null` while loyalty is off. Needs no sign-in. */
	async program(): Promise<LoyaltyPublicProgram | null> {
		const call = {
			method: 'GET',
			path: '/loyalty/program',
			schema: loyaltyProgramResponseSchema,
			binding: 'query',
		} as const
		try {
			const data = await this.#send(call, null)
			return data.program
		} catch (error) {
			throw this.#failure(error)
		}
	}

	/**
	 * Program, account and balance; `null` while loyalty is off. The read opens
	 * the customer's points account the first time, so there is nothing to join.
	 */
	async wallet(): Promise<LoyaltyWallet | null> {
		const data = await this.#member({
			method: 'GET',
			path: '/loyalty/wallet',
			schema: loyaltyWalletResponseSchema,
			binding: 'query',
		})
		return data.wallet
	}

	/** One page of the member's history, newest first. */
	history(
		params: { cursor?: string | null; limit?: number } = {},
	): Promise<{ entries: LoyaltyHistoryEntry[]; nextCursor: string | null }> {
		return this.#member({
			method: 'GET',
			path: '/loyalty/history',
			schema: loyaltyHistoryResponseSchema,
			binding: 'query',
			query: { cursor: params.cursor, limit: params.limit },
		})
	}

	/**
	 * A short-lived code that identifies the member at the till. It never
	 * authorizes spending; a new one replaces the previous one.
	 */
	memberCode(): Promise<{ code: string; expiresAt: number }> {
		return this.#member({
			method: 'POST',
			path: '/loyalty/member-code',
			schema: loyaltyMemberCodeResponseSchema,
			binding: 'query',
			body: {},
		})
	}

	/** Till requests to spend points, waiting on this member. */
	async approvals(): Promise<LoyaltyCustomerApproval[]> {
		const data = await this.#member({
			method: 'GET',
			path: '/loyalty/approvals',
			schema: loyaltyApprovalsResponseSchema,
			binding: 'query',
		})
		return data.approvals
	}

	async decideApproval(
		approvalId: string,
		decision: LoyaltyDecision,
		key: string = this.#newKey(),
	): Promise<LoyaltyCustomerApproval> {
		const data = await this.#member({
			method: 'POST',
			path: `/loyalty/approvals/${encodeURIComponent(approvalId)}/decide`,
			schema: loyaltyApprovalResponseSchema,
			binding: 'body',
			body: { decision },
			idempotencyKey: key,
		})
		return data.approval
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
		for (const [name, value] of Object.entries(call.query ?? {})) {
			if (value === null || value === undefined || value === '') continue
			query.push([name, String(value)])
		}
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'X-Client': this.platform,
		}
		if (accessToken) headers.Authorization = `Bearer ${accessToken}`
		const origin = authOriginHeader(address)
		if (origin) headers.Origin = origin
		if (call.idempotencyKey) headers['Idempotency-Key'] = call.idempotencyKey
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
			(status, text, answer) =>
				new LoyaltyRequestFailure(
					loyaltyErrorFromResponse(status, parseJson(text), answer.headers),
				),
		)
		const parsed = call.schema.safeParse(parseJson(response.body))
		if (!parsed.success)
			throw new LoyaltyClientError('invalid_response', response.status)
		return parsed.data as z.output<Schema>
	}

	#failure(error: unknown): LoyaltyClientError {
		if (error instanceof LoyaltyRequestFailure) return error.failure
		if (error instanceof LoyaltyClientError) return error
		if (error instanceof ApiError) {
			if (error.code === 'region_unavailable') {
				return new LoyaltyClientError('organization_not_found', 0)
			}
			if (error.isTransportFailure) return new LoyaltyClientError('network', 0)
			// Anything else came from the session: no token, or a refresh that
			// was refused (the session is gone) or failed for now (it is kept).
			if (error.endsSession || !this.#session.isSignedIn) {
				return new LoyaltyClientError('signed_out', 401)
			}
			return new LoyaltyClientError('network', 0)
		}
		return new LoyaltyClientError('unknown', 0)
	}
}
