import { type z } from 'zod'
import { requirePaymentsMock } from './gate.server.ts'

/**
 * Shared plumbing for the JSON dev control API (`/mock-payments/dev/*`).
 * Every handler starts with the gate: 404 unless the mock is on and the
 * request is local. The API is unauthenticated on purpose (dev only).
 */
export function gateDevApi(request: Request) {
	const status = requirePaymentsMock(request)
	if (!SAFE_METHODS.has(request.method)) {
		// A page open in the developer's browser must not be able to reset or
		// onboard local data: no cross-site requests, and a JSON content type
		// (which a cross-site form or `text/plain` fetch cannot send without a
		// CORS preflight this API never grants).
		rejectCrossSite(request)
		const contentType = request.headers.get('content-type') ?? ''
		if (!/^application\/json(\s*;|$)/i.test(contentType.trim())) {
			throw Response.json({ error: 'unsupported_media_type' }, { status: 415 })
		}
	}
	return status
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Browsers send `Sec-Fetch-Site`; `Origin` covers clients that do not. */
function rejectCrossSite(request: Request) {
	const site = request.headers.get('sec-fetch-site')
	if (site) {
		if (site !== 'same-origin' && site !== 'none') {
			throw Response.json({ error: 'cross_site_request' }, { status: 403 })
		}
		return
	}
	const origin = request.headers.get('origin')
	if (origin && origin !== new URL(request.url).origin) {
		throw Response.json({ error: 'cross_site_request' }, { status: 403 })
	}
}

export function methodNotAllowed() {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: { Allow: 'POST' },
	})
}

/** Parse a JSON body (empty is `{}`) against a Zod schema; 400 on a bad body. */
export async function readDevBody<Schema extends z.ZodType>(
	request: Request,
	schema: Schema,
): Promise<z.infer<Schema>> {
	const text = await request.text()
	let raw: unknown = {}
	if (text.trim()) {
		try {
			raw = JSON.parse(text)
		} catch {
			throw Response.json({ error: 'invalid_json' }, { status: 400 })
		}
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) {
		// Names the fields, never echoes the rejected values.
		throw Response.json(
			{
				error: 'invalid_body',
				fields: [
					...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
				],
			},
			{ status: 400 },
		)
	}
	return parsed.data
}

export const noStore = { 'Cache-Control': 'no-store' }
