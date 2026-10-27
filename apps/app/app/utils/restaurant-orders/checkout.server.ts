/**
 * Hosted payment orchestration for restaurant orders.
 *
 * The browser gives App only opaque references (slug/host, order id, payment
 * token, locale). App resolves the organization, fetches the authoritative
 * quote from the org's regional tenant service over the internal command
 * channel, creates a hosted provider session, binds it regionally, and only
 * then returns the hosted checkout URL.
 *
 * Non-negotiable invariants:
 * - No customer contact, cart contents, or order instructions ever reach App
 *   or the payment provider. The hosted product name is a fixed generic label.
 * - Provider metadata is exactly `{ type, orgId, orderId }`.
 * - The regional quote is the only source of amount/currency.
 * - A session is bound regionally before its URL is returned; failed binds
 *   close the session when the provider supports it.
 * - Redirect/success URLs carry only the opaque order id and a validated
 *   locale path; the receipt capability stays in browser sessionStorage.
 */

import { parseTabOrderRef } from '@repo/common/qr-ordering'
import {
	getLocaleHref,
	isSiteContentLocale,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import { and, db, eq, inArray, Organization } from '@repo/database'
import {
	buildRestaurantOrderMetadata,
	buildRestaurantOrderSessionIdempotencyKey,
	isRestaurantOrderMetadata,
	isTerminalRestaurantPaymentStatus,
	mapCheckoutPaymentToRestaurantOrder,
	mapConnectSessionToRestaurantOrder,
	RESTAURANT_ORDER_PRODUCT_NAME,
	restaurantOrderCheckoutReference,
	type RestaurantOrderPaymentEvent,
	type RestaurantOrderProcessor,
} from '@repo/payments'
import type Stripe from 'stripe'
import { z } from 'zod'
import { getShopCommerce, getSiteBaseUrl } from '#app/utils/shop.server.ts'
import {
	billingCountryForCurrency,
	resolveRestaurantOnlinePayment,
} from './payment-config.server.ts'
import {
	bindRestaurantOrderPaymentSession,
	fetchRestaurantOrderQuote,
	notifyRestaurantOrderPaymentStatus,
	RegionalOrderApiError,
	type RestaurantOrderQuote,
} from './regional-order-api.server.ts'

/** Stripe requires `expires_at` to be at least 30 minutes in the future. */
const STRIPE_MIN_SESSION_MINUTES = 30
/** Safety margin so a hold-aligned session never violates the minimum. */
const SESSION_EXPIRY_BUFFER_MINUTES = 1

export type RestaurantOrderOrganization = {
	id: string
	name: string
	slug: string
	dataRegion: string | null
	hasProvisionedDb: boolean
	customDomain: string | null
	siteDefaultLocale: string | null
	siteLocales: string | null
	shopPaymentProvider: string | null
	stripeConnectAccountId: string | null
	stripeConnectChargesEnabled: boolean
	checkoutSubEntityId: string | null
	checkoutChargesEnabled: boolean
}

export type RestaurantOrderHostedCheckout = {
	checkoutUrl: string
	sessionId: string
	processor: RestaurantOrderProcessor
}

export type RestaurantOrderPaymentStatusResult = {
	paymentStatus: 'paid' | 'pending' | 'failed' | 'unknown'
	orderStatus: string
	holdExpiresAt: string | null
	processor: RestaurantOrderProcessor | null
}

function jsonError(status: number, error: string, retryable = false): Response {
	return Response.json({ error, retryable }, { status })
}

function regionalFailureResponse(error: RegionalOrderApiError): Response {
	if (
		error.code === 'invalid_payment_token' ||
		error.code === 'order_not_found'
	) {
		return jsonError(404, 'order_not_found')
	}
	if (error.retryable) {
		return jsonError(503, 'regional_unavailable', true)
	}
	// Non-retryable regional rejections (wrong region, wrong org, stale state)
	// fail closed without leaking which one fired.
	return jsonError(409, 'order_not_payable')
}

/**
 * Resolve the published organization a browser payment request belongs to.
 * The org is bound from the provided slug/custom host — never from a
 * client-supplied org id.
 */
export async function findPublishedRestaurantOrganization(options: {
	slug?: string | null
	host?: string | null
}): Promise<RestaurantOrderOrganization | null> {
	const slug = options.slug?.trim().toLowerCase() || null
	const host = options.host?.trim().toLowerCase().split(':')[0] || null
	if (!slug && !host) return null

	const organization = await db.query.Organization.findFirst({
		where: and(
			slug
				? eq(Organization.slug, slug)
				: and(
						eq(Organization.customDomain, host!),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
			eq(Organization.active, true),
			eq(Organization.sitePublished, true),
		),
		columns: {
			id: true,
			name: true,
			slug: true,
			dataRegion: true,
			hasProvisionedDb: true,
			customDomain: true,
			siteDefaultLocale: true,
			siteLocales: true,
			shopPaymentProvider: true,
			stripeConnectAccountId: true,
			stripeConnectChargesEnabled: true,
			checkoutSubEntityId: true,
			checkoutChargesEnabled: true,
		},
	})

	return organization ?? null
}

const localeSchema = z
	.string()
	.trim()
	.refine(isSiteContentLocale, 'Unsupported locale')

/**
 * Validate the requested locale against the public site locale catalog and the
 * organization's enabled locales. Catalog violations are rejected; locales the
 * org has not enabled fall back to the org default.
 */
function resolveCheckoutLocale(
	organization: RestaurantOrderOrganization,
	requested: string | null | undefined,
): string {
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	if (!requested) return defaultLocale
	const locale = requested.trim().toLowerCase()
	if (!localeSchema.safeParse(locale).success) return defaultLocale
	return locales.includes(locale as never) ? locale : defaultLocale
}

function buildSitePaymentUrls(
	organization: RestaurantOrderOrganization,
	locale: string,
	orderId: string,
): { successUrl: string; cancelUrl: string } {
	const siteBase = getSiteBaseUrl(organization)
	const defaultLocale =
		parseSiteLocalesConfig(
			organization.siteLocales,
			organization.siteDefaultLocale,
		).defaultLocale || 'en'
	const successPath = getLocaleHref(
		'/menu/success',
		locale,
		locale,
		defaultLocale,
	)
	const cancelPath = getLocaleHref('/menu', locale, locale, defaultLocale)
	if (parseTabOrderRef(orderId)) {
		// A QR table tab returns to the menu, where the tab drawer shows the
		// receipt (the tab capability lives in the guest's browser storage).
		const menuPath = getLocaleHref('/menu', locale, locale, defaultLocale)
		return {
			successUrl: `${siteBase}${menuPath}?tab=paid`,
			cancelUrl: `${siteBase}${menuPath}?tab=cancelled`,
		}
	}
	return {
		// Only the opaque order id rides on the success URL.
		successUrl: `${siteBase}${successPath}?order=${encodeURIComponent(orderId)}`,
		cancelUrl: `${siteBase}${cancelPath}`,
	}
}

/**
 * Stripe enforces a 30-minute minimum session lifetime. Align the session
 * expiry with the regional hold when possible; when the hold ends sooner, use
 * the hold plus that minimum rather than Stripe's 24-hour default, so a page
 * left open never outlives the hold by more than about half an hour. The regional hold always
 * remains authoritative: a late payment on an outlived session lands in
 * review, never in resurrected inventory.
 */
function stripeSessionExpiry(holdExpiresAt: string | null): Date | null {
	if (!holdExpiresAt) return null
	const holdMs = new Date(holdExpiresAt).getTime()
	if (!Number.isFinite(holdMs)) return null
	const minimumSpanMs =
		(STRIPE_MIN_SESSION_MINUTES + SESSION_EXPIRY_BUFFER_MINUTES) * 60_000
	// Anchored on the hold, not on now, so an idempotent replay sends the same
	// expiry (the idempotency key is built from the hold too).
	return holdMs > Date.now() + minimumSpanMs
		? new Date(holdMs)
		: new Date(holdMs + minimumSpanMs)
}

/**
 * Staff stopped a stuck tab payment: the region already unbound the session;
 * this closes the guest's Stripe page so it cannot take money any more. Only
 * a session of this organization's tab is touched. Checkout.com hosted pages
 * cannot be expired (money that still arrives there is kept for review).
 */
export async function expireReleasedTabSession(input: {
	organizationId: string
	tabId: string
	sessionId: string
	processor: string
}): Promise<'expired' | 'not_open' | 'unsupported'> {
	if (input.processor !== 'connect') return 'unsupported'
	const commerce = getShopCommerce()
	const session = await commerce.retrieveConnectCheckoutSession(input.sessionId)
	if (
		!isRestaurantOrderMetadata(session.metadata) ||
		session.metadata?.orgId !== input.organizationId ||
		session.metadata?.orderId !== `tab:${input.tabId}`
	) {
		throw new Response('Not Found', { status: 404 })
	}
	if (session.status !== 'open') return 'not_open'
	await commerce.expireConnectCheckoutSession(input.sessionId)
	return 'expired'
}

function quoteAllowsCheckout(
	quote: RestaurantOrderQuote,
): { ok: true } | { ok: false; response: Response } {
	if (quote.paymentStatus === 'paid') {
		return { ok: false, response: jsonError(409, 'already_paid') }
	}
	if (quote.paymentStatus === 'failed') {
		return { ok: false, response: jsonError(409, 'payment_failed') }
	}
	if (quote.holdExpiresAt) {
		const holdMs = new Date(quote.holdExpiresAt).getTime()
		if (Number.isFinite(holdMs) && holdMs <= Date.now()) {
			return { ok: false, response: jsonError(409, 'hold_expired') }
		}
	}
	return { ok: true }
}

/**
 * Recover an already-bound provider session for an order (idempotent replays
 * and bind races). Stripe sessions can be re-served from the provider;
 * Checkout.com sessions cannot be retrieved by id, so replays there return a
 * retryable "session already in progress" while the original session stands.
 */
async function recoverBoundSession(
	organization: RestaurantOrderOrganization,
	bound: { sessionId: string; processor: RestaurantOrderProcessor },
	orderId: string,
): Promise<RestaurantOrderHostedCheckout | Response> {
	if (bound.processor !== 'connect') {
		return jsonError(409, 'session_in_progress', true)
	}

	const commerce = getShopCommerce()
	const session = await commerce.retrieveConnectCheckoutSession(bound.sessionId)

	if (
		!isRestaurantOrderMetadata(session.metadata) ||
		session.metadata?.orgId !== organization.id ||
		session.metadata?.orderId !== orderId
	) {
		// The bound session does not belong to this org's restaurant order.
		// Never serve it back.
		return jsonError(409, 'session_invalid')
	}

	const event = mapConnectSessionToRestaurantOrder(session)
	if (event && isTerminalRestaurantPaymentStatus(event.status)) {
		// Reconcile a terminal provider state the webhook path may have missed.
		// Reporting an expired session lets the regional service clear the
		// binding (or move the order to payment_review) so a later retry can
		// create a fresh session instead of being stuck on a dead one.
		try {
			await notifyRestaurantOrderPaymentStatus({
				dataRegion: organization.dataRegion,
				orgId: event.orgId,
				orderId: event.orderId,
				sessionId: event.sessionId,
				processor: event.processor,
				status: event.status,
				amountCents: event.amountCents,
				currency: event.currency,
				paymentId: event.paymentId,
			})
		} catch (error) {
			console.error(
				'Restaurant order bound-session reconciliation failed:',
				error,
			)
		}

		if (event.status === 'paid') {
			return jsonError(409, 'already_paid')
		}
		if (event.status === 'failed') {
			return jsonError(409, 'payment_failed')
		}
		// 'expired' falls through to the session_expired check below.
	}

	if (session.payment_status === 'paid') {
		return jsonError(409, 'already_paid')
	}
	if (session.status === 'expired' || !session.url) {
		return jsonError(409, 'session_expired', true)
	}

	return {
		checkoutUrl: session.url,
		sessionId: session.id,
		processor: 'connect',
	}
}

/** Best-effort cleanup so an unbindable session can never be paid orphaned. */
async function closeUnboundSession(
	processor: RestaurantOrderProcessor,
	sessionId: string,
): Promise<void> {
	if (processor !== 'connect') return
	try {
		await getShopCommerce().expireConnectCheckoutSession(sessionId)
	} catch (error) {
		console.error('Failed to expire unbound restaurant order session:', error)
	}
}

/**
 * Create (or recover) the hosted checkout session for one online restaurant
 * order. Throws Responses with JSON error codes on failure.
 */
export async function createRestaurantOrderHostedCheckout(options: {
	slug?: string | null
	host?: string | null
	orderId: string
	paymentToken: string
	locale?: string | null
}): Promise<RestaurantOrderHostedCheckout> {
	const organization = await findPublishedRestaurantOrganization({
		slug: options.slug,
		host: options.host,
	})
	if (!organization) {
		throw jsonError(404, 'organization_not_found')
	}

	const onlinePayment = resolveRestaurantOnlinePayment(organization)
	if (!onlinePayment.enabled || !onlinePayment.processor) {
		throw jsonError(409, 'online_payment_unavailable')
	}
	const processor = onlinePayment.processor

	const commerce = getShopCommerce()
	if (!commerce.isProcessorConfigured(processor)) {
		// Platform secrets for this processor are absent: fail closed.
		throw jsonError(409, 'online_payment_unavailable')
	}

	let quote: RestaurantOrderQuote
	try {
		quote = await fetchRestaurantOrderQuote({
			dataRegion: organization.dataRegion,
			orgId: organization.id,
			orderId: options.orderId,
			paymentToken: options.paymentToken,
		})
	} catch (error) {
		if (error instanceof RegionalOrderApiError) {
			throw regionalFailureResponse(error)
		}
		throw error
	}

	const payable = quoteAllowsCheckout(quote)
	if (!payable.ok) throw payable.response

	// Idempotent replay: a live session is already bound to this order.
	if (quote.boundSession) {
		const recovered = await recoverBoundSession(
			organization,
			quote.boundSession,
			options.orderId,
		)
		if (recovered instanceof Response) throw recovered
		return recovered
	}

	const locale = resolveCheckoutLocale(organization, options.locale)
	const { successUrl, cancelUrl } = buildSitePaymentUrls(
		organization,
		locale,
		options.orderId,
	)
	const currency = quote.currency.toLowerCase()
	// Checkout.com payments and webhooks echo this reference (a hosted page id
	// is not guaranteed to come back), so it is also the regionally bound id.
	const checkoutReference =
		processor === 'checkout'
			? restaurantOrderCheckoutReference(organization.id, options.orderId)
			: null

	const expiresAt =
		processor === 'connect' ? stripeSessionExpiry(quote.holdExpiresAt) : null
	// The key carries the exact expiry sent (as reservations do), so a replay
	// that computes a different expiry never trips Stripe's parameter check.
	const baseKey =
		processor === 'connect'
			? buildRestaurantOrderSessionIdempotencyKey({
					orgId: organization.id,
					orderId: options.orderId,
					amountCents: quote.totalCents,
					currency: quote.currency,
					holdExpiresAt: expiresAt?.toISOString() ?? quote.holdExpiresAt,
				})
			: null
	const createSession = (idempotencyKey: string | null) =>
		commerce.createCheckout({
			processor,
			// Fixed generic label: never customer data, cart contents, or notes.
			productName: RESTAURANT_ORDER_PRODUCT_NAME,
			productDescription: null,
			amountCents: quote.totalCents,
			currency,
			connectAccountId:
				processor === 'connect' ? organization.stripeConnectAccountId : null,
			checkoutSubEntityId:
				processor === 'checkout' ? organization.checkoutSubEntityId : null,
			successUrl,
			cancelUrl,
			metadata: buildRestaurantOrderMetadata(organization.id, options.orderId),
			customerEmail: null,
			externalCustomerId: null,
			embedOrigin: null,
			expiresAt,
			idempotencyKey,
			reference: checkoutReference,
			billingCountry:
				processor === 'checkout'
					? billingCountryForCurrency(quote.currency)
					: null,
		})
	let session = await createSession(baseKey)
	// Stripe replays a cached session for the same key, even one that has
	// expired since (no URL): chain a new key off the dead session so the
	// guest gets a live page instead of an error until the hold moves.
	for (let attempt = 0; !session.url && baseKey && attempt < 2; attempt += 1) {
		session = await createSession(`${baseKey}:after:${session.id}`)
	}

	if (!session.url) {
		throw jsonError(502, 'checkout_session_unavailable', true)
	}

	// Bind before returning the URL. Binding is single-shot regionally, so a
	// concurrent replay cannot end up with two live charge sessions.
	try {
		await bindRestaurantOrderPaymentSession({
			dataRegion: organization.dataRegion,
			orgId: organization.id,
			orderId: options.orderId,
			sessionId: checkoutReference ?? session.id,
			processor,
		})
	} catch (error) {
		// Best-effort cleanup so an unbindable session can never be paid.
		await closeUnboundSession(processor, session.id)

		if (error instanceof RegionalOrderApiError) {
			// Another session already won the bind (or the regional service
			// rejected the 409-class state): recover the winner instead of
			// surfacing a second chargeable session.
			if (error.httpStatus === 409) {
				const recovered = await recoverBoundSessionFromBindRace(organization, {
					orderId: options.orderId,
					paymentToken: options.paymentToken,
				})
				if (recovered) {
					if (recovered instanceof Response) throw recovered
					return recovered
				}
				// No recoverable winner: surface the specific terminal cause,
				// otherwise a retryable in-progress signal so the browser can
				// re-poll while the original session stands.
				if (error.code === 'payment_terminal') {
					throw jsonError(409, 'already_paid')
				}
				if (error.code === 'hold_expired') {
					throw jsonError(409, 'hold_expired')
				}
				throw jsonError(409, 'session_in_progress', true)
			}
			throw regionalFailureResponse(error)
		}
		throw error
	}

	return {
		checkoutUrl: session.url,
		sessionId: session.id,
		processor,
	}
}

/**
 * After a lost bind race, re-quote the order to learn which session won, then
 * recover it. Returns null when the winning session cannot be determined
 * (transient regional failure) — callers then reject with a retryable error.
 */
async function recoverBoundSessionFromBindRace(
	organization: RestaurantOrderOrganization,
	request: { orderId: string; paymentToken: string },
): Promise<RestaurantOrderHostedCheckout | Response | null> {
	try {
		const quote = await fetchRestaurantOrderQuote({
			dataRegion: organization.dataRegion,
			orgId: organization.id,
			orderId: request.orderId,
			paymentToken: request.paymentToken,
		})
		if (!quote.boundSession) return null
		return await recoverBoundSession(
			organization,
			quote.boundSession,
			request.orderId,
		)
	} catch {
		return null
	}
}

/**
 * Reconcile and report an order's payment status for the browser's
 * post-redirect poll. App performs the trusted provider lookup for processors
 * that support it (Stripe Connect) and pushes any terminal state to the
 * regional service; the receipt itself stays regional. A redirect alone never
 * marks an order paid.
 */
export async function getRestaurantOrderPaymentStatus(options: {
	slug?: string | null
	host?: string | null
	orderId: string
	paymentToken: string
}): Promise<RestaurantOrderPaymentStatusResult> {
	const organization = await findPublishedRestaurantOrganization({
		slug: options.slug,
		host: options.host,
	})
	if (!organization) {
		throw jsonError(404, 'organization_not_found')
	}

	let quote: RestaurantOrderQuote
	try {
		quote = await fetchRestaurantOrderQuote({
			dataRegion: organization.dataRegion,
			orgId: organization.id,
			orderId: options.orderId,
			paymentToken: options.paymentToken,
		})
	} catch (error) {
		if (error instanceof RegionalOrderApiError) {
			throw regionalFailureResponse(error)
		}
		throw error
	}

	let paymentStatus: RestaurantOrderPaymentStatusResult['paymentStatus'] =
		quote.paymentStatus === 'unknown'
			? 'unknown'
			: quote.paymentStatus === 'paid'
				? 'paid'
				: quote.paymentStatus === 'failed'
					? 'failed'
					: 'pending'

	// Trusted provider reconciliation: Stripe by session retrieval (below),
	// Checkout.com by payment lookup (after this block).
	const bound = quote.boundSession
	if (paymentStatus !== 'paid' && bound?.processor === 'connect') {
		const commerce = getShopCommerce()
		try {
			const session: Stripe.Checkout.Session =
				await commerce.retrieveConnectCheckoutSession(bound.sessionId)
			const event = mapConnectSessionToRestaurantOrder(session)
			if (
				event &&
				isTerminalRestaurantPaymentStatus(event.status) &&
				isRestaurantOrderMetadata(session.metadata) &&
				session.metadata?.orgId === organization.id
			) {
				try {
					await notifyRestaurantOrderPaymentStatus({
						dataRegion: organization.dataRegion,
						orgId: event.orgId,
						orderId: event.orderId,
						sessionId: event.sessionId,
						processor: event.processor,
						status: event.status,
						amountCents: event.amountCents,
						currency: event.currency,
						paymentId: event.paymentId,
					})
					// The regional service owns order state; for the browser's
					// poll a dead provider session (failed or expired) means this
					// hosted attempt cannot succeed — regional decides whether
					// the order may retry or needs payment_review.
					paymentStatus = event.status === 'paid' ? 'paid' : 'failed'
				} catch (error) {
					// Transient regional failure: report the last regional state and
					// let the next poll retry (idempotent regionally).
					console.error(
						'Restaurant order payment-status reconciliation failed:',
						error,
					)
				}
			}
		} catch (error) {
			console.error('Restaurant order provider session lookup failed:', error)
		}
	}

	// Checkout.com: no webhook needed. The bound id is the merchant reference,
	// and the provider can list the payments made for it.
	if (paymentStatus !== 'paid' && bound?.processor === 'checkout') {
		const reconciled = await reconcileCheckoutOrderPayment(
			organization,
			options.orderId,
			bound.sessionId,
		)
		if (reconciled) paymentStatus = reconciled
	}

	return {
		paymentStatus,
		orderStatus: quote.status,
		holdExpiresAt: quote.holdExpiresAt,
		processor: bound?.processor ?? null,
	}
}

/**
 * Look up the order's Checkout.com payments by reference and push a terminal
 * state to the regional service. Returns the status to report to the browser,
 * or null to keep the regional one (nothing decided yet, or a transient
 * failure that the next poll retries).
 */
async function reconcileCheckoutOrderPayment(
	organization: RestaurantOrderOrganization,
	orderId: string,
	boundSessionId: string,
): Promise<'paid' | 'failed' | null> {
	const reference = restaurantOrderCheckoutReference(organization.id, orderId)
	// Only the reference this App binds for this order: never search for an
	// id the regional service happens to hold.
	if (boundSessionId !== reference) return null
	try {
		const payments =
			await getShopCommerce().findCheckoutPaymentsByReference(reference)
		const events = payments
			.map((payment) => mapCheckoutPaymentToRestaurantOrder(payment))
			.filter(
				(event): event is RestaurantOrderPaymentEvent =>
					event !== null &&
					event.orgId === organization.id &&
					event.orderId === orderId &&
					isTerminalRestaurantPaymentStatus(event.status),
			)
		// Every paid payment is reported (a tab can be paid twice on one
		// reference); the region keeps each by its payment id.
		const paid = events.filter((event) => event.status === 'paid')
		const decided =
			paid.length > 0
				? paid
				: events.filter((event) => event.status === 'failed').slice(0, 1)
		if (decided.length === 0) return null
		for (const event of decided) {
			await notifyRestaurantOrderPaymentStatus({
				dataRegion: organization.dataRegion,
				orgId: event.orgId,
				orderId: event.orderId,
				sessionId: event.sessionId,
				processor: 'checkout',
				status: event.status as 'paid' | 'failed',
				amountCents: event.amountCents,
				currency: event.currency,
				paymentId: event.paymentId,
			})
		}
		return paid.length > 0 ? 'paid' : 'failed'
	} catch (error) {
		console.error(
			'Restaurant order Checkout.com payment lookup failed:',
			error instanceof Error ? error.message : 'unknown error',
		)
		return null
	}
}
