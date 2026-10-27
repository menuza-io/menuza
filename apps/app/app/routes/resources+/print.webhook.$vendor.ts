import crypto from 'node:crypto'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { handlePrintVendorWebhook } from '#app/utils/print/orders.server.ts'
import { type PrintVendorName } from '#app/utils/print/vendors/types.ts'

const MAX_BODY_BYTES = 64_000
/** Ids in a vendor event are hints; anything longer is not a real id. */
const MAX_ID_LENGTH = 200

let warnedMisconfigured = false

function tokenMatches(presented: string | null) {
	const expected = ENV.PRINT_WEBHOOK_TOKEN?.trim() ?? ''
	if (expected.length < 32) {
		// Refuse every event, and say why once (not once per vendor retry).
		if (!warnedMisconfigured) {
			warnedMisconfigured = true
			console.error(
				'PRINT_WEBHOOK_TOKEN is missing or shorter than 32 characters: print vendor webhooks are refused.',
			)
		}
		return false
	}
	if (!presented) return false
	const a = crypto.createHash('sha256').update(presented).digest()
	const b = crypto.createHash('sha256').update(expected).digest()
	return crypto.timingSafeEqual(a, b)
}

const id = (value: unknown) =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
		? value
		: null

/** Pulls the vendor's order id and event id out of its webhook body. */
function readEvent(vendor: PrintVendorName, body: Record<string, unknown>) {
	if (vendor === 'gelato') {
		return { eventId: id(body.id), vendorOrderId: id(body.orderId) }
	}
	// Prodigi sends CloudEvents: { id, data: { order: { id } } }.
	const data = (body.data as Record<string, unknown> | undefined) ?? {}
	const order = (data.order as Record<string, unknown> | undefined) ?? {}
	return { eventId: id(body.id), vendorOrderId: id(order.id) }
}

/**
 * The body as text, reading at most `limit` bytes: a chunked request has no
 * Content-Length, so the cap is on the bytes actually read. Null when over.
 */
async function readCapped(request: Request, limit: number) {
	if (!request.body) return ''
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > limit) {
			await reader.cancel().catch(() => {})
			return null
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(bytes)
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
	const text = await readCapped(request, MAX_BODY_BYTES)
	if (text === null) return new Response('Payload Too Large', { status: 413 })
	let body: Record<string, unknown> | null = null
	try {
		body = JSON.parse(text) as Record<string, unknown> | null
	} catch {
		body = null
	}
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
