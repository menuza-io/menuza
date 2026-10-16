import { type Context } from 'hono'
import { type ZodTypeAny, type z } from 'zod'

/**
 * Shared request/response helpers for tenant-api routes: no-store JSON,
 * validation errors that never echo the rejected value, strict body/query
 * parsing, and typed HTTP errors.
 */
export const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function json(
	body: unknown,
	status:
		200 | 201 | 400 | 401 | 402 | 403 | 404 | 409 | 410 | 429 | 500 | 503 = 200,
) {
	return Response.json(body, { status, headers: NO_STORE })
}

/** Zod messages for these codes would echo the rejected value back. */
export const ECHOING_CODES = new Set([
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

export function readQuery<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): { data: z.infer<S> } | { error: Response } {
	const raw = Object.fromEntries(new URL(c.req.url).searchParams)
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return { error: validationResponse(parsed.error) }
	return { data: parsed.data }
}

/** Identifiers from the control plane: opaque, short, url-safe. */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export class HttpError extends Error {
	readonly status: number
	readonly code: string
	readonly details?: Record<string, unknown>

	constructor(
		status: number,
		code: string,
		message?: string,
		details?: Record<string, unknown>,
	) {
		super(message ?? code)
		this.name = 'HttpError'
		this.status = status
		this.code = code
		this.details = details
	}

	toResponse(): Response {
		return Response.json(
			{
				error: this.code,
				...(this.message && this.message !== this.code
					? { message: this.message }
					: {}),
				...(this.details ? this.details : {}),
			},
			{ status: this.status, headers: NO_STORE },
		)
	}
}

export function badRequest(
	code = 'invalid_request',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(400, code, message, details)
}

export function unauthorized(
	code = 'unauthorized',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(401, code, message, details)
}

export function paymentRequired(
	code = 'payment_required',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(402, code, message, details)
}

export function forbidden(
	code = 'forbidden',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(403, code, message, details)
}

export function notFound(
	code = 'not_found',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(404, code, message, details)
}

export function conflict(
	code = 'conflict',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(409, code, message, details)
}

export function gone(
	code = 'gone',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(410, code, message, details)
}

export function tooManyRequests(
	code = 'rate_limited',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(429, code, message, details)
}

export function serviceUnavailable(
	code = 'service_unavailable',
	message?: string,
	details?: Record<string, unknown>,
) {
	return new HttpError(503, code, message, details)
}

export function handleRouteError(error: unknown): Response {
	if (error instanceof Response) return error
	if (error instanceof HttpError) return error.toResponse()
	throw error
}
