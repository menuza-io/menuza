import { type z } from 'zod'
import { requirePaymentsMock } from './gate.server.ts'

/**
 * Shared plumbing for the JSON dev control API (`/mock-payments/dev/*`).
 * Every handler starts with the gate: 404 unless the mock is on and the
 * request is local. The API is unauthenticated on purpose (dev only).
 */
export function gateDevApi(request: Request) {
	return requirePaymentsMock(request)
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
