import {
	isLoyaltyErrorCode,
	loyaltyApprovalResponseSchema,
	loyaltyApprovalsResponseSchema,
	loyaltyCheckoutQuoteResponseSchema,
	loyaltyHistoryResponseSchema,
	loyaltyMemberCodeResponseSchema,
	loyaltyProgramResponseSchema,
	loyaltyWalletResponseSchema,
	type LoyaltyCheckoutQuote,
	type LoyaltyCustomerApproval,
	type LoyaltyErrorCode,
	type LoyaltyHistoryEntry,
	type LoyaltyOrderReward,
	type LoyaltyPublicProgram,
	type LoyaltyWallet,
} from '@repo/loyalty'
import {
	clearSessionTokens,
	getBrowserTenantApiUrl,
	getOrgBinding,
	tenantFetchResponse,
} from '~/lib/client-auth'
import { randomUuid } from '~/lib/reservations/uuid'

/**
 * Browser-only client for the customer `/loyalty/*` routes of the regional
 * tenant-api. Every call goes straight from the visitor's browser to the
 * region with the customer token from `localStorage`; Sites SSR never calls
 * these routes (see `loyalty-residency.test.ts`). The organization is resolved
 * by tenant-api from the page `Origin` plus the slug or host hint, never from
 * an id this module sends. Nothing here logs tokens or response bodies.
 */

export type {
	LoyaltyCheckoutQuote,
	LoyaltyCustomerApproval,
	LoyaltyHistoryEntry,
	LoyaltyOrderReward,
	LoyaltyPublicProgram,
	LoyaltyWallet,
}

/** Codes the client adds to the server's loyalty codes. */
export type LoyaltyClientOnlyCode =
	/**
	 * No customer token, the region refused it and refreshing was refused
	 * too, or the organization is no longer active. A session that could not
	 * be checked for now reports 'network' instead.
	 */
	| 'signed_out'
	/** The token belongs to another organization than this site. */
	| 'organization_mismatch'
	/** The region does not serve this site (unknown, unprovisioned, other region). */
	| 'organization_not_found'
	/** The request never got an answer (offline, DNS, CORS). */
	| 'network'
	/** The answer did not match the published contract. */
	| 'invalid_response'
	/** Ordering or the tab cannot take this right now; try again. */
	| 'order_unavailable'
	/** The order or tab itself was refused (closed tab, missing contact). */
	| 'order_refused'
	| 'unknown'

export type LoyaltyClientErrorCode = LoyaltyErrorCode | LoyaltyClientOnlyCode

export class LoyaltyClientError extends Error {
	readonly code: LoyaltyClientErrorCode
	readonly status: number
	/** From a 429 answer; `null` otherwise. */
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

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {}
}

/**
 * Order-route refusals a quote can answer with (the cart or the tab, not
 * loyalty). Mapped one by one: a status fallback would read a missing tab
 * (404) as a site without rewards, and ordering being down (503) as loyalty
 * being off.
 */
const ORDER_ERROR_CODES: Readonly<Record<string, LoyaltyClientErrorCode>> = {
	ordering_unavailable: 'order_unavailable',
	dine_in_unavailable: 'order_unavailable',
	tab_paying: 'order_unavailable',
	tab_locked: 'order_unavailable',
	table_rate_limited: 'rate_limited',
	rate_limit_exceeded: 'rate_limited',
	invalid_request: 'invalid_request',
	tab_not_found: 'order_refused',
	tab_closed: 'order_refused',
	tab_conflict: 'order_refused',
	tab_settlement_required: 'order_refused',
	loyalty_on_tab: 'order_refused',
	contact_name_required: 'order_refused',
	contact_phone_required: 'order_refused',
	delivery_quote_expired: 'order_refused',
	hold_expired: 'order_refused',
	online_payment_disabled: 'order_refused',
	order_not_found: 'order_refused',
	amount_mismatch: 'order_refused',
	session_conflict: 'order_refused',
	session_mismatch: 'order_refused',
}

/**
 * Maps a failed answer to one typed code. Loyalty routes send
 * `{ error, code }` with a stable code, and quotes pass order codes through;
 * the shared auth and organization guards in front of them answer plain
 * `{ error }` bodies with English text, so those fall back to the status.
 */
export function loyaltyErrorCodeFrom(
	status: number,
	body: unknown,
): LoyaltyClientErrorCode {
	const record = asRecord(body)
	for (const value of [record.code, record.error]) {
		if (isLoyaltyErrorCode(value)) return value
		if (value === 'organization_mismatch') return 'organization_mismatch'
		if (typeof value === 'string' && Object.hasOwn(ORDER_ERROR_CODES, value)) {
			return ORDER_ERROR_CODES[value]!
		}
	}
	if (status === 401) return 'signed_out'
	if (status === 403 && record.code === 'organization_inactive') {
		return 'signed_out'
	}
	if (status === 429) return 'rate_limited'
	// A code this client does not know yet says nothing about the site.
	if (typeof record.code === 'string') return 'unknown'
	if (status === 404) return 'organization_not_found'
	if (status === 503) return 'loyalty_unavailable'
	if (status === 400 || status === 422) return 'invalid_request'
	return 'unknown'
}
export function loyaltyErrorFromResponse(
	status: number,
	body: unknown,
): LoyaltyClientError {
	const retry = asRecord(body).retryAfterSeconds
	return new LoyaltyClientError(
		loyaltyErrorCodeFrom(status, body),
		status,
		typeof retry === 'number' && Number.isFinite(retry)
			? Math.max(1, Math.ceil(retry))
			: null,
	)
}

/** True when repeating the same request with the same key may succeed. */
export function isRetryableLoyaltyError(error: unknown): boolean {
	if (!(error instanceof LoyaltyClientError)) return true
	return (
		error.code === 'network' ||
		error.code === 'rate_limited' ||
		error.code === 'loyalty_unavailable' ||
		error.code === 'order_unavailable' ||
		error.status >= 500
	)
}

/**
 * One `Idempotency-Key` per user intent. Retrying the same intent after a
 * network failure, a 5xx or a 429 sends the same key, so the region replays
 * the first result instead of acting twice; a definitive answer (success or
 * a refusal) forgets the key so the next intent gets a fresh one.
 */
export function createAttemptKeys(newKey: () => string = randomUuid) {
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
	}
}

export type AttemptKeys = ReturnType<typeof createAttemptKeys>

export type LoyaltyClientDeps = {
	/** Regional tenant-api origin. Defaults to the page's `data-tenant-api-url`. */
	baseUrl?: () => string
	/** Anonymous fetch, used for the public program only. */
	fetchImpl?: typeof fetch
	/**
	 * Sends the customer token and refreshes it once on a 401. Rejects (and
	 * so fails as 'network') when the session cannot be checked for now.
	 */
	authedFetch?: (path: string, init: RequestInit) => Promise<Response>
	/** Forgets a customer session the region refuses for good. */
	clearSession?: () => void
	/** Slug or custom-host hint for the region's organization lookup. */
	binding?: () => { slug?: string; host?: string }
	newKey?: () => string
	/** A request that never answers fails as 'network' after this. */
	timeoutMs?: number
}

export type LoyaltyDecision = 'approve' | 'decline'

/** The structural part of a Zod schema this module relies on. */
type Parser<T> = {
	safeParse(
		value: unknown,
	): { success: true; data: T } | { success: false; error?: unknown }
}

/** A request's own deadline, plus the caller's cancel when it has one. */
function withDeadline(
	deadline: AbortSignal,
	cancel: AbortSignal | undefined,
): AbortSignal {
	if (!cancel) return deadline
	if (typeof AbortSignal.any === 'function') {
		return AbortSignal.any([deadline, cancel])
	}
	const controller = new AbortController()
	const abort = () => controller.abort()
	for (const signal of [deadline, cancel]) {
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
	}
	return controller.signal
}

function withQuery(
	path: string,
	params: Record<string, string | number | null | undefined>,
): string {
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value !== null && value !== undefined && value !== '')
			search.set(key, String(value))
	}
	const text = search.toString()
	return text ? `${path}?${text}` : path
}

export function createLoyaltyClient(deps: LoyaltyClientDeps = {}) {
	const baseUrl = () =>
		(deps.baseUrl ?? getBrowserTenantApiUrl)().replace(/\/$/, '')
	const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
	const authedFetch = deps.authedFetch ?? tenantFetchResponse
	const clearSession = deps.clearSession ?? clearSessionTokens
	const binding = deps.binding ?? getOrgBinding
	const newKey = deps.newKey ?? randomUuid
	const timeoutMs = deps.timeoutMs ?? 15_000

	function request(
		method: 'GET' | 'POST',
		body?: unknown,
		key?: string,
		cancel?: AbortSignal,
	): RequestInit {
		const headers = new Headers({ 'X-Client': 'web' })
		if (body !== undefined) headers.set('Content-Type', 'application/json')
		if (key) headers.set('Idempotency-Key', key)
		return {
			method,
			headers,
			cache: 'no-store',
			// A hung answer (a black-holed connection) rejects as 'network',
			// so a stuck request cannot wedge a checkout or a payment.
			signal: withDeadline(AbortSignal.timeout(timeoutMs), cancel),
			body: body === undefined ? undefined : JSON.stringify(body),
		}
	}

	async function send<T>(
		run: () => Promise<Response>,
		parser: Parser<T>,
	): Promise<T> {
		let res: Response
		let timer: ReturnType<typeof setTimeout> | null = null
		try {
			// The race bounds the wait even where the signal is ignored.
			res = await Promise.race([
				run(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
				}),
			])
		} catch {
			throw new LoyaltyClientError('network', 0)
		} finally {
			if (timer) clearTimeout(timer)
		}
		const data: unknown = await res.json().catch(() => null)
		if (!res.ok) throw loyaltyErrorFromResponse(res.status, data)
		const parsed = parser.safeParse(data)
		if (!parsed.success)
			throw new LoyaltyClientError('invalid_response', res.status)
		return parsed.data
	}

	/**
	 * A member call. A session the region refuses for good, or one tied to
	 * another organization, is forgotten here, so no page keeps sending it. A
	 * refresh that failed for now arrives as 'network' and keeps the session.
	 */
	async function authed<T>(
		path: string,
		init: RequestInit,
		parser: Parser<T>,
	): Promise<T> {
		try {
			return await send(() => authedFetch(path, init), parser)
		} catch (error) {
			if (
				error instanceof LoyaltyClientError &&
				(error.code === 'signed_out' || error.code === 'organization_mismatch')
			) {
				clearSession()
			}
			throw error
		}
	}

	return {
		/** The public program and its rewards; `null` while loyalty is off. */
		async program(): Promise<LoyaltyPublicProgram | null> {
			const path = withQuery('/loyalty/program', binding())
			const data = await send(
				() => fetchImpl(`${baseUrl()}${path}`, request('GET')),
				loyaltyProgramResponseSchema,
			)
			return data.program
		},

		/**
		 * Program, account and balance; `null` while loyalty is off. The read
		 * itself opens a signed-in customer's points account.
		 */
		async wallet(): Promise<LoyaltyWallet | null> {
			const data = await authed(
				withQuery('/loyalty/wallet', binding()),
				request('GET'),
				loyaltyWalletResponseSchema,
			)
			return data.wallet
		},

		/** One page of the member's history, newest first. */
		history(
			params: { cursor?: string | null; limit?: number } = {},
		): Promise<{ entries: LoyaltyHistoryEntry[]; nextCursor: string | null }> {
			return authed(
				withQuery('/loyalty/history', {
					...binding(),
					cursor: params.cursor,
					limit: params.limit,
				}),
				request('GET'),
				loyaltyHistoryResponseSchema,
			)
		},

		/**
		 * A short-lived code that identifies the member at the till. It never
		 * authorizes spending; a new one replaces the previous one.
		 */
		memberCode(): Promise<{ code: string; expiresAt: number }> {
			return authed(
				withQuery('/loyalty/member-code', binding()),
				request('POST', {}),
				loyaltyMemberCodeResponseSchema,
			)
		},

		/** Till requests to spend points, waiting on this member. */
		async approvals(): Promise<LoyaltyCustomerApproval[]> {
			const data = await authed(
				withQuery('/loyalty/approvals', binding()),
				request('GET'),
				loyaltyApprovalsResponseSchema,
			)
			return data.approvals
		},

		/**
		 * Prices the cart with every program reward and returns the totals with
		 * the picked one (`selection: null` for the plain totals). The order is
		 * the placement body without contact or idempotency key. A read: it
		 * holds no points.
		 */
		checkoutQuote(input: {
			order: unknown
			selection: LoyaltyOrderReward | null
			/** Cancels a quote nobody waits for any more. */
			signal?: AbortSignal
		}): Promise<LoyaltyCheckoutQuote> {
			return authed(
				'/loyalty/checkout/quote',
				request(
					'POST',
					{
						order: input.order,
						selection: input.selection,
						...binding(),
					},
					undefined,
					input.signal,
				),
				loyaltyCheckoutQuoteResponseSchema,
			)
		},

		/**
		 * The same quote for an open table tab: every reward priced on the
		 * tab's rounds plus the picked tip. The tab code rides in
		 * `X-Tab-Token`, like every other tab call. `already_claimed` means
		 * another member claimed the tab's reward.
		 */
		tabQuote(input: {
			tabToken: string
			tipPercent: number
			selection: LoyaltyOrderReward | null
			/** Cancels a quote nobody waits for any more. */
			signal?: AbortSignal
		}): Promise<LoyaltyCheckoutQuote> {
			const init = request(
				'POST',
				{
					tipPercent: input.tipPercent,
					selection: input.selection,
					...binding(),
				},
				undefined,
				input.signal,
			)
			;(init.headers as Headers).set('X-Tab-Token', input.tabToken)
			return authed(
				'/loyalty/tab/quote',
				init,
				loyaltyCheckoutQuoteResponseSchema,
			)
		},

		async decideApproval(
			approvalId: string,
			decision: LoyaltyDecision,
			key: string = newKey(),
		): Promise<LoyaltyCustomerApproval> {
			const data = await authed(
				`/loyalty/approvals/${encodeURIComponent(approvalId)}/decide`,
				request('POST', { decision, ...binding() }, key),
				loyaltyApprovalResponseSchema,
			)
			return data.approval
		},
	}
}

export type LoyaltyClient = ReturnType<typeof createLoyaltyClient>

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
