import { vendorEnv } from './env.server.ts'
import {
	splitName,
	toCents,
	VendorError,
	type PrintVendor,
	type VendorAddress,
	type VendorOrderState,
} from './types.ts'

/**
 * Gelato Order API v4 (https://dashboard.gelato.com/docs/). Quotes and orders
 * carry Gelato product UIDs as SKUs; files are fetched by Gelato from our
 * signed URL. Verify request shapes against the sandbox before go-live.
 */

const BASE = 'https://order.gelatoapis.com/v4'

function key() {
	const value = vendorEnv('GELATO_API_KEY')
	if (!value)
		throw new VendorError(
			'gelato',
			'not_configured',
			'Gelato is not configured',
		)
	return value
}

/** Answers that mean the order itself was refused (content, address). */
const REJECTION_STATUSES = new Set([400, 409, 422])

async function call(path: string, init: RequestInit = {}) {
	let response: Response
	try {
		response = await fetch(`${BASE}${path}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				'X-API-KEY': key(),
				...init.headers,
			},
			signal: AbortSignal.timeout(20_000),
		})
	} catch (error) {
		if (error instanceof VendorError) throw error
		throw new VendorError('gelato', 'unavailable', 'Gelato did not answer')
	}
	const body: unknown = await response.json().catch(() => null)
	if (response.status >= 500 || response.status === 429) {
		throw new VendorError(
			'gelato',
			'unavailable',
			`Gelato answered ${response.status}`,
		)
	}
	if (!response.ok && !REJECTION_STATUSES.has(response.status)) {
		// A key, account or endpoint problem on our side (401, 403, 404...):
		// hold for a person, never refund a paid order over it.
		throw new VendorError(
			'gelato',
			'unavailable',
			`Gelato answered ${response.status}`,
		)
	}
	if (!response.ok) {
		throw new VendorError(
			'gelato',
			'rejected',
			`Gelato refused the request (${response.status})`,
			response.status,
		)
	}
	return body as Record<string, unknown>
}

function recipient(address: VendorAddress) {
	const { first, last } = splitName(address.name)
	return {
		firstName: first,
		lastName: last,
		addressLine1: address.line1,
		...(address.line2 ? { addressLine2: address.line2 } : {}),
		city: address.city,
		state: address.state,
		postCode: address.postalCode,
		country: address.country,
		phone: address.phone,
		...(address.email ? { email: address.email } : {}),
	}
}

const STATE: Record<string, VendorOrderState> = {
	created: 'submitted',
	uploading: 'submitted',
	passed: 'submitted',
	pending_approval: 'submitted',
	not_connected: 'submitted',
	on_hold: 'submitted',
	printed: 'in_production',
	in_production: 'in_production',
	shipped: 'shipped',
	in_transit: 'shipped',
	delivered: 'delivered',
	canceled: 'cancelled',
	cancelled: 'cancelled',
	failed: 'failed',
	returned: 'failed',
}

export const gelatoVendor: PrintVendor = {
	name: 'gelato',

	async quote(items, address) {
		const body = await call('/orders:quote', {
			method: 'POST',
			body: JSON.stringify({
				orderReferenceId: `quote-${Date.now()}`,
				customerReferenceId: 'print-shop',
				currency: 'USD',
				allowMultipleQuotes: false,
				recipient: recipient(address),
				products: items.map((item) => ({
					itemReferenceId: item.reference,
					productUid: item.sku,
					quantity: item.quantity,
				})),
			}),
		})
		const quote = (
			body.quotes as Array<Record<string, unknown>> | undefined
		)?.[0]
		const products = (quote?.products as Array<Record<string, unknown>>) ?? []
		const methods =
			(quote?.shipmentMethods as Array<Record<string, unknown>>) ?? []
		if (!quote || products.length === 0 || methods.length === 0) {
			throw new VendorError(
				'gelato',
				'rejected',
				'Gelato cannot ship this order',
			)
		}
		const cheapest = methods
			.map((method) => ({
				uid: String(method.shipmentMethodUid ?? ''),
				cents: toCents(method.price),
			}))
			.filter((method) => method.uid)
			.sort((a, b) => a.cents - b.cents)[0]
		if (!cheapest)
			throw new VendorError('gelato', 'rejected', 'No Gelato shipping method')
		return {
			itemsCents: products.reduce(
				(sum, product) => sum + toCents(product.price),
				0,
			),
			shippingCents: cheapest.cents,
			shippingMethod: cheapest.uid,
			currency: 'USD',
		}
	},

	async createOrder({ reference, items, address, shippingMethod }) {
		let body: Record<string, unknown>
		try {
			body = await call('/orders', {
				method: 'POST',
				body: JSON.stringify({
					orderType: 'order',
					orderReferenceId: reference,
					customerReferenceId: 'print-shop',
					currency: 'USD',
					shipmentMethodUid: shippingMethod,
					shippingAddress: recipient(address),
					items: items.map((item) => ({
						itemReferenceId: item.reference,
						productUid: item.sku,
						quantity: item.quantity,
						files: [{ type: 'default', url: item.fileUrl }],
					})),
				}),
			})
		} catch (error) {
			// Gelato has no idempotency key: a 409 on create can mean this
			// reference already exists (a retry after a timeout), so it is
			// held for a person instead of refunded as a refusal.
			if (error instanceof VendorError && error.status === 409) {
				throw new VendorError(
					'gelato',
					'unavailable',
					'Gelato reports a conflict: the order may already exist',
					409,
				)
			}
			throw error
		}
		const id = typeof body.id === 'string' ? body.id : null
		if (!id)
			throw new VendorError(
				'gelato',
				'unavailable',
				'Gelato returned no order id',
			)
		return { vendorOrderId: id }
	},

	async status(vendorOrderId) {
		const body = await call(`/orders/${encodeURIComponent(vendorOrderId)}`)
		const raw = String(body.fulfillmentStatus ?? '').toLowerCase()
		const fulfillment = (
			(body.items as Array<Record<string, unknown>> | undefined) ?? []
		)
			.flatMap(
				(item) => (item.fulfillments as Array<Record<string, unknown>>) ?? [],
			)
			.find((entry) => entry.trackingCode || entry.trackingUrl)
		return {
			state: STATE[raw] ?? 'submitted',
			carrier:
				typeof fulfillment?.shipmentMethodName === 'string'
					? fulfillment.shipmentMethodName
					: null,
			trackingNumber:
				typeof fulfillment?.trackingCode === 'string'
					? fulfillment.trackingCode
					: null,
			trackingUrl:
				typeof fulfillment?.trackingUrl === 'string'
					? fulfillment.trackingUrl
					: null,
		}
	},

	async cancel(vendorOrderId) {
		try {
			await call(`/orders/${encodeURIComponent(vendorOrderId)}:cancel`, {
				method: 'POST',
			})
			return 'cancelled'
		} catch (error) {
			if (error instanceof VendorError && error.code === 'rejected')
				return 'too_late'
			throw error
		}
	},
}
