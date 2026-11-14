import { Hono, type Context } from 'hono'
import { ENV } from 'varlock/env'

import {
	QR_TAB_TOKEN_HEADER,
	QR_TABLE_TOKEN_HEADER,
	qrTabPayRequestSchema,
	readQrOrderingFeatures,
} from '@repo/common/qr-ordering'
import {
	RESTAURANT_TURNSTILE_ACTION,
	restaurantOrderDiscountQuoteSchema,
	restaurantOrderRequestSchema,
} from '@repo/common/restaurant-orders'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import { normalizeDiscountCode } from '@repo/discounts'
import { getTenantDb } from '@repo/tenant-db'
import crypto from 'node:crypto'
import { z } from 'zod'

import {
	addressBucket,
	clientAddress,
	isLocalRuntime,
} from '../lib/client-ip.ts'
import {
	chargeCouponGuess,
	enforceDiscountLimit,
	settleCouponGuess,
	type CouponGuessOutcome,
	type CouponGuessSubject,
} from '../lib/discount-rate-limit.ts'
import {
	resolveOrganizationForBrowserAuth,
	type PublishedOrganization,
} from '../lib/origin.ts'
import { countOrderResendAttempt } from '../lib/order-link-limits.ts'
import { isQrDineInDisabled } from '../lib/qr-tokens.ts'
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, syncEnvFromProcess } from '../lib/secrets.ts'
import { quoteOrderDiscounts } from '../services/discount-quote.ts'
import {
	authorizeGuestOrder,
	ORDER_LINK_HEADER,
	readOrderLinkHeader,
	resendReceiptInBackground,
	type GuestOrderCredentials,
} from '../services/order-link-access.ts'
import {
	buildOrderingOptionsWithContext,
	fetchOrderContext,
	getOrderReceipt,
	placeOrder,
	publicOrderSummary,
	receiptOrder,
	type OrderServiceFailure,
} from '../services/order-service.ts'
import type { DineInCapability } from '../services/qr-dine-in.ts'
import {
	getPublicTab,
	getTableContext,
	prepareTabPayment,
	withTabDiscounts,
} from '../services/qr-tab-service.ts'
import { authenticateCustomer } from './auth.ts'

export const publicOrderRoutes = new Hono()

const MAX_ORDER_BODY_BYTES = 200_000

function orderFailureResponse(failure: OrderServiceFailure) {
	return Response.json(
		{
			error: failure.code,
			message: failure.message,
			...(failure.reason ? { reason: failure.reason } : {}),
			...(failure.quote ? { quote: failure.quote } : {}),
			...(failure.details ? { details: failure.details } : {}),
		},
		{ status: failure.status, headers: { 'Cache-Control': 'no-store' } },
	)
}

function noStoreHeaders() {
	return { 'Cache-Control': 'no-store' }
}

/** Table and tab capabilities ride in headers (from the URL fragment). */
function dineInCapability(c: Context): DineInCapability | null {
	const tableToken = c.req.header(QR_TABLE_TOKEN_HEADER)?.trim() || null
	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim() || null
	return tableToken || tabToken ? { tableToken, tabToken } : null
}

function dineInUnavailable() {
	return Response.json(
		{ error: 'unavailable' },
		{ status: 503, headers: noStoreHeaders() },
	)
}

/**
 * The rate-limit bucket of the client's address, or null when the node has
 * none. `clientAddress` believes forwarding headers only from Cloudflare or a
 * proxy on our own network; an IPv6 client counts by its /64.
 */
function clientBucket(c: Context): string | null {
	const address = clientAddress(c)
	return address ? addressBucket(address) : null
}

/**
 * Who is guessing a coupon code. Never a value the client chooses (a session
 * id, the tail of a token): a fresh one on every request would be a fresh
 * budget every time.
 */
function couponSubject(
	c: Context,
	customerId: string | null | undefined,
): CouponGuessSubject {
	const address = clientBucket(c)
	if (customerId) return { kind: 'customer', customerId, address }
	return { kind: 'guest', address }
}

function couponLimitedResponse(retryAfterSeconds: number) {
	return Response.json(
		{
			error: 'rate_limit_exceeded',
			message: 'Too many coupon attempts. Please try again shortly.',
			retryAfterSeconds,
		},
		{
			status: 429,
			headers: {
				...noStoreHeaders(),
				'Retry-After': String(Math.max(1, retryAfterSeconds)),
			},
		},
	)
}

/**
 * What makes two coupon requests the same question: the code and the cart (or
 * the tab) it was tried on. The Sites page re-quotes on every cart change and
 * again when the order is placed; none of those repeats is a new guess.
 */
export function couponFingerprint(code: string, ...parts: unknown[]): string {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify([normalizeDiscountCode(code), ...parts]))
		.digest('hex')
}

/** Refusals the customer can fix by changing the cart (see `CouponGuessOutcome`). */
const FIXABLE_COUPON_REASONS = new Set(['minimum_not_met', 'quantity_not_met'])

/**
 * What a failed placement, quote or tab payment says about the typed code. A
 * code the cart does not meet yet is `fixable`. A valid code beaten by an
 * automatic discount (`replaced`) is `wrong`: it proves the code exists, so a
 * probe is never free. Any other failure says nothing about the code.
 */
export function couponOutcomeOfFailure(failure: {
	code: string
	reason?: string | undefined
}): CouponGuessOutcome {
	if (failure.code === 'coupon_refused') {
		return FIXABLE_COUPON_REASONS.has(failure.reason ?? '')
			? 'fixable'
			: 'wrong'
	}
	if (
		failure.code === 'discount_changed' &&
		failure.reason === 'replaced_by_better_discount'
	) {
		return 'wrong'
	}
	return 'none'
}

/** Whether a failure is a wrong guess (a fixable code is not). */
export function failureCountsAsCouponGuess(failure: {
	code: string
	reason?: string | undefined
}): boolean {
	return couponOutcomeOfFailure(failure) === 'wrong'
}

/** The same reading of the `coupon` field of a quote answer. */
export function couponOutcomeOfQuote(
	coupon: { status: string; reason?: string | undefined } | null | undefined,
): CouponGuessOutcome {
	if (!coupon) return 'none'
	if (coupon.status === 'applied') return 'applied'
	if (coupon.status === 'replaced') return 'wrong'
	if (coupon.status === 'refused') {
		return FIXABLE_COUPON_REASONS.has(coupon.reason ?? '') ? 'fixable' : 'wrong'
	}
	return 'none'
}

export type CouponGuard =
	| { blocked: Response }
	| {
			blocked: null
			/**
			 * Call once the answer is known (`settleCouponGuess`). A wrong code
			 * stays counted. A code the cart does not meet yet costs a guest one
			 * guess per code, given back when it applies. An applied code, or any
			 * other answer, gives the attempt back.
			 */
			settle: (outcome: CouponGuessOutcome) => Promise<void>
	  }

/** The organization's guest budget is spent: a guest signs in to use a code. */
function couponSignInResponse() {
	return Response.json(
		{
			error: 'coupon_refused',
			message: 'Sign in to use this code.',
			reason: 'sign_in_required',
		},
		{ status: 409, headers: noStoreHeaders() },
	)
}

/**
 * Counts a coupon attempt before the code is checked, for the address (and
 * the customer, when signed in) and, for a guest, the organization, so
 * parallel requests cannot all slip under a limit the way a read-then-charge
 * check lets them. No code, no count.
 *
 * Over the subject's own budget: 429. Over the organization's guest budget (a
 * flood of guesses from many addresses): the guest is asked to sign in, where
 * their own budget applies, so a flood cannot take codes away from everyone.
 * A guest with no address at all is refused outside local runs: production
 * always knows it (Cloudflare on the Worker, the socket on Node), and guests
 * without one would share a single bucket.
 */
export async function guardCouponGuess(
	orgId: string,
	c: Context,
	code: string | null | undefined,
	fingerprintParts: unknown[],
	customerId?: string | null,
): Promise<CouponGuard> {
	if (!code) return { blocked: null, settle: async () => {} }
	const subject = couponSubject(c, customerId)
	if (
		subject.kind === 'guest' &&
		subject.address === null &&
		!isLocalRuntime()
	) {
		return { blocked: couponLimitedResponse(60) }
	}
	const db = await getTenantDb(orgId)
	const result = await chargeCouponGuess(db, {
		orgId,
		subject,
		fingerprint: couponFingerprint(code, ...fingerprintParts),
	})
	if (!result.ok) {
		if (result.bucket === 'codeOrg') return { blocked: couponSignInResponse() }
		return { blocked: couponLimitedResponse(result.retryAfterSeconds) }
	}
	const normalizedCode = normalizeDiscountCode(code)
	return {
		blocked: null,
		settle: (outcome) =>
			settleCouponGuess(
				db,
				{ orgId, subject, normalizedCode },
				result.charge,
				outcome,
			),
	}
}

/**
 * `POST /orders` requires a Turnstile token whenever the node has a secret.
 * `optional` (tab payment) only checks a token that was sent: the phone's tab
 * code is an unguessable capability and coupon guesses have their own limits,
 * and no client sends a token on that flow, so requiring one would refuse every
 * tab payment on a node with a secret.
 */
async function verifyOrderTurnstile(
	c: Context,
	token: unknown,
	options: { optional?: boolean } = {},
) {
	syncEnvFromProcess()
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	if (!isTurnstileConfigured(secret)) return true
	if (typeof token !== 'string' || !token.trim())
		return options.optional === true
	const result = await verifyTurnstileToken({
		secret,
		token,
		remoteIp: clientAddress(c) ?? undefined,
		expectedAction: RESTAURANT_TURNSTILE_ACTION,
		expectedHostnames: parseTurnstileHostnames(ENV.TURNSTILE_HOSTNAMES),
	})
	return result.success
}

/**
 * Binds the request to the organization identified by the browser Origin plus
 * slug/host identity — the same rule auth uses. A client-chosen orgId is never
 * accepted, and the org must be served by this node's region.
 */
export async function resolveOrderingOrganization(
	c: Context,
	identity: { slug?: string; host?: string },
): Promise<{ organization: PublishedOrganization } | { error: Response }> {
	const organization = await resolveOrganizationForBrowserAuth(
		c.req.header('Origin'),
		identity,
	)
	if (!organization) {
		return {
			error: Response.json(
				{ error: 'Organization not found' },
				{ status: 404 },
			),
		}
	}
	if (
		!organization.hasProvisionedDb ||
		!orgMatchesNodeRegion(organization.dataRegion)
	) {
		return {
			error: Response.json(
				{ error: 'Organization is not available in this region' },
				{ status: 404 },
			),
		}
	}
	return { organization }
}

/**
 * Optional customer identity: when the browser presents a customer access
 * token it is authenticated and the order is bound to that customer. A
 * browser-supplied customerId is never accepted (strict schema rejects it).
 * An invalid or cross-org token is rejected rather than silently ignored.
 */
async function optionalCustomerId(
	c: Context,
	organization: PublishedOrganization,
): Promise<{ customerId: string | null } | { error: Response }> {
	if (!getBearerToken(c.req.header('Authorization'))) {
		return { customerId: null }
	}
	try {
		const auth = await authenticateCustomer(c)
		if (auth.organization.id !== organization.id) {
			return {
				error: Response.json(
					{ error: 'Customer token does not match this organization' },
					{ status: 403 },
				),
			}
		}
		return { customerId: auth.customerId }
	} catch (response) {
		return { error: response as Response }
	}
}

// ---------------------------------------------------------------------------
// POST /orders — place an order (prices are always re-derived server-side)
// ---------------------------------------------------------------------------

publicOrderRoutes.post('/', async (c) => {
	const contentLength = Number(c.req.header('content-length') ?? 0)
	if (contentLength > MAX_ORDER_BODY_BYTES) {
		return c.json({ error: 'Payload too large' }, 413, noStoreHeaders())
	}

	const rawBody = await c.req.json().catch(() => null)
	const parsed = restaurantOrderRequestSchema.safeParse(rawBody)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid order request',
			},
			400,
			noStoreHeaders(),
		)
	}
	const request = parsed.data
	const dineIn = dineInCapability(c)
	if ((request.fulfillment === 'dine_in' || dineIn) && isQrDineInDisabled()) {
		return dineInUnavailable()
	}

	if (
		!(await verifyOrderTurnstile(
			c,
			(rawBody as { turnstileToken?: unknown } | null)?.turnstileToken,
		))
	) {
		return c.json(
			{ error: 'Verification failed. Please try again.' },
			403,
			noStoreHeaders(),
		)
	}

	const organization = await resolveOrderingOrganization(c, {
		slug: request.slug,
		host: request.host,
	})
	if ('error' in organization) return organization.error

	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error

	const couponGuard = await guardCouponGuess(
		organization.organization.id,
		c,
		request.discounts?.code,
		[
			request.locationId,
			request.fulfillment,
			request.dropSlug ?? null,
			request.lines,
		],
		customer.customerId,
	)
	if (couponGuard.blocked) return couponGuard.blocked

	// Table rounds may come without a phone; the durable per-table limit
	// covers them inside the placement transaction.
	const phoneLimit = request.contact.phone
		? rateLimitByKey('order-create-phone', request.contact.phone, {
				maxRequests: 10,
				windowMs: 60 * 60 * 1000,
			})
		: { limited: false as const, retryAfter: 0 }
	if (phoneLimit.limited) {
		await couponGuard.settle('none')
		return c.json(
			{
				error: 'rate_limit_exceeded',
				message: 'Too many orders. Please try again later.',
				retry_after: phoneLimit.retryAfter,
			},
			429,
			{
				...noStoreHeaders(),
				'Retry-After': String(phoneLimit.retryAfter),
			},
		)
	}

	try {
		const result = await placeOrder({
			organization: organization.organization,
			request,
			customerId: customer.customerId,
			dineIn,
		})
		await couponGuard.settle(
			result.ok ? 'applied' : couponOutcomeOfFailure(result.failure),
		)
		if (!result.ok) return orderFailureResponse(result.failure)

		const body = {
			order: publicOrderSummary(result.data.order),
			receiptToken: result.data.receiptToken,
			...(result.data.paymentToken
				? { paymentToken: result.data.paymentToken }
				: {}),
			...(result.data.tab ? { tab: result.data.tab } : {}),
			...(result.data.marketingConsent
				? { marketingConsent: result.data.marketingConsent }
				: {}),
		}
		return c.json(body, result.data.status, noStoreHeaders())
	} catch (error) {
		await couponGuard.settle('none').catch(() => {})
		console.error(
			`Failed to place order for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not place this order.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// POST /orders/quote — price discounts (and a reward, when sent). No hold.
// ---------------------------------------------------------------------------

publicOrderRoutes.post('/quote', async (c) => {
	const contentLength = Number(c.req.header('content-length') ?? 0)
	if (contentLength > MAX_ORDER_BODY_BYTES) {
		return c.json({ error: 'Payload too large' }, 413, noStoreHeaders())
	}
	const rawBody = await c.req.json().catch(() => null)
	const parsed = restaurantOrderDiscountQuoteSchema.safeParse(rawBody)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid order request',
			},
			400,
			noStoreHeaders(),
		)
	}
	const request = parsed.data
	if (request.fulfillment === 'dine_in' && isQrDineInDisabled()) {
		return dineInUnavailable()
	}
	const organization = await resolveOrderingOrganization(c, {
		slug: request.slug,
		host: request.host,
	})
	if ('error' in organization) return organization.error
	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error

	const db = await getTenantDb(organization.organization.id)
	const ip = clientBucket(c) ?? 'unknown'
	const quoteLimit = await enforceDiscountLimit(
		db,
		'quoteIp',
		`${organization.organization.id}:${ip}`,
	)
	if (!quoteLimit.ok) {
		return c.json(
			{
				error: 'rate_limit_exceeded',
				message: 'Too many price checks. Please try again shortly.',
				retryAfterSeconds: quoteLimit.retryAfterSeconds,
			},
			429,
			{
				...noStoreHeaders(),
				'Retry-After': String(quoteLimit.retryAfterSeconds),
			},
		)
	}
	const couponGuard = await guardCouponGuess(
		organization.organization.id,
		c,
		request.discounts?.code,
		[
			request.locationId,
			request.fulfillment,
			request.dropSlug ?? null,
			request.lines,
		],
		customer.customerId,
	)
	if (couponGuard.blocked) return couponGuard.blocked

	try {
		const result = await quoteOrderDiscounts({
			organization: organization.organization,
			request,
			customerId: customer.customerId,
		})
		await couponGuard.settle(
			result.ok
				? couponOutcomeOfQuote(result.data.coupon)
				: couponOutcomeOfFailure(result.failure),
		)
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(result.data, 200, noStoreHeaders())
	} catch (error) {
		await couponGuard.settle('none').catch(() => {})
		console.error(
			`Failed to quote an order for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not price this order.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// GET /orders/options — public capability + availability, no PII
// ---------------------------------------------------------------------------

const optionsQuerySchema = z.object({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
	locationId: z.string().trim().min(1).max(100),
	dropSlug: z.string().trim().min(1).max(120).optional(),
})

publicOrderRoutes.get('/options', async (c) => {
	const parsed = optionsQuerySchema.safeParse(c.req.query())
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid ordering options request' },
			400,
			noStoreHeaders(),
		)
	}
	const organization = await resolveOrderingOrganization(c, {
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if ('error' in organization) return organization.error

	const dineIn = dineInCapability(c)
	if (dineIn && isQrDineInDisabled()) return dineInUnavailable()

	try {
		const result = await buildOrderingOptionsWithContext(
			organization.organization,
			{
				slug: parsed.data.slug ?? null,
				locationId: parsed.data.locationId,
				dropSlug: parsed.data.dropSlug ?? null,
			},
		)
		if (!result.ok) return orderFailureResponse(result.failure)
		const { options, context } = result.data
		if (!dineIn) return c.json(options, 200, noStoreHeaders())
		// A scanned table adds its label, the dine-in policy and the open tab
		// (so a re-scan resumes it). The QR flags come from the same fresh
		// order context the placement path reads.
		const table = await getTableContext(organization.organization.id, {
			capability: dineIn,
			locationId: parsed.data.locationId,
			context,
		})
		if (!table.ok) return orderFailureResponse(table.failure)
		return c.json({ ...options, ...table.data }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to build ordering options for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{
				error: 'internal_error',
				message: 'Ordering is unavailable right now.',
			},
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// GET /orders/tab — the open (or settled) tab behind an X-Tab-Token
// ---------------------------------------------------------------------------

publicOrderRoutes.get('/tab', async (c) => {
	const identitySchema = z.object({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
	})
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	if (isQrDineInDisabled()) return dineInUnavailable()
	const organization = await resolveOrderingOrganization(c, identity.data)
	if ('error' in organization) return organization.error

	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim()
	if (!tabToken) {
		// Not a 401: that status means the customer's token was refused (Sites
		// signs the customer out on it). A missing tab code reads like a wrong one.
		return c.json(
			{ error: 'tab_not_found', message: 'A tab code is required.' },
			404,
			noStoreHeaders(),
		)
	}
	// A customer token is optional: a signed-in guest may qualify for
	// discounts a guest does not, and the tab shows what they would get.
	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error
	try {
		const result = await getPublicTab(organization.organization.id, tabToken)
		if (!result.ok) return orderFailureResponse(result.failure)
		const [shown] = await withTabDiscounts(
			organization.organization.id,
			[result.data],
			{ customerId: customer.customerId },
		)
		return c.json({ tab: shown ?? result.data }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to load tab for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not load this tab.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// POST /orders/tab/pay — the guest pays the tab from the phone
// ---------------------------------------------------------------------------

publicOrderRoutes.post('/tab/pay', async (c) => {
	if (isQrDineInDisabled()) return dineInUnavailable()
	const parsed = qrTabPayRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid request',
			},
			400,
			noStoreHeaders(),
		)
	}
	if (
		!(await verifyOrderTurnstile(c, parsed.data.turnstileToken, {
			optional: true,
		}))
	) {
		return c.json(
			{ error: 'Verification failed. Please try again.' },
			403,
			noStoreHeaders(),
		)
	}

	const organization = await resolveOrderingOrganization(c, {
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if ('error' in organization) return organization.error
	const tabToken = c.req.header(QR_TAB_TOKEN_HEADER)?.trim()
	if (!tabToken) {
		// Not a 401: that status means the customer's token was refused (Sites
		// signs the customer out on it). A missing tab code reads like a wrong one.
		return c.json(
			{ error: 'tab_not_found', message: 'A tab code is required.' },
			404,
			noStoreHeaders(),
		)
	}
	// A customer token is optional here: a signed-in member collects the
	// tab's points, and only a signed-in member may spend a reward on it.
	const customer = await optionalCustomerId(c, organization.organization)
	if ('error' in customer) return customer.error
	const orgId = organization.organization.id
	const couponGuard = await guardCouponGuess(
		orgId,
		c,
		parsed.data.discounts?.code,
		['tab', tabToken],
		customer.customerId,
	)
	if (couponGuard.blocked) return couponGuard.blocked
	try {
		// The tab's own location decides whether online payment is on.
		const tab = await getPublicTab(orgId, tabToken)
		if (!tab.ok) {
			await couponGuard.settle('none')
			return orderFailureResponse(tab.failure)
		}
		const context = await fetchOrderContext(
			orgId,
			tab.data.table.locationId,
			null,
		)
		if (!context.ok) {
			await couponGuard.settle('none')
			return orderFailureResponse(context.failure)
		}
		const features = readQrOrderingFeatures(
			(context.data as { qrOrdering?: unknown }).qrOrdering,
		)
		const result = await prepareTabPayment(orgId, tabToken, {
			tipPercent: parsed.data.tipPercent,
			contact: parsed.data.contact,
			features,
			onlinePayment: context.data.onlinePayment,
			customerId: customer.customerId,
			loyalty: parsed.data.loyalty ?? null,
			context: context.data,
			discounts: parsed.data.discounts ?? null,
		})
		await couponGuard.settle(
			result.ok ? 'applied' : couponOutcomeOfFailure(result.failure),
		)
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(result.data, 200, noStoreHeaders())
	} catch (error) {
		await couponGuard.settle('none').catch(() => {})
		console.error(
			`Failed to start tab payment for org ${orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not start the payment.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// GET /orders/:id — authoritative receipt (secret capability, origin checked)
// ---------------------------------------------------------------------------

/**
 * What every refused order-link request gets: byte for byte what a receipt
 * read of an order that does not exist answers.
 */
function orderNotFoundResponse() {
	return orderFailureResponse({
		status: 404,
		code: 'order_not_found',
		message: 'Order not found.',
	})
}

async function guestReceiptResponse(
	c: Context,
	orgId: string,
	credentials: GuestOrderCredentials,
) {
	try {
		const access = await authorizeGuestOrder(
			orgId,
			c.req.param('id') ?? '',
			credentials,
		)
		if (!access.ok) return orderNotFoundResponse()
		return c.json({ order: receiptOrder(access.order) }, 200, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to load order receipt for org ${orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not load this order.' },
			500,
			noStoreHeaders(),
		)
	}
}

publicOrderRoutes.get('/:id', async (c) => {
	const identitySchema = z.object({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
	})
	const identity = identitySchema.safeParse(c.req.query())
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const organization = await resolveOrderingOrganization(c, identity.data)
	if ('error' in organization) return organization.error

	const receiptToken = getBearerToken(c.req.header('Authorization'))
	const linkToken = readOrderLinkHeader(c.req.header(ORDER_LINK_HEADER))
	if (linkToken !== null) {
		// The "View your order" link: read-only, the same receipt body. Either
		// a valid receipt token or a valid link token opens it; every refusal
		// is the uniform 404 of an unknown order.
		return guestReceiptResponse(c, organization.organization.id, {
			receiptToken,
			linkToken,
		})
	}
	if (!receiptToken) {
		return c.json(
			{ error: 'unauthorized', message: 'A receipt token is required.' },
			401,
			noStoreHeaders(),
		)
	}

	try {
		const result = await getOrderReceipt(
			organization.organization.id,
			c.req.param('id'),
			receiptToken,
		)
		if (!result.ok) return orderFailureResponse(result.failure)
		return c.json(
			{ order: receiptOrder(result.data.order) },
			200,
			noStoreHeaders(),
		)
	} catch (error) {
		console.error(
			`Failed to load order receipt for org ${organization.organization.id}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not load this order.' },
			500,
			noStoreHeaders(),
		)
	}
})

// ---------------------------------------------------------------------------
// POST /orders/:id/resend-link — e-mail the receipt (and its link) again
// ---------------------------------------------------------------------------

const resendLinkBodySchema = z
	.object({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
	})
	.strict()

const MAX_RESEND_LINK_BODY_BYTES = 2_000

publicOrderRoutes.post('/:id/resend-link', async (c) => {
	const contentLength = Number(c.req.header('content-length') ?? 0)
	if (contentLength > MAX_RESEND_LINK_BODY_BYTES) {
		return c.json({ error: 'Payload too large' }, 413, noStoreHeaders())
	}
	// The identity rides in the JSON body (as on every order POST), so the
	// Worker can route the request to the organization's Durable Object.
	const identity = resendLinkBodySchema.safeParse(
		(await c.req.json().catch(() => null)) ?? {},
	)
	if (!identity.success) {
		return c.json({ error: 'Organization not found' }, 404, noStoreHeaders())
	}
	const organization = await resolveOrderingOrganization(c, identity.data)
	if ('error' in organization) return organization.error
	const orgId = organization.organization.id
	const orderId = c.req.param('id')

	try {
		// Authenticated first: a forged or missing credential never spends the
		// real order's budget.
		const access = await authorizeGuestOrder(orgId, orderId, {
			receiptToken: getBearerToken(c.req.header('Authorization')),
			linkToken: readOrderLinkHeader(c.req.header(ORDER_LINK_HEADER)),
		})
		if (!access.ok) return orderNotFoundResponse()

		const db = await getTenantDb(orgId)
		const limit = await countOrderResendAttempt(db, { orgId, orderId })
		if (!limit.ok) {
			return c.json(
				{
					error: 'rate_limit_exceeded',
					message: 'Too many requests. Please try again later.',
					retryAfterSeconds: limit.retryAfterSeconds,
				},
				429,
				{
					...noStoreHeaders(),
					'Retry-After': String(limit.retryAfterSeconds),
				},
			)
		}
		// The same answer whether or not the order has an email address, the
		// emails are switched off, or the send fails.
		resendReceiptInBackground(orgId, orderId)
		return c.json({ ok: true }, 202, noStoreHeaders())
	} catch (error) {
		console.error(
			`Failed to resend an order link for org ${orgId}:`,
			error instanceof Error ? error.message : error,
		)
		return c.json(
			{ error: 'internal_error', message: 'We could not send this order.' },
			500,
			noStoreHeaders(),
		)
	}
})
