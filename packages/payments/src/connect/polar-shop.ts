/**
 * Polar shop helpers for tenant site commerce.
 *
 * Polar is a Merchant of Record: checkout is created on the platform Polar
 * organization (not a Stripe-Connect-style destination charge). The same 20%
 * platform / 80% tenant split is recorded on shop orders. Polar remits net
 * proceeds to the platform Polar account.
 */

import { type Polar } from '@polar-sh/sdk'
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks'

export type PolarShopCheckout = {
	id: string
	url: string
	status: string
	amountCents: number
	currency: string
	metadata: Record<string, string>
	customerEmail?: string | null
}

export type PolarShopOrder = {
	id: string
	checkoutId: string | null
	paid: boolean
	/** Refunded in full (a partial refund leaves the order paid). */
	refunded: boolean
	amountCents: number
	currency: string
	metadata: Record<string, string>
	productName: string
}

export type PolarShopProduct = {
	id: string
	name: string
}

function stringifyMetadata(
	metadata: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (value == null) continue
		result[key] = String(value).slice(0, 500)
	}
	return result
}

function metadataRecord(
	metadata: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
	if (!metadata) return {}
	return stringifyMetadata(metadata)
}

export async function createOrUpdatePolarShopProduct(
	polar: Polar,
	options: {
		productId?: string | null
		organizationId: string
		organizationName: string
		productName: string
		productDescription?: string | null
		amountCents: number
		polarOrganizationId?: string | null
	},
): Promise<PolarShopProduct> {
	const metadata = {
		type: 'shop_product',
		orgId: options.organizationId,
	}

	if (options.productId) {
		const product = await polar.products.update({
			id: options.productId,
			productUpdate: {
				name: options.productName,
				description: options.productDescription || undefined,
			},
		})
		return { id: product.id, name: product.name }
	}

	const product = await polar.products.create({
		name: options.productName,
		description: options.productDescription || undefined,
		recurringInterval: null,
		prices: [
			{
				amountType: 'fixed',
				priceAmount: options.amountCents,
				priceCurrency: 'usd',
			},
		],
		metadata,
		organizationId: options.polarOrganizationId || undefined,
	})

	return { id: product.id, name: product.name }
}

export async function createPolarShopCheckout(
	polar: Polar,
	options: {
		productId: string
		productName: string
		amountCents: number
		successUrl: string
		returnUrl: string
		metadata: Record<string, string>
		customerEmail?: string | null
		externalCustomerId?: string | null
		embedOrigin?: string | null
	},
): Promise<PolarShopCheckout> {
	const checkout = await polar.checkouts.create({
		products: [options.productId],
		prices: {
			[options.productId]: [
				{
					amountType: 'fixed',
					priceAmount: options.amountCents,
					priceCurrency: 'usd',
				},
			],
		},
		successUrl: options.successUrl,
		returnUrl: options.returnUrl,
		embedOrigin: options.embedOrigin || undefined,
		customerEmail: options.customerEmail || undefined,
		externalCustomerId: options.externalCustomerId || undefined,
		allowDiscountCodes: false,
		metadata: {
			...options.metadata,
			productName: options.productName.slice(0, 500),
		},
	})

	return {
		id: checkout.id,
		url: checkout.url,
		status: checkout.status,
		amountCents: checkout.netAmount || checkout.amount,
		currency: checkout.currency || 'usd',
		metadata: metadataRecord(checkout.metadata),
		customerEmail: checkout.customerEmail,
	}
}

export async function retrievePolarShopCheckout(
	polar: Polar,
	checkoutId: string,
): Promise<PolarShopCheckout> {
	const checkout = await polar.checkouts.get({ id: checkoutId })
	return {
		id: checkout.id,
		url: checkout.url,
		status: checkout.status,
		amountCents: checkout.netAmount || checkout.amount,
		currency: checkout.currency || 'usd',
		metadata: metadataRecord(checkout.metadata),
		customerEmail: checkout.customerEmail,
	}
}

export function polarCheckoutStatusToOrderStatus(
	status: string,
): 'paid' | 'pending' | 'failed' {
	if (status === 'succeeded') return 'paid'
	if (status === 'failed' || status === 'expired') return 'failed'
	return 'pending'
}

export function mapPolarShopOrder(order: {
	id: string
	checkoutId?: string | null
	paid?: boolean
	status?: string | null
	netAmount?: number
	totalAmount?: number
	amount?: number
	currency?: string
	metadata?: Record<string, string | number | boolean>
	product?: { name?: string | null } | null
	description?: string | null
}): PolarShopOrder {
	const metadata = metadataRecord(order.metadata)
	return {
		id: order.id,
		checkoutId: order.checkoutId ?? null,
		paid: Boolean(order.paid),
		refunded: order.status === 'refunded',
		amountCents: order.netAmount ?? order.totalAmount ?? order.amount ?? 0,
		currency: order.currency || 'usd',
		metadata,
		productName:
			metadata.productName ||
			order.product?.name ||
			order.description ||
			'Product',
	}
}

export function polarWebhookHeadersFromRequest(request: Request) {
	const names = [
		'webhook-id',
		'webhook-timestamp',
		'webhook-signature',
	] as const
	const headers: Record<string, string> = {}
	for (const name of names) {
		const value = request.headers.get(name)
		if (value) headers[name] = value
	}
	return headers
}

export function verifyPolarWebhookEvent(
	payload: string,
	headers: Record<string, string>,
	secret: string,
) {
	try {
		return validateEvent(payload, headers, secret)
	} catch (error: unknown) {
		if (error instanceof WebhookVerificationError) {
			throw new Error(
				`Polar webhook signature verification failed: ${error.message}`,
			)
		}
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to parse Polar webhook: ${message}`)
	}
}

export function getPolarDashboardUrl(server: 'sandbox' | 'production') {
	return server === 'production'
		? 'https://polar.sh/dashboard'
		: 'https://sandbox.polar.sh/dashboard'
}
