import {
	DISCOUNT_REFUSAL_REASONS,
	discountCodeInputSchema,
	discountQuoteSchema,
	type DiscountQuote,
	type DiscountRefusalReason,
	type OrderDiscountsRequest,
} from '@repo/discounts'

/**
 * Keeps the checkout totals in step with the region's discount quote
 * (`POST {tenantApi}/orders/quote`). Every change to what the order covers (or
 * to the typed coupon code) re-prices it at the region; the page shows the
 * region's amounts and sends `expectedDiscountMinor` only from a quote that
 * matches the order on screen. The browser never sends a price: the amount is
 * only compared by the region.
 *
 * A 404 or a `discounts_disabled` answer means the feature is off for this
 * organization: the quote then stays `off` for the page view and checkout
 * works as it did before discounts existed.
 */

export type { DiscountQuote }

export type DiscountQuoteState =
	/** Nothing to price yet (empty cart, no pickup time, no delivery address). */
	| { status: 'idle' }
	/** A quote is on its way; `last` is the previous one, which may be stale. */
	| { status: 'loading'; last: DiscountQuote | null }
	/** The region priced exactly the order and code on screen. */
	| { status: 'ready'; quote: DiscountQuote }
	/** The region could not be asked or refused the order; show the estimate. */
	| { status: 'error'; code: string; last: DiscountQuote | null }
	/** Discounts are not available: behave as before the feature. */
	| { status: 'off' }

/** What the transport answers: the HTTP status and the parsed JSON body. */
export type QuoteTransportResult = { status: number; body: unknown }

export type QuoteTransport = (
	body: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<QuoteTransportResult>

export type DiscountQuoteDeps = {
	post: QuoteTransport
	/** The order as it would be placed now; null while it cannot be priced. */
	pricingPayload: () => Record<string, unknown> | null
	/** The code to send with the quote, as the customer typed it. */
	code: () => string | null
	/** The state changed; re-render the totals. */
	onChange: () => void
	debounceMs?: number
	/** One request gives up after this long. */
	timeoutMs?: number
	/** Waits between retries after a transient failure; the count caps them. */
	retryDelays?: number[]
	/** How long placing waits for a quote on its way. */
	placementWaitMs?: number
}

export const DISCOUNT_QUOTE_DEBOUNCE_MS = 250
export const DISCOUNT_QUOTE_TIMEOUT_MS = 10_000
export const DISCOUNT_PLACEMENT_WAIT_MS = 8_000

export type DiscountPlacement =
	/** `discounts: null` sends nothing (the feature is off). */
	{ ok: true; discounts: OrderDiscountsRequest | null } | { ok: false }

export type DiscountQuotes = {
	/** Re-prices when what the order covers changed; cheap on every render. */
	sync(): void
	/** Re-prices now, even for the same order (a code was applied or removed). */
	refresh(): void
	state(): DiscountQuoteState
	/** The quote for the order and code on screen now, or null. */
	freshQuote(): DiscountQuote | null
	/** The last quote the region sent, even when the order changed since. */
	lastQuote(): DiscountQuote | null
	/**
	 * Takes a quote the region sent with a refusal (`discount_changed`) as the
	 * answer for the order and code on screen now.
	 */
	adopt(quote: DiscountQuote): void
	/** Resolves once no quote is pending. */
	settled(): Promise<void>
	/**
	 * What to send with the order. Waits a few seconds at most for a quote on
	 * its way; `ok: false` when none confirms the order on screen, so the page
	 * never places a price the customer was not shown.
	 */
	placement(): Promise<DiscountPlacement>
	/**
	 * Treats discounts as off for the rest of the page view (the region said so
	 * when placing): no more quotes, nothing sent with the order.
	 */
	disable(): void
	/** Stops for good. */
	close(): void
}

/** Whether a failed answer means the feature is not available at all. */
function featureOff(result: QuoteTransportResult): boolean {
	if (result.status === 404) return true
	const code = errorCode(result.body)
	return code === 'discounts_disabled'
}

export function errorCode(body: unknown): string | null {
	return body &&
		typeof body === 'object' &&
		'error' in body &&
		typeof body.error === 'string'
		? body.error
		: null
}

/** The `Retry-After`-style wait a busy region asks for, in milliseconds. */
function retryAfterMs(body: unknown): number {
	if (!body || typeof body !== 'object') return 0
	const seconds = (body as Record<string, unknown>).retryAfterSeconds
	return typeof seconds === 'number' && seconds > 0
		? Math.min(seconds * 1000, 30_000)
		: 0
}

export function createDiscountQuotes(deps: DiscountQuoteDeps): DiscountQuotes {
	const debounceMs = deps.debounceMs ?? DISCOUNT_QUOTE_DEBOUNCE_MS
	const timeoutMs = deps.timeoutMs ?? DISCOUNT_QUOTE_TIMEOUT_MS
	const retryDelays = deps.retryDelays ?? [1_000, 3_000]
	const placementWaitMs = deps.placementWaitMs ?? DISCOUNT_PLACEMENT_WAIT_MS

	let current: DiscountQuoteState = { status: 'idle' }
	let quote: DiscountQuote | null = null
	let quotedKey: string | null = null
	let requestedKey: string | null | undefined
	let seq = 0
	let retries = 0
	let off = false
	let closed = false
	let timer: ReturnType<typeof setTimeout> | null = null
	let inFlightId: number | null = null
	let inFlight: AbortController | null = null
	let waiters: Array<() => void> = []

	/** The order and code a quote prices, as one stable string. */
	function key(): string | null {
		const payload = deps.pricingPayload()
		if (!payload) return null
		return JSON.stringify([payload, deps.code() ?? null])
	}

	const busy = () => timer !== null || inFlightId === seq

	function set(next: DiscountQuoteState) {
		current = next
		deps.onChange()
	}

	function release() {
		if (busy()) return
		const list = waiters
		waiters = []
		for (const resolve of list) resolve()
	}

	function cancelInFlight() {
		inFlight?.abort()
		inFlight = null
	}

	function turnOff() {
		off = true
		seq += 1
		cancelInFlight()
		if (timer) clearTimeout(timer)
		timer = null
		quote = null
		quotedKey = null
		set({ status: 'off' })
		release()
	}

	function schedule(delay: number) {
		if (off || closed) return
		requestedKey = key()
		// A newer request owns the state; answers to older ones are dropped.
		seq += 1
		const id = seq
		cancelInFlight()
		if (timer) clearTimeout(timer)
		if (requestedKey === null) {
			timer = null
			quote = null
			quotedKey = null
			set({ status: 'idle' })
			release()
			return
		}
		// Never show a stale total as final: mark it as on its way at once.
		set({ status: 'loading', last: quote })
		timer = setTimeout(() => {
			timer = null
			void run(id)
		}, delay)
	}

	async function run(id: number) {
		if (off || closed || id !== seq) return
		const requested = key()
		if (requested === null) {
			quote = null
			quotedKey = null
			set({ status: 'idle' })
			release()
			return
		}
		const payload = deps.pricingPayload()
		if (!payload) return
		const code = deps.code()
		inFlightId = id
		const controller = new AbortController()
		inFlight = controller
		const timeout = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const result = await deps.post(
				{ ...payload, discounts: code ? { code } : {} },
				controller.signal,
			)
			if (id !== seq || off || closed) return
			if (result.status >= 200 && result.status < 300) {
				const parsed = discountQuoteSchema.safeParse(result.body)
				if (!parsed.success) {
					fail('invalid_response', id, true)
					return
				}
				quote = parsed.data
				quotedKey = requested
				retries = 0
				set({ status: 'ready', quote })
				return
			}
			if (featureOff(result)) {
				turnOff()
				return
			}
			const failure = errorCode(result.body) ?? 'quote_failed'
			// A refusal of the order itself will not change on a retry; a busy
			// or failing region might.
			const transient = result.status === 429 || result.status >= 500
			if (!transient) {
				fail(failure, id, false)
				return
			}
			fail(failure, id, true, retryAfterMs(result.body))
		} catch {
			if (id !== seq || off || closed) return
			fail('network', id, true)
		} finally {
			clearTimeout(timeout)
			if (inFlight === controller) inFlight = null
			if (inFlightId === id) inFlightId = null
			release()
		}
	}

	function fail(code: string, id: number, retry: boolean, waitMs = 0) {
		if (retry && retries < retryDelays.length) {
			const delay = Math.max(retryDelays[retries]!, waitMs)
			retries += 1
			// Keep the loading state: the last quote stays marked as stale.
			timer = setTimeout(() => {
				timer = null
				void run(id)
			}, delay)
			return
		}
		retries = 0
		set({ status: 'error', code, last: quote })
	}

	function freshQuote(): DiscountQuote | null {
		if (off || closed || !quote) return null
		if (quotedKey !== key()) return null
		return quote
	}

	function settledWithin(ms: number): Promise<void> {
		if (!busy()) return Promise.resolve()
		return new Promise((resolve) => {
			const timeout = setTimeout(resolve, ms)
			waiters.push(() => {
				clearTimeout(timeout)
				resolve()
			})
		})
	}

	return {
		sync() {
			if (off || closed) return
			const next = key()
			if (next === requestedKey) return
			schedule(requestedKey === undefined ? 0 : debounceMs)
		},

		refresh() {
			if (off || closed) return
			retries = 0
			schedule(0)
		},

		state: () => current,

		freshQuote,

		lastQuote: () => (off ? null : quote),

		adopt(next) {
			if (off || closed) return
			seq += 1
			cancelInFlight()
			if (timer) clearTimeout(timer)
			timer = null
			requestedKey = key()
			quote = next
			quotedKey = requestedKey
			retries = 0
			set({ status: 'ready', quote: next })
			release()
		},

		settled() {
			if (!busy()) return Promise.resolve()
			return new Promise((resolve) => {
				waiters.push(resolve)
			})
		},

		async placement() {
			if (off || closed) return { ok: true, discounts: null }
			// Not priceable: placing is blocked elsewhere, send nothing.
			if (key() === null) return { ok: true, discounts: null }
			if (!busy() && !freshQuote()) schedule(0)
			await settledWithin(placementWaitMs)
			// The feature may have turned out to be off while waiting.
			if (off) return { ok: true, discounts: null }
			const fresh = freshQuote()
			if (!fresh) {
				// The region could not be asked. With no code typed and no
				// discount ever shown, the customer saw the undiscounted price:
				// place it as shown instead of locking checkout on an outage.
				const unreachable =
					current.status === 'error' &&
					!deps.code() &&
					(current.last?.totalDiscountMinor ?? 0) === 0
				return unreachable ? { ok: true, discounts: null } : { ok: false }
			}
			return { ok: true, discounts: placementDiscounts(fresh, deps.code()) }
		},

		disable: turnOff,

		close() {
			closed = true
			seq += 1
			cancelInFlight()
			if (timer) clearTimeout(timer)
			timer = null
			release()
		},
	}
}

/**
 * The `discounts` field of the order: the typed code only while the quote
 * says it applies (a refused or replaced code would only be refused again),
 * and the total discount the customer was shown.
 */
export function placementDiscounts(
	quote: DiscountQuote,
	code: string | null,
): OrderDiscountsRequest {
	return {
		...(code && quote.coupon?.status === 'applied' ? { code } : {}),
		expectedDiscountMinor: quote.totalDiscountMinor,
	}
}

// ---------- typed code ----------

/** What the customer typed, trimmed and with runs of spaces collapsed. */
export function cleanTypedCode(raw: string): string {
	return raw.trim().replace(/\s+/g, ' ')
}

/** A code the region could ever accept; anything else is "not valid" at once. */
export function isPlausibleCode(code: string): boolean {
	return discountCodeInputSchema.safeParse(code).success
}

const codeKey = (orgId: string) => `menuza_coupon_${orgId}`

export function loadStoredCode(
	storage: Pick<Storage, 'getItem'>,
	orgId: string,
): string | null {
	try {
		const raw = storage.getItem(codeKey(orgId))
		if (!raw) return null
		const code = cleanTypedCode(raw)
		return isPlausibleCode(code) ? code : null
	} catch {
		return null
	}
}

export function saveStoredCode(
	storage: Pick<Storage, 'setItem' | 'removeItem'>,
	orgId: string,
	code: string | null,
): void {
	try {
		if (code) storage.setItem(codeKey(orgId), code)
		else storage.removeItem(codeKey(orgId))
	} catch {
		// Storage unavailable: the code simply is not remembered.
	}
}

/**
 * A printed coupon's QR opens `/menu?coupon=CODE`. A plausible code is kept
 * like a typed one, so the cart prices it and checkout carries it. Anything
 * that could never be a code is ignored, and an existing stored code is
 * replaced only by a different, valid one. Returns the adopted code.
 */
export function adoptCouponFromUrl(
	storage: Pick<Storage, 'setItem' | 'removeItem'>,
	orgId: string,
	search: string,
): string | null {
	const raw = new URLSearchParams(search).get('coupon')
	if (!raw || raw.length > 60) return null
	const code = cleanTypedCode(raw)
	if (!isPlausibleCode(code)) return null
	saveStoredCode(storage, orgId, code)
	return code
}

// ---------- refusals ----------

/**
 * Refusals a retry or a cart change cannot fix: the code stops being sent
 * (so it does not count as another attempt) and the message stays until the
 * customer edits or removes it. The rest (a minimum spend, a missing item, a
 * fulfillment mode) can change with the cart, so the code is kept and priced
 * again with it.
 */
const TERMINAL_REFUSALS = new Set<DiscountRefusalReason>([
	'not_found',
	'expired',
	'limit_reached',
	'wrong_channel',
	'wrong_drop',
	'new_customers_only',
	'members_only',
])

export function isTerminalRefusal(reason: DiscountRefusalReason): boolean {
	return TERMINAL_REFUSALS.has(reason)
}

export function asRefusalReason(value: unknown): DiscountRefusalReason | null {
	return typeof value === 'string' &&
		(DISCOUNT_REFUSAL_REASONS as readonly string[]).includes(value)
		? (value as DiscountRefusalReason)
		: null
}

/** What a 409 from `POST /orders` says about discounts. */
export type DiscountOrderRefusal =
	| { kind: 'changed'; quote: DiscountQuote | null }
	| { kind: 'refused'; reason: DiscountRefusalReason | null }
	| { kind: 'disabled' }
	| { kind: 'on_tab' }

/**
 * Reads the discount refusal of a failed order. The fresh quote may sit in
 * `body.quote` or be the body itself; the reason in `body.reason` or
 * `body.coupon.reason`. Anything unreadable stays `null` and the caller
 * prices again.
 */
export function parseDiscountOrderRefusal(
	code: string,
	body: unknown,
): DiscountOrderRefusal | null {
	const record =
		body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
	if (code === 'discount_changed') {
		for (const candidate of [record.quote, record]) {
			const parsed = discountQuoteSchema.safeParse(candidate)
			if (parsed.success) return { kind: 'changed', quote: parsed.data }
		}
		return { kind: 'changed', quote: null }
	}
	if (code === 'coupon_refused') {
		const coupon =
			record.coupon && typeof record.coupon === 'object'
				? (record.coupon as Record<string, unknown>)
				: {}
		return {
			kind: 'refused',
			reason: asRefusalReason(record.reason) ?? asRefusalReason(coupon.reason),
		}
	}
	if (code === 'discounts_disabled') return { kind: 'disabled' }
	if (code === 'discounts_on_tab') return { kind: 'on_tab' }
	return null
}
