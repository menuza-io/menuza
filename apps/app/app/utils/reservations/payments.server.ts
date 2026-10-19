/**
 * Reservation payment orchestration (deposits, prepayments, experience
 * tickets, card guarantees, staff-charged fees, refunds, late payments).
 *
 * The regional tenant-api decides amounts, currency, policy and state. The App
 * is the only component that talks to a provider, sees only opaque ids,
 * amounts and currency, and never calls a provider inside a regional lock or
 * transaction: it asks the region for a quote, creates the provider session
 * itself, then reports to the region (bind once, status, results) in separate
 * calls.
 *
 * Invariants:
 * - Provider metadata, product names, Customers and idempotency keys carry
 *   opaque ids only; a single-use payment token is never hashed or forwarded.
 * - The quote is the only source of amount and currency. The platform fee is
 *   `platformFeeMinor(amount, bp)` (floor), reported at bind and fee result.
 * - Never log card data, tokens, raw provider events or full error objects.
 *   Failures are logged by `error.name` / stable code only.
 * - Every provider or regional failure maps to a stable error code.
 */

import {
	getLocaleHref,
	isSiteContentLocale,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import { and, db, eq, Organization } from '@repo/database'
import {
	buildGuaranteeConsentText,
	buildReservationFeeIdempotencyKey,
	buildReservationFeeMetadata,
	buildReservationLateRefundIdempotencyKey,
	buildReservationPaymentMetadata,
	buildReservationRefundIdempotencyKey,
	buildReservationRefundMetadata,
	buildReservationSessionIdempotencyKey,
	isStripeTransientError,
	mapCheckoutPaymentToReservationPayment,
	mapStripeSessionToReservationPayment,
	reservationCheckoutReference,
	reservationFeeChargeReference,
	reservationProductName,
	reservationRefundReference,
	reservationStripeExpiresAt,
	RESERVATION_CHECKOUT_VERIFICATION_MINOR,
	sanitizeStatementDescriptorSuffix,
	stripeErrorCode,
	type ReservationPaymentEvent,
} from '@repo/payments'
import {
	platformFeeMinor,
	type ReservationFeeKind,
	type ReservationPaymentPurpose,
	type ReservationPaymentQuote,
	type ReservationRefundDirective,
} from '@repo/reservations'
import { ENV } from 'varlock/env'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import { resolveReservationPlatformFeeBp } from '#app/utils/reservations/platform-fee.server.ts'
import {
	bindReservationPaymentSession,
	claimReservationFee,
	claimReservationRefunds,
	fetchReservationPaymentQuote,
	notifyReservationPaymentStatus,
	RegionalPaymentsApiError,
	reportReservationFeeResult,
	reportReservationRefundResult,
} from '#app/utils/reservations/regional-payments-api.server.ts'
import { resolveSitesOrigin } from '#app/utils/reservations/sites-origin.server.ts'
import {
	findPublishedRestaurantOrganization,
	type RestaurantOrderOrganization,
} from '#app/utils/restaurant-orders/checkout.server.ts'
import {
	billingCountryForCurrency,
	resolveRestaurantOnlinePayment,
	type RestaurantPaymentOrgConfig,
} from '#app/utils/restaurant-orders/payment-config.server.ts'
import { getShopCommerce } from '#app/utils/shop.server.ts'

/* ------------------------------------------------------------------ */
/* Errors and small helpers                                            */
/* ------------------------------------------------------------------ */

/** Typed failure of an execution path (fee, refund, outbox command). */
export class ReservationPaymentError extends Error {
	constructor(
		public readonly code: string,
		public readonly httpStatus: number,
		public readonly retryable = false,
	) {
		super(`Reservation payment error: ${code}`)
		this.name = 'ReservationPaymentError'
	}
}

function jsonError(status: number, error: string, retryable = false): Response {
	return Response.json({ error, retryable }, { status })
}

/** Log a failure without the error object, message or any payload. */
export function logReservationPaymentFailure(label: string, error: unknown) {
	const code =
		(error as { code?: unknown } | null)?.code ??
		(error as { http_code?: unknown } | null)?.http_code
	console.error(
		`Reservation payments: ${label}`,
		error instanceof Error ? error.name : 'unknown',
		typeof code === 'string' || typeof code === 'number' ? code : '',
	)
}

type AppProcessor = 'connect' | 'checkout'
type RegionalProcessor = 'stripe' | 'checkout'

export function toRegionalProcessor(
	processor: AppProcessor,
): RegionalProcessor {
	return processor === 'connect' ? 'stripe' : 'checkout'
}

export function fromRegionalProcessor(
	processor: RegionalProcessor,
): AppProcessor {
	return processor === 'stripe' ? 'connect' : 'checkout'
}

/* ------------------------------------------------------------------ */
/* Online payment gate                                                 */
/* ------------------------------------------------------------------ */

const STRIPE_CURRENCIES = new Set(['USD', 'CAD'])
const CHECKOUT_CURRENCIES = new Set(['SAR', 'USD'])

export type ReservationOnlinePayment = {
	enabled: boolean
	processor: AppProcessor | null
	regionalProcessor: RegionalProcessor | null
	/** The quote currency is one this processor settles (SAR never goes to Stripe). */
	currencySupported: boolean
	deposit: boolean
	guarantee: boolean
}

/**
 * Variant of `resolveRestaurantOnlinePayment` for reservations: the processor
 * comes from the organization, the currency from the quote (the location
 * currency). `deposit` needs a charges-enabled Connect account or an enabled
 * Checkout.com sub-entity; `guarantee` is true for Connect and, for
 * Checkout.com, whenever the processor is configured (always in mock mode).
 */
export function resolveReservationOnlinePayment(
	org: RestaurantPaymentOrgConfig,
	currency: string,
	options: {
		isProcessorConfigured?: (processor: AppProcessor) => boolean
	} = {},
): ReservationOnlinePayment {
	const base = resolveRestaurantOnlinePayment(org)
	const processor = base.enabled ? base.processor : null
	if (!processor) {
		return {
			enabled: false,
			processor: null,
			regionalProcessor: null,
			currencySupported: false,
			deposit: false,
			guarantee: false,
		}
	}
	const code = currency.toUpperCase()
	const currencySupported =
		processor === 'connect'
			? STRIPE_CURRENCIES.has(code)
			: CHECKOUT_CURRENCIES.has(code)
	const configured = options.isProcessorConfigured?.(processor) ?? true
	return {
		enabled: true,
		processor,
		regionalProcessor: toRegionalProcessor(processor),
		currencySupported,
		deposit: currencySupported,
		guarantee:
			currencySupported && (processor === 'connect' ? true : configured),
	}
}

/* ------------------------------------------------------------------ */
/* Organization loading for money operations                           */
/* ------------------------------------------------------------------ */

export type ReservationPaymentsOrg = RestaurantPaymentOrgConfig & {
	id: string
	name: string
	slug: string
	hasProvisionedDb: boolean
}

/** Load an active organization by id (never from a client-supplied value). */
export async function loadReservationPaymentsOrg(
	orgId: string,
): Promise<ReservationPaymentsOrg | null> {
	const org = await db.query.Organization.findFirst({
		where: and(eq(Organization.id, orgId), eq(Organization.active, true)),
		columns: {
			id: true,
			name: true,
			slug: true,
			dataRegion: true,
			hasProvisionedDb: true,
			shopPaymentProvider: true,
			stripeConnectAccountId: true,
			stripeConnectChargesEnabled: true,
			checkoutSubEntityId: true,
			checkoutChargesEnabled: true,
		},
	})
	return org ?? null
}

/* ------------------------------------------------------------------ */
/* Pushing terminal states to the region (browser poll, webhooks, jobs) */
/* ------------------------------------------------------------------ */

export type ReservationPushResult = {
	outcome: string
	paymentStatus: string | undefined
	reservationStatus: string | undefined
}

const TERMINAL_EVENT_STATUSES = new Set([
	'paid',
	'failed',
	'expired',
	'setup_succeeded',
])

export function isTerminalReservationEvent(event: ReservationPaymentEvent) {
	return TERMINAL_EVENT_STATUSES.has(event.status)
}

/**
 * Report one terminal payment event to the org's region. Duplicates are
 * idempotent there. A `refund_required` answer (a late payment that no longer
 * fits) is executed at once. Transient failures propagate so the caller
 * (webhook, outbox, job) is retried.
 */
export async function pushReservationPaymentEvent(
	org: { dataRegion: string | null },
	event: ReservationPaymentEvent,
): Promise<ReservationPushResult> {
	if (!isTerminalReservationEvent(event)) {
		return {
			outcome: 'ignored',
			paymentStatus: undefined,
			reservationStatus: undefined,
		}
	}
	const response = await notifyReservationPaymentStatus({
		dataRegion: org.dataRegion,
		orgId: event.orgId,
		reservationId: event.reservationId,
		feeId: event.feeId ?? undefined,
		purpose: event.purpose,
		sessionId: event.sessionId,
		processor: event.processor,
		status: event.status as 'paid' | 'failed' | 'expired' | 'setup_succeeded',
		amountMinor: event.amountMinor,
		currency: event.currency,
		paymentRef: event.paymentRef ?? undefined,
		paymentMethodRef: event.paymentMethodRef ?? undefined,
		providerCustomerRef: event.providerCustomerRef ?? undefined,
		previousPaymentRef: event.previousPaymentRef ?? undefined,
		card: event.card ?? undefined,
	})

	if (response.outcome === 'refund_required' && response.refund) {
		await handleLateRefund({
			orgId: event.orgId,
			dataRegion: org.dataRegion,
			directive: response.refund,
		})
	} else if (
		event.processor === 'checkout' &&
		event.purpose === 'guarantee' &&
		event.status === 'setup_succeeded' &&
		event.paymentRef &&
		response.outcome !== 'review'
	) {
		await refundCheckoutVerificationCharge(
			event.orgId,
			event.paymentRef,
			event.currency,
		)
	}

	return {
		outcome: response.outcome,
		paymentStatus: response.paymentStatus,
		reservationStatus: response.reservationStatus,
	}
}

/**
 * A Checkout.com guarantee stores the card with a small customer-initiated
 * verification charge; give it back once the card is on file. Idempotent by
 * key; a failure leaves the charge for the manager to refund and never blocks
 * the guarantee.
 */
async function refundCheckoutVerificationCharge(
	orgId: string,
	paymentId: string,
	currency: string,
) {
	try {
		const org = await loadReservationPaymentsOrg(orgId)
		if (!org?.checkoutSubEntityId) return
		await getShopCommerce().createReservationCheckoutRefund({
			paymentId,
			subEntityId: org.checkoutSubEntityId,
			amountMinor: RESERVATION_CHECKOUT_VERIFICATION_MINOR,
			feeReversalMinor: 0,
			reference: `rsv_verify_${paymentId}`.slice(0, 50),
			idempotencyKey: `reservation_verify_refund_${paymentId}`,
		})
	} catch (error) {
		logReservationPaymentFailure(`verification refund (${currency})`, error)
	}
}

/* ------------------------------------------------------------------ */
/* Refund execution                                                    */
/* ------------------------------------------------------------------ */

export type ReservationRefundExecution = {
	status: 'succeeded' | 'pending' | 'failed'
	refundRef: string | null
	amountMinor: number
}

/**
 * Issue one refund at the provider. A definitive provider rejection is
 * `failed`; transient failures (and anything not understood) are rethrown so
 * the caller retries and never reports a terminal failure it cannot prove.
 */
export async function issueReservationRefund(input: {
	org: Pick<ReservationPaymentsOrg, 'id' | 'checkoutSubEntityId'>
	directive: Pick<
		ReservationRefundDirective,
		| 'reservationId'
		| 'paymentRef'
		| 'processor'
		| 'amountMinor'
		| 'feeReversalMinor'
	>
	refundRequestId: string | null
}): Promise<ReservationRefundExecution> {
	const commerce = getShopCommerce()
	const { org, directive, refundRequestId } = input
	const idempotencyKey = refundRequestId
		? buildReservationRefundIdempotencyKey({
				orgId: org.id,
				refundRequestId,
			})
		: buildReservationLateRefundIdempotencyKey(directive.paymentRef)

	if (directive.processor === 'stripe') {
		return commerce.createReservationStripeRefund({
			paymentIntentId: directive.paymentRef,
			amountMinor: directive.amountMinor,
			idempotencyKey,
			metadata: buildReservationRefundMetadata({
				orgId: org.id,
				reservationId: directive.reservationId,
				refundRequestId,
			}),
		})
	}
	if (!org.checkoutSubEntityId) {
		throw new ReservationPaymentError('checkout_unavailable', 409)
	}
	return commerce.createReservationCheckoutRefund({
		paymentId: directive.paymentRef,
		subEntityId: org.checkoutSubEntityId,
		amountMinor: directive.amountMinor,
		// Decided regionally (cumulative rounding), so reversals sum to the snapshot.
		feeReversalMinor: directive.feeReversalMinor,
		reference: reservationRefundReference({
			refundRequestId,
			paymentRef: directive.paymentRef,
		}),
		idempotencyKey,
	})
}

/**
 * A payment that arrived after its hold expired and no longer fits: refund it
 * in full at once (key `reservation_late_refund_<paymentRef>`) and report it.
 * When the refund call cannot be made, report `failed` so the region moves the
 * payment to `review` with a manager alert.
 */
export async function handleLateRefund(input: {
	orgId: string
	dataRegion: string | null
	directive: ReservationRefundDirective
}): Promise<ReservationRefundExecution> {
	const { orgId, dataRegion, directive } = input
	let execution: ReservationRefundExecution
	try {
		const org = await loadReservationPaymentsOrg(orgId)
		if (!org) throw new ReservationPaymentError('org_not_found', 404)
		// The regional refund row id (when the region named one) links the
		// provider refund to its row: metadata, reference and idempotency key
		// are then identical to a claimed refund, so a later reclaim by
		// reconciliation can never issue a second refund.
		execution = await issueReservationRefund({
			org,
			directive,
			refundRequestId: directive.refundRequestId ?? null,
		})
	} catch (error) {
		logReservationPaymentFailure('late refund', error)
		execution = {
			status: 'failed',
			refundRef: null,
			amountMinor: directive.amountMinor,
		}
	}
	await reportReservationRefundResult({
		dataRegion,
		orgId,
		...(directive.refundRequestId
			? { refundRequestId: directive.refundRequestId }
			: {
					reservationId: directive.reservationId,
					paymentRef: directive.paymentRef,
					reason: 'late_payment' as const,
				}),
		refundRef: execution.refundRef ?? undefined,
		amountMinor: execution.amountMinor,
		status: execution.status,
	})
	return execution
}

/* ------------------------------------------------------------------ */
/* Hosted checkout (quote -> create outside any lock -> bind once)     */
/* ------------------------------------------------------------------ */

export type ReservationHostedCheckout = {
	checkoutUrl: string
	sessionId: string
	processor: AppProcessor
	purpose: ReservationPaymentPurpose
	mode: 'payment' | 'setup'
}

export type ReservationCheckoutOptions = {
	slug?: string | null
	host?: string | null
	reservationId?: string | null
	feeId?: string | null
	paymentToken: string
	purpose: ReservationPaymentPurpose
	locale?: string | null
}

/** Payment statuses that mean the money (or the card) is already settled. */
const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'guaranteed', 'fee_charged'])
/** Statuses a quote can be in when a payment may still be started. */
const PAYABLE_PAYMENT_STATUSES = new Set([
	'none',
	'pending',
	'fee_pending',
	'fee_failed',
])
const DEAD_RESERVATION_STATUSES = new Set([
	'cancelled',
	'expired',
	'declined',
	'no_show',
	'finished',
])

function regionalFailureResponse(error: RegionalPaymentsApiError): Response {
	if (
		error.code === 'invalid_payment_token' ||
		error.code === 'payment_not_found' ||
		error.code === 'reservation_not_found' ||
		error.code === 'not_found' ||
		error.httpStatus === 404
	) {
		return jsonError(404, 'payment_not_found')
	}
	if (error.retryable) return jsonError(503, 'regional_unavailable', true)
	// Non-retryable rejections fail closed without saying which rule fired.
	return jsonError(409, 'payment_not_payable')
}

function quoteBlocksCheckout(
	quote: ReservationPaymentQuote,
	purpose: ReservationPaymentPurpose,
): Response | null {
	if (quote.purpose !== purpose) return jsonError(409, 'purpose_mismatch')
	if (SETTLED_PAYMENT_STATUSES.has(quote.paymentStatus)) {
		return jsonError(409, 'already_paid')
	}
	if (!PAYABLE_PAYMENT_STATUSES.has(quote.paymentStatus)) {
		return jsonError(409, 'payment_not_payable')
	}
	if (
		purpose !== 'fee' &&
		DEAD_RESERVATION_STATUSES.has(quote.reservationStatus)
	) {
		return jsonError(409, 'reservation_not_payable')
	}
	// The region's clock decides (no App/region skew).
	if (new Date(quote.expiresAt).getTime() <= new Date(quote.now).getTime()) {
		return jsonError(409, 'hold_expired')
	}
	return null
}

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
	if (!isSiteContentLocale(locale)) return defaultLocale
	return locales.includes(locale as never) ? locale : defaultLocale
}

/**
 * Return and cancel URLs: the site origin, the validated locale path and
 * opaque ids only. The payment token is never put in a URL.
 */
export function buildReservationReturnUrls(
	organization: RestaurantOrderOrganization,
	locale: string,
	ids: { reservationId: string; feeId: string | null },
	purpose: ReservationPaymentPurpose,
): { successUrl: string; cancelUrl: string } {
	const origin = resolveSitesOrigin({
		slug: organization.slug,
		customDomain: organization.customDomain,
		baseUrl: (ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, ''),
		hostSuffixes: ENV.PUBLIC_SITE_HOST_SUFFIXES,
	})
	const { defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const done = getLocaleHref('/reserve/pay/done', locale, locale, defaultLocale)
	const pay = getLocaleHref('/reserve/pay', locale, locale, defaultLocale)
	const idParam = ids.feeId
		? `f=${encodeURIComponent(ids.feeId)}`
		: `r=${encodeURIComponent(ids.reservationId)}`
	return {
		successUrl: `${origin}${done}?${idParam}&purpose=${purpose}`,
		cancelUrl: `${origin}${pay}#${idParam}`,
	}
}

function quoteMeta(quote: ReservationPaymentQuote, orgId: string) {
	return quote.purpose === 'fee'
		? buildReservationFeeMetadata({
				orgId,
				reservationId: quote.reservationId,
				feeId: quote.feeId!,
			})
		: buildReservationPaymentMetadata({
				orgId,
				reservationId: quote.reservationId,
				purpose: quote.purpose,
			})
}

/** The id bound regionally: the Stripe session id, or the Checkout.com reference. */
function boundSessionIdFor(
	processor: AppProcessor,
	orgId: string,
	quote: ReservationPaymentQuote,
	providerSessionId: string,
): string {
	return processor === 'checkout'
		? reservationCheckoutReference({
				orgId,
				reservationId: quote.reservationId,
				feeId: quote.feeId,
				purpose: quote.purpose,
			})
		: providerSessionId
}

async function fetchQuoteOrThrow(
	organization: { id: string; dataRegion: string | null },
	options: ReservationCheckoutOptions,
): Promise<ReservationPaymentQuote> {
	try {
		if (options.purpose === 'fee') {
			if (!options.feeId) throw jsonError(400, 'invalid_request')
			return await fetchReservationPaymentQuote({
				dataRegion: organization.dataRegion,
				orgId: organization.id,
				feeId: options.feeId,
				paymentToken: options.paymentToken,
				purpose: 'fee',
			})
		}
		if (!options.reservationId) throw jsonError(400, 'invalid_request')
		return await fetchReservationPaymentQuote({
			dataRegion: organization.dataRegion,
			orgId: organization.id,
			reservationId: options.reservationId,
			paymentToken: options.paymentToken,
			purpose: options.purpose,
		})
	} catch (error) {
		if (error instanceof RegionalPaymentsApiError) {
			throw regionalFailureResponse(error)
		}
		throw error
	}
}

/**
 * Recover the session already bound to this payment (idempotent replays and
 * bind races). Stripe sessions are re-served from the provider. Checkout.com
 * hosted pages cannot be looked up by reference, so a replay of a still-open
 * page answers `session_in_progress` (retryable) while terminal states found by
 * reference are reconciled and reported.
 */
async function recoverBoundSession(
	organization: RestaurantOrderOrganization,
	quote: ReservationPaymentQuote,
): Promise<ReservationHostedCheckout | Response> {
	const bound = quote.boundSession
	if (!bound) return jsonError(409, 'session_invalid')
	const commerce = getShopCommerce()
	const processor = fromRegionalProcessor(bound.processor)

	if (bound.processor === 'checkout') {
		const decided = await reconcileCheckoutQuote(organization, quote)
		if (decided === 'paid') return jsonError(409, 'already_paid')
		if (decided === 'failed') return jsonError(409, 'payment_failed')
		return jsonError(409, 'session_in_progress', true)
	}

	const session = await commerce.retrieveReservationStripeSession(
		bound.sessionId,
		{ setup: quote.mode === 'setup' },
	)
	const event = mapStripeSessionToReservationPayment(session)
	if (!event || !eventMatchesQuote(event, organization.id, quote)) {
		// The bound session does not belong to this payment: never serve it.
		return jsonError(409, 'session_invalid')
	}
	if (isTerminalReservationEvent(event)) {
		try {
			await pushReservationPaymentEvent(organization, event)
		} catch (error) {
			logReservationPaymentFailure('bound-session reconciliation', error)
		}
		if (event.status === 'paid' || event.status === 'setup_succeeded') {
			return jsonError(409, 'already_paid')
		}
		if (event.status === 'failed') return jsonError(409, 'payment_failed')
		return jsonError(409, 'session_expired', true)
	}
	if (!session.url) return jsonError(409, 'session_expired', true)
	return {
		checkoutUrl: session.url,
		sessionId: session.id,
		processor,
		purpose: quote.purpose,
		mode: quote.mode,
	}
}

function eventMatchesQuote(
	event: ReservationPaymentEvent,
	orgId: string,
	quote: ReservationPaymentQuote,
) {
	return (
		event.orgId === orgId &&
		event.reservationId === quote.reservationId &&
		event.feeId === quote.feeId &&
		event.purpose === quote.purpose
	)
}

async function closeUnboundSession(
	processor: AppProcessor,
	sessionId: string,
): Promise<void> {
	// Checkout.com hosted pages have no expiry call and are never returned.
	if (processor !== 'connect') return
	try {
		await getShopCommerce().expireConnectCheckoutSession(sessionId)
	} catch (error) {
		logReservationPaymentFailure('expire unbound session', error)
	}
}

/**
 * Create (or recover) the hosted checkout for one reservation payment. Throws
 * `Response`s with `{ error, retryable }` JSON on failure.
 */
export async function createReservationHostedCheckout(
	options: ReservationCheckoutOptions,
): Promise<ReservationHostedCheckout> {
	const organization = await findPublishedRestaurantOrganization({
		slug: options.slug,
		host: options.host,
	})
	if (!organization) throw jsonError(404, 'organization_not_found')
	if (!(await isReservationsFeatureEnabled(organization.id, 'payments'))) {
		throw jsonError(409, 'online_payment_unavailable')
	}

	const quote = await fetchQuoteOrThrow(organization, options)
	const blocked = quoteBlocksCheckout(quote, options.purpose)
	if (blocked) throw blocked

	const commerce = getShopCommerce()
	const online = resolveReservationOnlinePayment(organization, quote.currency, {
		isProcessorConfigured: (processor) =>
			commerce.isProcessorConfigured(processor),
	})
	if (
		!online.enabled ||
		!online.processor ||
		!online.currencySupported ||
		!commerce.isProcessorConfigured(online.processor)
	) {
		throw jsonError(409, 'online_payment_unavailable')
	}
	if (quote.mode === 'setup' && !online.guarantee) {
		throw jsonError(409, 'online_payment_unavailable')
	}
	if (quote.mode === 'payment' && !online.deposit) {
		throw jsonError(409, 'online_payment_unavailable')
	}
	const processor = online.processor

	// Idempotent replay: a live session is already bound.
	if (quote.boundSession) {
		const recovered = await recoverBoundSession(organization, quote)
		if (recovered instanceof Response) throw recovered
		return recovered
	}

	const platformFeeBp = await resolveReservationPlatformFeeBp(organization.id)
	const feeMinor = platformFeeMinor(quote.amountMinor, platformFeeBp)
	const locale = resolveCheckoutLocale(organization, options.locale)
	const { successUrl, cancelUrl } = buildReservationReturnUrls(
		organization,
		locale,
		{ reservationId: quote.reservationId, feeId: quote.feeId },
		quote.purpose,
	)
	const metadata = quoteMeta(quote, organization.id)
	const productName = reservationProductName({
		purpose: quote.purpose,
		feeKind: quote.feeKind as ReservationFeeKind | null,
		productLabel: quote.productLabel,
	})

	let providerSessionId: string
	let checkoutUrl: string
	let providerCustomerRef: string | null = null
	try {
		if (processor === 'connect') {
			if (!organization.stripeConnectAccountId) {
				throw jsonError(409, 'online_payment_unavailable')
			}
			let guarantee: {
				orgId: string
				guestRef: string
				consentText: string
			} | null = null
			if (quote.mode === 'setup') {
				if (!quote.consent) throw jsonError(409, 'payment_not_payable')
				guarantee = {
					orgId: organization.id,
					guestRef: quote.guestRef,
					consentText: buildGuaranteeConsentText(
						{ currency: quote.currency, ...quote.consent },
						locale,
					),
				}
			}
			// One value feeds both the key and the session, so a retry with the
			// same key always sends the same parameters.
			const stripeExpiresAt = reservationStripeExpiresAt(
				Date.now(),
				quote.expiresAt,
			)
			const session = await commerce.createReservationStripeSession({
				connectedAccountId: organization.stripeConnectAccountId,
				guarantee,
				productName,
				amountMinor: quote.amountMinor,
				currency: quote.currency,
				quantity: quote.quantity,
				unitAmountMinor: quote.unitAmountMinor,
				platformFeeMinor: feeMinor,
				successUrl,
				cancelUrl,
				paymentExpiresAt: quote.expiresAt,
				expiresAt: stripeExpiresAt,
				statementDescriptorSuffix: sanitizeStatementDescriptorSuffix(
					organization.name,
				),
				idempotencyKey: buildReservationSessionIdempotencyKey({
					orgId: organization.id,
					reservationId: quote.reservationId,
					feeId: quote.feeId,
					purpose: quote.purpose,
					amountMinor: quote.amountMinor,
					currency: quote.currency,
					paymentExpiresAt: quote.expiresAt,
					stripeExpiresAt,
				}),
				metadata,
			})
			providerSessionId = session.id
			checkoutUrl = session.url
			providerCustomerRef = session.customerId
		} else {
			if (!organization.checkoutSubEntityId) {
				throw jsonError(409, 'online_payment_unavailable')
			}
			const page = await commerce.createReservationCheckoutHostedPayment({
				subEntityId: organization.checkoutSubEntityId,
				productName,
				amountMinor: quote.amountMinor,
				currency: quote.currency,
				reference: boundSessionIdFor(processor, organization.id, quote, ''),
				guarantee: quote.mode === 'setup',
				platformFeeMinor: feeMinor,
				successUrl,
				failureUrl: cancelUrl,
				cancelUrl,
				billingCountry: billingCountryForCurrency(quote.currency),
				metadata,
			})
			providerSessionId = page.id
			checkoutUrl = page.url
		}
	} catch (error) {
		if (error instanceof Response) throw error
		logReservationPaymentFailure('create session', error)
		throw jsonError(502, 'checkout_session_unavailable', true)
	}

	// Bind before returning the URL. Binding is single shot regionally, so a
	// concurrent replay cannot end up with two live charge sessions.
	const boundId = boundSessionIdFor(
		processor,
		organization.id,
		quote,
		providerSessionId,
	)
	const result: ReservationHostedCheckout = {
		checkoutUrl,
		sessionId: providerSessionId,
		processor,
		purpose: quote.purpose,
		mode: quote.mode,
	}
	try {
		await bindReservationPaymentSession({
			dataRegion: organization.dataRegion,
			orgId: organization.id,
			reservationId: quote.reservationId,
			feeId: quote.feeId ?? undefined,
			purpose: quote.purpose,
			sessionId: boundId,
			processor: toRegionalProcessor(processor),
			providerCustomerRef: providerCustomerRef ?? undefined,
			platformFeeBp,
			platformFeeMinor: feeMinor,
		})
	} catch (error) {
		if (
			!(error instanceof RegionalPaymentsApiError) ||
			error.httpStatus !== 409
		) {
			await closeUnboundSession(processor, providerSessionId)
			if (error instanceof RegionalPaymentsApiError) {
				throw regionalFailureResponse(error)
			}
			throw error
		}
		// Lost the bind. The deterministic key means a concurrent request may
		// hold this very session, so learn who won before closing anything: only
		// a session that is not the bound one is expired.
		const winner = await requoteAfterBindLoss(organization, options)
		// (A Checkout.com page cannot be told apart from the winner's: both carry
		// the same reference, so it is never served.)
		if (
			processor === 'connect' &&
			winner?.boundSession?.sessionId === boundId
		) {
			return result
		}
		await closeUnboundSession(processor, providerSessionId)
		if (winner?.boundSession) {
			const recovered = await recoverBoundSession(organization, winner).catch(
				() => null,
			)
			if (recovered) {
				if (recovered instanceof Response) throw recovered
				return recovered
			}
		}
		if (error.code === 'payment_terminal') throw jsonError(409, 'already_paid')
		if (error.code === 'hold_expired') throw jsonError(409, 'hold_expired')
		throw jsonError(409, 'session_in_progress', true)
	}

	return result
}

/** After a lost bind, re-quote to learn the winner; null on a transient failure. */
async function requoteAfterBindLoss(
	organization: RestaurantOrderOrganization,
	options: ReservationCheckoutOptions,
): Promise<ReservationPaymentQuote | null> {
	try {
		return await fetchQuoteOrThrow(organization, options)
	} catch {
		return null
	}
}

/* ------------------------------------------------------------------ */
/* Status poll (trusted provider lookup, then push)                    */
/* ------------------------------------------------------------------ */

export type ReservationPaymentStatusResult = {
	purpose: ReservationPaymentPurpose
	mode: 'payment' | 'setup'
	paymentStatus: string
	reservationStatus: string
	expiresAt: string
	processor: AppProcessor | null
}

/**
 * Look up the Checkout.com payments for the quote's reference and push the
 * decided terminal state. Returns what it decided, or null for nothing decided
 * yet or a transient failure that the next poll retries.
 */
async function reconcileCheckoutQuote(
	organization: { id: string; dataRegion: string | null },
	quote: ReservationPaymentQuote,
): Promise<'paid' | 'failed' | null> {
	const bound = quote.boundSession
	if (!bound || bound.processor !== 'checkout') return null
	const reference = reservationCheckoutReference({
		orgId: organization.id,
		reservationId: quote.reservationId,
		feeId: quote.feeId,
		purpose: quote.purpose,
	})
	// Only the reference this App binds for this payment.
	if (bound.sessionId !== reference) return null
	try {
		const payments =
			await getShopCommerce().findReservationCheckoutPayments(reference)
		const events = payments
			.map((payment) => mapCheckoutPaymentToReservationPayment(payment))
			.filter(
				(event): event is ReservationPaymentEvent =>
					event !== null &&
					eventMatchesQuote(event, organization.id, quote) &&
					isTerminalReservationEvent(event),
			)
		const decided =
			events.find(
				(event) =>
					event.status === 'paid' || event.status === 'setup_succeeded',
			) ?? events.find((event) => event.status === 'failed')
		if (!decided) return null
		await pushReservationPaymentEvent(organization, decided)
		return decided.status === 'failed' ? 'failed' : 'paid'
	} catch (error) {
		logReservationPaymentFailure('checkout payment lookup', error)
		return null
	}
}

async function reconcileStripeQuote(
	organization: { id: string; dataRegion: string | null },
	quote: ReservationPaymentQuote,
): Promise<'paid' | 'failed' | 'expired' | null> {
	const bound = quote.boundSession
	if (!bound || bound.processor !== 'stripe') return null
	try {
		const session = await getShopCommerce().retrieveReservationStripeSession(
			bound.sessionId,
			{ setup: quote.mode === 'setup' },
		)
		const event = mapStripeSessionToReservationPayment(session)
		if (
			!event ||
			!eventMatchesQuote(event, organization.id, quote) ||
			event.sessionId !== bound.sessionId ||
			!isTerminalReservationEvent(event)
		) {
			return null
		}
		await pushReservationPaymentEvent(organization, event)
		return event.status === 'failed'
			? 'failed'
			: event.status === 'expired'
				? 'expired'
				: 'paid'
	} catch (error) {
		logReservationPaymentFailure('stripe session lookup', error)
		return null
	}
}

/**
 * The browser's post-redirect poll. The App performs the trusted provider
 * lookup and pushes any terminal state to the region, then reports the
 * region's view. A redirect alone never marks anything paid.
 */
export async function getReservationPaymentStatus(
	options: ReservationCheckoutOptions,
): Promise<ReservationPaymentStatusResult> {
	const organization = await findPublishedRestaurantOrganization({
		slug: options.slug,
		host: options.host,
	})
	if (!organization) throw jsonError(404, 'organization_not_found')

	let quote = await fetchQuoteOrThrow(organization, options)
	if (quote.purpose !== options.purpose)
		throw jsonError(409, 'purpose_mismatch')

	const settled =
		SETTLED_PAYMENT_STATUSES.has(quote.paymentStatus) ||
		!PAYABLE_PAYMENT_STATUSES.has(quote.paymentStatus)
	if (!settled && quote.boundSession) {
		const decided =
			quote.boundSession.processor === 'stripe'
				? await reconcileStripeQuote(organization, quote)
				: await reconcileCheckoutQuote(organization, quote)
		if (decided) {
			// The region owns the state; re-read it for the answer.
			try {
				quote = await fetchQuoteOrThrow(organization, options)
			} catch {
				// Keep the last known state; the next poll retries.
			}
		}
	}

	return {
		purpose: quote.purpose,
		mode: quote.mode,
		paymentStatus: quote.paymentStatus,
		reservationStatus: quote.reservationStatus,
		expiresAt: quote.expiresAt,
		processor: quote.boundSession
			? fromRegionalProcessor(quote.boundSession.processor)
			: null,
	}
}

/* ------------------------------------------------------------------ */
/* Staff-charged fees                                                  */
/* ------------------------------------------------------------------ */

export type ReservationFeeChargeResult = {
	feeId: string
	attempt: number
	status: 'succeeded' | 'requires_action' | 'failed'
	declineCode: string | null
}

const REPORT_ATTEMPTS = 3

async function withReportRetries<T>(
	label: string,
	operation: () => Promise<T>,
): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			const retryable =
				error instanceof RegionalPaymentsApiError ? error.retryable : true
			if (!retryable) throw error
			await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
		}
	}
	logReservationPaymentFailure(label, lastError)
	throw lastError
}

/** Run a provider call, retrying a bounded number of times on transient errors only. */
async function withProviderRetries<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			if (!isStripeTransientError(error)) throw error
			await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
		}
	}
	throw lastError
}

/**
 * Charge a staff-triggered no-show or late-cancel fee. The region claims the
 * fee once (`pending -> charging`, 409 otherwise); the provider charge uses the
 * deterministic key; the result is reported with retries. A transient provider
 * failure is retried with the same key and then surfaced as retryable without
 * reporting a terminal result (the key makes a later retry safe).
 */
export async function chargeReservationFee(input: {
	orgId: string
	reservationId: string
	feeId: string
	/** The operator's locations: `null` for all. Required, never defaulted. */
	locationIds: string[] | null
}): Promise<ReservationFeeChargeResult> {
	const org = await loadReservationPaymentsOrg(input.orgId)
	if (!org || !org.hasProvisionedDb) {
		throw new ReservationPaymentError('org_not_found', 404)
	}
	let claim
	try {
		claim = await claimReservationFee({
			dataRegion: org.dataRegion,
			orgId: org.id,
			reservationId: input.reservationId,
			feeId: input.feeId,
			locationIds: input.locationIds,
		})
	} catch (error) {
		if (error instanceof RegionalPaymentsApiError) {
			if (error.httpStatus === 409) {
				throw new ReservationPaymentError('fee_not_claimable', 409)
			}
			throw new ReservationPaymentError(
				error.retryable ? 'regional_unavailable' : 'fee_claim_rejected',
				error.retryable ? 503 : error.httpStatus,
				error.retryable,
			)
		}
		throw error
	}
	if (
		claim.reservationId !== input.reservationId ||
		claim.feeId !== input.feeId
	) {
		throw new ReservationPaymentError('fee_mismatch', 409)
	}

	const platformFeeBp = await resolveReservationPlatformFeeBp(org.id)
	const feeMinor = platformFeeMinor(claim.amountMinor, platformFeeBp)
	const commerce = getShopCommerce()
	const idempotencyKey = buildReservationFeeIdempotencyKey({
		orgId: org.id,
		reservationId: claim.reservationId,
		feeId: claim.feeId,
		attempt: claim.attempt,
	})
	const metadata = buildReservationFeeMetadata({
		orgId: org.id,
		reservationId: claim.reservationId,
		feeId: claim.feeId,
	})

	let outcome: {
		status: 'succeeded' | 'requires_action' | 'failed'
		paymentRef: string | null
		declineCode: string | null
	}
	try {
		if (claim.processor === 'stripe') {
			if (
				!org.stripeConnectAccountId ||
				!claim.providerCustomerRef ||
				!claim.paymentMethodRef
			) {
				outcome = {
					status: 'failed',
					paymentRef: null,
					declineCode: 'no_saved_card',
				}
			} else {
				const result = await withProviderRetries(() =>
					commerce.chargeReservationFeeStripe({
						connectedAccountId: org.stripeConnectAccountId!,
						customerId: claim.providerCustomerRef!,
						paymentMethodId: claim.paymentMethodRef!,
						amountMinor: claim.amountMinor,
						currency: claim.currency,
						platformFeeMinor: feeMinor,
						statementDescriptorSuffix: sanitizeStatementDescriptorSuffix(
							org.name,
						),
						idempotencyKey,
						metadata,
					}),
				)
				outcome = {
					status: result.status,
					paymentRef: result.paymentRef,
					declineCode: result.status === 'failed' ? result.declineCode : null,
				}
			}
		} else if (
			!org.checkoutSubEntityId ||
			!claim.paymentMethodRef ||
			!claim.previousPaymentRef
		) {
			outcome = {
				status: 'failed',
				paymentRef: null,
				declineCode: 'no_saved_card',
			}
		} else {
			const result = await withProviderRetries(() =>
				commerce.chargeReservationFeeCheckout({
					subEntityId: org.checkoutSubEntityId!,
					sourceId: claim.paymentMethodRef!,
					previousPaymentId: claim.previousPaymentRef!,
					amountMinor: claim.amountMinor,
					currency: claim.currency,
					reference: reservationFeeChargeReference({
						feeId: claim.feeId,
						attempt: claim.attempt,
					}),
					platformFeeMinor: feeMinor,
					idempotencyKey,
					metadata,
				}),
			)
			outcome = {
				status: result.status,
				paymentRef: result.paymentRef,
				declineCode: result.status === 'failed' ? result.declineCode : null,
			}
		}
	} catch (error) {
		logReservationPaymentFailure('fee charge', error)
		// A definitive Stripe rejection (not a network or server problem) is a
		// failed charge the operator can see; anything else is retried later
		// with the same key and never reported as terminal.
		const stripeCode = stripeErrorCode(error)
		const definitiveStripe =
			isStripeTransientError(error) === false &&
			(error as { type?: unknown } | null)?.type !== undefined
		if (definitiveStripe) {
			outcome = {
				status: 'failed',
				paymentRef: null,
				declineCode: stripeCode.slice(0, 64),
			}
		} else {
			throw new ReservationPaymentError('provider_unavailable', 503, true)
		}
	}

	await withReportRetries('fee result report', () =>
		reportReservationFeeResult({
			dataRegion: org.dataRegion,
			orgId: org.id,
			reservationId: claim.reservationId,
			feeId: claim.feeId,
			attempt: claim.attempt,
			paymentRef: outcome.paymentRef ?? undefined,
			status: outcome.status,
			declineCode: outcome.declineCode ?? undefined,
			platformFeeBp,
			platformFeeMinor: feeMinor,
		}),
	)
	return {
		feeId: claim.feeId,
		attempt: claim.attempt,
		status: outcome.status,
		declineCode: outcome.declineCode,
	}
}

/* ------------------------------------------------------------------ */
/* Outbox commands from the region                                     */
/* ------------------------------------------------------------------ */

export type ReservationCommandResult =
	| { kind: 'refund_request'; refunds: number; pending: number; failed: number }
	| { kind: 'checkout_expire'; expired: boolean }

/** Execute one refund request end to end: claim, provider refund, report. */
export async function executeReservationRefundRequest(input: {
	orgId: string
	refundRequestId: string
	/** An operator's locations (`null` for all); omitted for the system outbox. */
	locationIds?: string[] | null
}): Promise<{ refunds: number; pending: number; failed: number }> {
	const org = await loadReservationPaymentsOrg(input.orgId)
	if (!org || !org.hasProvisionedDb) {
		throw new ReservationPaymentError('org_not_found', 404)
	}
	let claims
	try {
		claims = await claimReservationRefunds({
			dataRegion: org.dataRegion,
			orgId: org.id,
			refundRequestId: input.refundRequestId,
			...(input.locationIds !== undefined
				? { locationIds: input.locationIds }
				: {}),
		})
	} catch (error) {
		if (error instanceof RegionalPaymentsApiError) {
			throw new ReservationPaymentError(
				error.retryable ? 'regional_unavailable' : error.code,
				error.retryable ? 503 : error.httpStatus,
				error.retryable,
			)
		}
		throw error
	}

	const totals = { refunds: 0, pending: 0, failed: 0 }
	for (const claim of claims) {
		let execution: ReservationRefundExecution
		try {
			execution = await issueReservationRefund({
				org,
				directive: claim,
				refundRequestId: claim.refundRequestId,
			})
		} catch (error) {
			// Transient or not understood: never reported as a terminal failure.
			logReservationPaymentFailure('refund', error)
			throw new ReservationPaymentError('provider_unavailable', 503, true)
		}
		await withReportRetries('refund result report', () =>
			reportReservationRefundResult({
				dataRegion: org.dataRegion,
				orgId: org.id,
				refundRequestId: claim.refundRequestId,
				refundRef: execution.refundRef ?? undefined,
				amountMinor: execution.amountMinor,
				status: execution.status,
			}),
		)
		totals.refunds += 1
		if (execution.status === 'pending') totals.pending += 1
		if (execution.status === 'failed') totals.failed += 1
	}
	return totals
}

function isAlreadyClosedStripeError(error: unknown) {
	return (
		(error as { type?: string } | null)?.type === 'StripeInvalidRequestError' ||
		(error as { statusCode?: number } | null)?.statusCode === 404
	)
}

/**
 * Execute a command delivered from the regional outbox. `refund_request`
 * claims, refunds and reports; `checkout_expire` expires the Stripe session (an
 * already complete or expired one is success) and does nothing for
 * Checkout.com (hosted pages lapse on their own). A retryable
 * `ReservationPaymentError` makes the route answer 503 so the outbox retries.
 */
export async function executeReservationPaymentCommand(
	command:
		| { kind: 'refund_request'; orgId: string; refundRequestId: string }
		| {
				kind: 'checkout_expire'
				orgId: string
				reservationId: string
				sessionId: string
				processor: RegionalProcessor
		  },
): Promise<ReservationCommandResult> {
	if (command.kind === 'refund_request') {
		const totals = await executeReservationRefundRequest(command)
		return { kind: 'refund_request', ...totals }
	}
	if (command.processor !== 'stripe') {
		return { kind: 'checkout_expire', expired: false }
	}
	const org = await loadReservationPaymentsOrg(command.orgId)
	if (!org) throw new ReservationPaymentError('org_not_found', 404)
	try {
		await getShopCommerce().expireConnectCheckoutSession(command.sessionId)
		return { kind: 'checkout_expire', expired: true }
	} catch (error) {
		if (isStripeTransientError(error)) {
			logReservationPaymentFailure('expire session', error)
			throw new ReservationPaymentError('provider_unavailable', 503, true)
		}
		if (isAlreadyClosedStripeError(error)) {
			return { kind: 'checkout_expire', expired: false }
		}
		throw error
	}
}
