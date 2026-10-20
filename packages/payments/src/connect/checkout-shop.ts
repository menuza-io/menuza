/**
 * Checkout.com shop helpers for tenant site commerce (US marketplace).
 *
 * Uses Checkout.com Platforms sub-entities with amount_allocations commission
 * for the same 20% platform / 80% tenant split as Stripe Connect.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Checkout } from 'checkout-sdk-node'

import { calculateShopFees } from './shop-fees'

export type CheckoutShopClient = Checkout

export type CheckoutShopConfig = {
	secretKey: string
	publicKey: string
	subdomain: string
	processingChannelId: string
	environment?: 'sandbox' | 'production'
	/** Point the SDK at another API host (the local payment mock). */
	host?: string
}

export type CheckoutSubEntityStatus = {
	entityId: string
	chargesEnabled: boolean
	payoutsEnabled: boolean
	status: string
}

export type CheckoutShopPaymentSession = {
	id: string
	url: string
	reference?: string
	amountCents: number
	currency: string
	metadata: Record<string, string>
}

export type CheckoutShopPayment = {
	id: string
	/** `processing.payment_session_id`; HPP payments may not carry it. */
	sessionId: string | null
	/** Merchant reference the hosted page was created with. */
	reference: string | null
	amountCents: number
	currency: string
	paid: boolean
	/** Provider status (e.g. `Declined`), used to tell failed from pending. */
	status?: string
	metadata: Record<string, string>
	productName: string
}

function metadataRecord(
	metadata: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
	if (!metadata) return {}
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(metadata)) {
		result[key] = String(value).slice(0, 500)
	}
	return result
}

export function createCheckoutShopClient(
	config: CheckoutShopConfig,
): CheckoutShopClient {
	return new Checkout(config.secretKey, {
		pk: config.publicKey,
		subdomain: config.subdomain,
		environment: config.environment ?? 'sandbox',
		...(config.host ? { host: config.host } : {}),
	})
}

export function getCheckoutDashboardUrl(environment: 'sandbox' | 'production') {
	return environment === 'production'
		? 'https://dashboard.checkout.com'
		: 'https://dashboard.sandbox.checkout.com'
}

export async function inviteCheckoutSubEntity(
	client: CheckoutShopClient,
	options: {
		organizationId: string
		inviteeEmail: string
	},
) {
	const response = (await client.platforms.onboardSubEntity({
		reference: options.organizationId,
		contact_details: {
			invitee: {
				email: options.inviteeEmail,
			},
		},
		is_draft: true,
	})) as {
		id?: string
		status?: string
	}

	if (!response.id) {
		throw new Error('Checkout.com did not return a sub-entity id')
	}

	return {
		id: response.id,
		status: response.status ?? 'pending',
	}
}

export async function retrieveCheckoutSubEntityStatus(
	client: CheckoutShopClient,
	entityId: string,
): Promise<CheckoutSubEntityStatus> {
	const response = (await client.platforms.getSubEntityDetails(entityId)) as {
		id?: string
		status?: string
		capabilities?: {
			payments?: { enabled?: boolean }
			payouts?: { enabled?: boolean }
		}
	}

	return {
		entityId: response.id ?? entityId,
		status: response.status ?? 'pending',
		chargesEnabled: Boolean(response.capabilities?.payments?.enabled),
		payoutsEnabled: Boolean(response.capabilities?.payouts?.enabled),
	}
}

/**
 * Create a Hosted Payments Page (`POST /hosted-payments`). Unlike the Flow
 * `payment-sessions` call this returns a redirect link the guest can open.
 */
export async function createCheckoutShopHostedPayment(
	client: CheckoutShopClient,
	options: {
		subEntityId: string
		productName: string
		amountCents: number
		currency?: string
		processingChannelId: string
		successUrl: string
		failureUrl: string
		cancelUrl?: string
		metadata: Record<string, string>
		customerEmail?: string | null
		/** Merchant reference; defaults to the metadata orgId (shop behavior). */
		reference?: string | null
		/** Billing country for the hosted session; defaults to 'US'. */
		billingCountry?: string | null
	},
): Promise<CheckoutShopPaymentSession> {
	const { platformFeeCents, orgPayoutCents } = calculateShopFees(
		options.amountCents,
	)
	const reference = options.reference || options.metadata.orgId || 'shop_order'

	const body = {
		amount: options.amountCents,
		currency: (options.currency || 'usd').toUpperCase(),
		reference,
		description: options.productName.slice(0, 100),
		processing_channel_id: options.processingChannelId,
		success_url: options.successUrl,
		failure_url: options.failureUrl,
		cancel_url: options.cancelUrl || options.failureUrl,
		billing: {
			address: {
				country: options.billingCountry || 'US',
			},
		},
		customer: options.customerEmail
			? {
					email: options.customerEmail,
				}
			: undefined,
		metadata: {
			...options.metadata,
			productName: options.productName.slice(0, 500),
		},
		amount_allocations: [
			{
				id: options.subEntityId,
				amount: orgPayoutCents + platformFeeCents,
				commission: {
					amount: platformFeeCents,
				},
			},
		],
	}

	const session = (await client.hostedPayments.create(body as never)) as {
		id?: string
		_links?: {
			redirect?: { href?: string }
			self?: { href?: string }
		}
	}

	if (!session.id) {
		throw new Error('Checkout.com did not return a hosted payment id')
	}

	const redirectUrl = session._links?.redirect?.href
	if (!redirectUrl) {
		throw new Error('Checkout.com did not return a hosted checkout URL')
	}

	return {
		id: session.id,
		url: redirectUrl,
		reference,
		amountCents: options.amountCents,
		currency: options.currency || 'usd',
		metadata: metadataRecord(options.metadata),
	}
}

/** Hosted page status and, once paid, the payment id (`GET /hosted-payments/{id}`). */
export async function retrieveCheckoutHostedPayment(
	client: CheckoutShopClient,
	hostedPaymentId: string,
) {
	const hosted = (await client.hostedPayments.get(hostedPaymentId)) as {
		id?: string
		status?: string
		payment_id?: string | null
		reference?: string
	}
	return {
		id: hosted.id ?? hostedPaymentId,
		status: hosted.status ?? 'unknown',
		paymentId: hosted.payment_id ?? null,
		reference: hosted.reference ?? null,
	}
}

/**
 * Payments made for one merchant reference (`POST /payments/search`), newest
 * first. This is how a status poll finds a payment with no webhook and no
 * stored payment id.
 */
export async function findCheckoutShopPaymentsByReference(
	client: CheckoutShopClient,
	reference: string,
): Promise<CheckoutShopPayment[]> {
	const escaped = reference.replaceAll("'", '')
	const result = (await client.payments.search({
		query: `reference:'${escaped}'`,
		limit: 20,
	} as never)) as { data?: Array<Record<string, unknown>> }
	return (result.data ?? []).map((payment) =>
		toCheckoutShopPayment(payment as never, String(payment.id ?? '')),
	)
}

type RawCheckoutPayment = {
	id?: string
	amount?: number
	currency?: string
	approved?: boolean
	status?: string
	metadata?: Record<string, string | number | boolean>
	reference?: string
	description?: string
	processing?: {
		payment_session_id?: string
	}
}

function toCheckoutShopPayment(
	payment: RawCheckoutPayment,
	fallbackId: string,
): CheckoutShopPayment {
	const metadata = metadataRecord(payment.metadata)
	const paid =
		payment.approved === true ||
		payment.status === 'Authorized' ||
		payment.status === 'Captured'

	return {
		id: payment.id ?? fallbackId,
		sessionId: payment.processing?.payment_session_id ?? null,
		reference: payment.reference ?? null,
		amountCents: payment.amount ?? 0,
		currency: payment.currency?.toLowerCase() || 'usd',
		paid,
		status: payment.status,
		metadata,
		productName:
			metadata.productName ||
			payment.description ||
			payment.reference ||
			'Product',
	}
}

export async function retrieveCheckoutShopPayment(
	client: CheckoutShopClient,
	paymentId: string,
): Promise<CheckoutShopPayment> {
	const payment = (await client.payments.get(paymentId)) as RawCheckoutPayment
	return toCheckoutShopPayment(payment, paymentId)
}

export function checkoutPaymentStatusToOrderStatus(
	paid: boolean,
	status?: string,
): 'paid' | 'pending' | 'failed' {
	if (paid) return 'paid'
	if (status === 'Declined' || status === 'Canceled') return 'failed'
	return 'pending'
}

export function mapCheckoutShopPayment(payment: CheckoutShopPayment) {
	return payment
}

export function checkoutWebhookSignatureFromRequest(request: Request) {
	return (
		request.headers.get('cko-signature') ||
		request.headers.get('Cko-Signature') ||
		''
	)
}

export function verifyCheckoutWebhookEvent(
	payload: string,
	signature: string,
	secret: string,
) {
	const digest = createHmac('sha256', secret).update(payload).digest('hex')
	const received = signature.trim()
	if (!received || digest.length !== received.length) {
		throw new Error('Checkout.com webhook signature verification failed')
	}
	if (!timingSafeEqual(Buffer.from(digest), Buffer.from(received))) {
		throw new Error('Checkout.com webhook signature verification failed')
	}

	return JSON.parse(payload) as { type: string; data: unknown }
}

export function mapCheckoutWebhookToPayment(event: {
	type: string
	data: unknown
}): CheckoutShopPayment | null {
	const relevantTypes = new Set([
		'payment_approved',
		'payment_captured',
		'payment_declined',
		'payment_pending',
	])
	if (!relevantTypes.has(event.type)) return null

	const data = event.data as RawCheckoutPayment
	if (!data.id) return null

	const paid =
		event.type === 'payment_approved' ||
		event.type === 'payment_captured' ||
		data.approved === true

	return {
		...toCheckoutShopPayment(data, data.id),
		paid,
		status: event.type === 'payment_declined' ? 'Declined' : data.status,
	}
}
