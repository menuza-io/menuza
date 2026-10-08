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
	amountCents: number
	currency: string
	metadata: Record<string, string>
}

export type CheckoutShopPayment = {
	id: string
	sessionId: string | null
	amountCents: number
	currency: string
	paid: boolean
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

export async function createCheckoutShopPaymentSession(
	client: CheckoutShopClient,
	options: {
		subEntityId: string
		productName: string
		amountCents: number
		currency?: string
		processingChannelId: string
		successUrl: string
		failureUrl: string
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

	const body = {
		amount: options.amountCents,
		currency: (options.currency || 'usd').toUpperCase(),
		reference: options.reference || options.metadata.orgId || 'shop_order',
		description: options.productName.slice(0, 100),
		processing_channel_id: options.processingChannelId,
		success_url: options.successUrl,
		failure_url: options.failureUrl,
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

	const session = (await client.paymentSessions.request(body)) as {
		id?: string
		_links?: {
			redirect?: { href?: string }
			self?: { href?: string }
		}
	}

	if (!session.id) {
		throw new Error('Checkout.com did not return a payment session id')
	}

	const redirectUrl = session._links?.redirect?.href
	if (!redirectUrl) {
		throw new Error('Checkout.com did not return a hosted checkout URL')
	}

	return {
		id: session.id,
		url: redirectUrl,
		amountCents: options.amountCents,
		currency: options.currency || 'usd',
		metadata: metadataRecord(options.metadata),
	}
}

export async function retrieveCheckoutShopPayment(
	client: CheckoutShopClient,
	paymentId: string,
): Promise<CheckoutShopPayment> {
	const payment = (await client.payments.get(paymentId)) as {
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

	const metadata = metadataRecord(payment.metadata)
	const paid =
		payment.approved === true ||
		payment.status === 'Authorized' ||
		payment.status === 'Captured'

	return {
		id: payment.id ?? paymentId,
		sessionId: payment.processing?.payment_session_id ?? null,
		amountCents: payment.amount ?? 0,
		currency: payment.currency?.toLowerCase() || 'usd',
		paid,
		metadata,
		productName:
			metadata.productName ||
			payment.description ||
			payment.reference ||
			'Product',
	}
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

	const data = event.data as {
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
	if (!data.id) return null

	const metadata = metadataRecord(data.metadata)
	const paid =
		event.type === 'payment_approved' ||
		event.type === 'payment_captured' ||
		data.approved === true

	return {
		id: data.id,
		sessionId: data.processing?.payment_session_id ?? null,
		amountCents: data.amount ?? 0,
		currency: data.currency?.toLowerCase() || 'usd',
		paid,
		metadata,
		productName:
			metadata.productName || data.description || data.reference || 'Product',
	}
}
