import crypto from 'node:crypto'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { handlePrintVendorWebhook } from '#app/utils/print/orders.server.ts'
import { type PrintVendorName } from '#app/utils/print/vendors/types.ts'

const MAX_BODY_BYTES = 64_000

function tokenMatches(presented: string | null) {
	const expected = ENV.PRINT_WEBHOOK_TOKEN?.trim() ?? ''
	if (expected.length < 32 || !presented) return false
	const a = crypto.createHash('sha256').update(presented).digest()
	const b = crypto.createHash('sha256').update(expected).digest()
	return crypto.timingSafeEqual(a, b)
}

/** Pulls the vendor's order id and event id out of its webhook body. */
function readEvent(vendor: PrintVendorName, body: Record<string, unknown>) {
	if (vendor === 'gelato') {
		return {
			eventId: typeof body.id === 'string' ? body.id : null,
			vendorOrderId: typeof body.orderId === 'string' ? body.orderId : null,
		}
	}
	// Prodigi sends CloudEvents: { id, data: { order: { id } } }.
	const data = (body.data as Record<string, unknown> | undefined) ?? {}
	const order = (data.order as Record<string, unknown> | undefined) ?? {}
	return {
		eventId: typeof body.id === 'string' ? body.id : null,
		vendorOrderId: typeof order.id === 'string' ? order.id : null,
	}
}

/**
 * Vendor webhooks for shipped prints. The URL carries a shared secret; the
 * body is only a hint (event id and vendor order id): the status itself is
 * always fetched from the vendor's API, so a forged body cannot move an order.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const vendor = params.vendor
	if (vendor !== 'gelato' && vendor !== 'prodigi') {
		return new Response('Not Found', { status: 404 })
	}
	if (!tokenMatches(new URL(request.url).searchParams.get('token'))) {
		return new Response('Forbidden', { status: 403 })
	}
	const length = Number(request.headers.get('content-length') ?? 0)
	if (length > MAX_BODY_BYTES) {
		return new Response('Payload Too Large', { status: 413 })
	}
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!body || typeof body !== 'object') {
		return new Response('Bad Request', { status: 400 })
	}
	try {
		await handlePrintVendorWebhook(vendor, readEvent(vendor, body))
	} catch (error) {
		console.error(
			`Print ${vendor} webhook failed:`,
			error instanceof Error ? error.message : error,
		)
		// Non-2xx so the vendor retries.
		return new Response('Retry later', { status: 503 })
	}
	return new Response('ok', { status: 200 })
}
