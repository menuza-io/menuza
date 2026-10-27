import { vendorEnv } from './env.server.ts'
import {
	toCents,
	VendorError,
	type PrintVendor,
	type VendorAddress,
	type VendorOrderState,
} from './types.ts'

/**
 * Prodigi Print API v4.0 (https://www.prodigi.com/print-api/docs/). SKUs are
 * Prodigi product SKUs; `PRODIGI_SANDBOX=true` uses the free sandbox. Verify
 * request shapes against the sandbox before go-live.
 */

function base() {
	const sandbox = ['1', 'true', 'yes'].includes(
		vendorEnv('PRODIGI_SANDBOX').toLowerCase(),
	)
	return sandbox
		? 'https://api.sandbox.prodigi.com/v4.0'
		: 'https://api.prodigi.com/v4.0'
}

function key() {
	const value = vendorEnv('PRODIGI_API_KEY')
	if (!value)
		throw new VendorError(
			'prodigi',
			'not_configured',
			'Prodigi is not configured',
		)
	return value
}

/**
 * Answers that mean the order itself was refused (content, address). A 409
 * is not one: it can mean the idempotency key already placed this order, so
 * it is held for a person rather than refunded.
 */
const REJECTION_STATUSES = new Set([400, 422])

async function call(path: string, init: RequestInit = {}) {
	let response: Response
	try {
		response = await fetch(`${base()}${path}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				'X-API-Key': key(),
				...init.headers,
			},
			signal: AbortSignal.timeout(20_000),
		})
	} catch (error) {
		if (error instanceof VendorError) throw error
		throw new VendorError('prodigi', 'unavailable', 'Prodigi did not answer')
	}
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (response.status >= 500 || response.status === 429) {
		throw new VendorError(
			'prodigi',
			'unavailable',
			`Prodigi answered ${response.status}`,
		)
	}
	if (!response.ok && !REJECTION_STATUSES.has(response.status)) {
		// A key, account or endpoint problem on our side (401, 403, 404...):
		// hold for a person, never refund a paid order over it.
		throw new VendorError(
			'prodigi',
			'unavailable',
			`Prodigi answered ${response.status}`,
		)
	}
	if (!response.ok || !body) {
		throw new VendorError(
			'prodigi',
			'rejected',
			`Prodigi refused the request (${response.status})`,
		)
	}
	return body
}

function recipient(address: VendorAddress) {
	return {
		name: address.name,
		phoneNumber: address.phone,
		...(address.email ? { email: address.email } : {}),
		address: {
			line1: address.line1,
			...(address.line2 ? { line2: address.line2 } : {}),
			postalOrZipCode: address.postalCode,
			countryCode: address.country,
			townOrCity: address.city,
			stateOrCounty: address.state,
		},
	}
}

export const prodigiVendor: PrintVendor = {
	name: 'prodigi',

	async quote(items, address) {
		const body = await call('/quotes', {
			method: 'POST',
			body: JSON.stringify({
				shippingMethod: 'Standard',
				destinationCountryCode: address.country,
				currencyCode: 'USD',
				items: items.map((item) => ({
					sku: item.sku,
					copies: item.quantity,
					attributes: {},
					assets: [{ printArea: 'default' }],
				})),
			}),
		})
		const quote = (
			body.quotes as Array<Record<string, unknown>> | undefined
		)?.[0]
		const cost = quote?.costSummary as
			Record<string, { amount?: unknown }> | undefined
		if (!quote || !cost?.items || !cost.shipping) {
			throw new VendorError(
				'prodigi',
				'rejected',
				'Prodigi cannot ship this order',
			)
		}
		return {
			itemsCents: toCents(cost.items.amount),
			shippingCents: toCents(cost.shipping.amount),
			shippingMethod: 'Standard',
			currency: 'USD',
		}
	},

	async createOrder({
		reference,
		items,
		address,
		shippingMethod,
		callbackUrl,
	}) {
		const body = await call('/Orders', {
			method: 'POST',
			body: JSON.stringify({
				merchantReference: reference,
				// Prodigi refuses a second order with the same key, so a retry
				// after a timeout cannot place the order twice.
				idempotencyKey: reference,
				shippingMethod,
				recipient: recipient(address),
				...(callbackUrl ? { callbackUrl } : {}),
				items: items.map((item) => ({
					merchantReference: item.reference,
					sku: item.sku,
					copies: item.quantity,
					sizing: 'fillPrintArea',
					assets: [{ printArea: 'default', url: item.fileUrl }],
				})),
			}),
		})
		const order = body.order as Record<string, unknown> | undefined
		const id = typeof order?.id === 'string' ? order.id : null
		// A 2xx without an id (an unexpected shape, an idempotent replay) may
		// still be an order at Prodigi: hold for a check, never refund blind.
		if (!id)
			throw new VendorError(
				'prodigi',
				'unavailable',
				'Prodigi returned no order id',
			)
		return { vendorOrderId: id }
	},

	async status(vendorOrderId) {
		const body = await call(`/orders/${encodeURIComponent(vendorOrderId)}`)
		const order = (body.order as Record<string, unknown>) ?? {}
		const status = (order.status as Record<string, unknown>) ?? {}
		const stage = String(status.stage ?? '')
		const shipments = (order.shipments as Array<Record<string, unknown>>) ?? []
		const shipment = shipments.find((entry) => entry.tracking) ?? shipments[0]
		const tracking = (shipment?.tracking as Record<string, unknown>) ?? {}
		const carrier = (shipment?.carrier as Record<string, unknown>) ?? {}
		let state: VendorOrderState = 'submitted'
		if (stage === 'Cancelled') state = 'cancelled'
		else if (stage === 'Complete') state = 'shipped'
		else if (shipments.length > 0) state = 'shipped'
		else if (stage === 'InProgress') state = 'in_production'
		const issues = (order.issues as unknown[] | undefined) ?? []
		if (stage !== 'Complete' && issues.length > 0 && stage === 'Cancelled')
			state = 'failed'
		return {
			state,
			carrier: typeof carrier.name === 'string' ? carrier.name : null,
			trackingNumber:
				typeof tracking.number === 'string' ? tracking.number : null,
			trackingUrl: typeof tracking.url === 'string' ? tracking.url : null,
		}
	},

	async cancel(vendorOrderId) {
		const body = await call(
			`/orders/${encodeURIComponent(vendorOrderId)}/actions/cancel`,
			{
				method: 'POST',
			},
		)
		return body.outcome === 'Cancelled' ? 'cancelled' : 'too_late'
	},
}
