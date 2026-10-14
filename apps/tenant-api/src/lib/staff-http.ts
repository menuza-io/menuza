import { type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'

/**
 * Small request helpers shared by the time clock routes: no-store JSON,
 * validation errors that never echo the rejected value, and strict body
 * parsing.
 */
export const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function json(body: unknown, status: 200 | 201 = 200) {
	return Response.json(body, { status, headers: NO_STORE })
}

/** Zod messages for these codes would echo the rejected value back. */
const ECHOING_CODES = new Set([
	'invalid_enum_value',
	'invalid_literal',
	'invalid_union',
	'invalid_union_discriminator',
])

export function validationBody(error: z.ZodError) {
	return {
		error: 'Invalid request',
		issues: error.issues.slice(0, 20).map((issue) => ({
			path: issue.path.join('.'),
			code: issue.code,
			...(ECHOING_CODES.has(issue.code) ? {} : { message: issue.message }),
		})),
	}
}

export function validationResponse(error: z.ZodError) {
	return Response.json(validationBody(error), {
		status: 400,
		headers: NO_STORE,
	})
}

export async function readJsonBody<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return {
			error: Response.json(
				{ error: 'Invalid JSON body' },
				{ status: 400, headers: NO_STORE },
			),
		}
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return { error: validationResponse(parsed.error) }
	return { data: parsed.data }
}

/** Identifiers from the control plane: opaque, short, url-safe. */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
