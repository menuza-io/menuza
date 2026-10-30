import { type z } from 'zod'
import { ApiError, transportError } from './api-error'
import { type HttpMethod, type HttpResponse, type HttpTransport } from './http'

export type QueryItems = Array<[string, string]>

export function buildUrl(
	base: string,
	path: string,
	query: QueryItems = [],
): string {
	const root = base.replace(/\/+$/, '')
	const url = `${root}${path.startsWith('/') ? path : `/${path}`}`
	if (query.length === 0) return url
	const search = query
		.map(
			([name, value]) =>
				`${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
		)
		.join('&')
	return `${url}?${search}`
}

export type RequestSpec = {
	method: HttpMethod
	url: string
	headers?: Record<string, string>
	json?: unknown
	timeoutMs: number
}

export type ErrorMapper = (
	status: number,
	body: string,
	response: HttpResponse,
) => ApiError

/** Sends a request; any non-2xx answer becomes an `ApiError`, any network failure a status 0 one. */
export async function performRequest(
	transport: HttpTransport,
	spec: RequestSpec,
	mapError: ErrorMapper = (status, body) => ApiError.from(status, body),
): Promise<HttpResponse> {
	const headers: Record<string, string> = { ...spec.headers }
	let body: string | undefined
	if (spec.json !== undefined) {
		body = JSON.stringify(spec.json)
		headers['Content-Type'] ??= 'application/json'
	}
	let response: HttpResponse
	try {
		response = await transport({
			method: spec.method,
			url: spec.url,
			headers,
			body,
			timeoutMs: spec.timeoutMs,
		})
	} catch (error) {
		throw transportError(error)
	}
	if (response.status < 200 || response.status >= 300) {
		throw mapError(response.status, response.body, response)
	}
	return response
}

export function unexpectedResponse(status: number, path: string): ApiError {
	return new ApiError(
		status,
		`Unexpected response from ${path}`,
		'unexpected_response',
	)
}

export function decodeResponse<Schema extends z.ZodTypeAny>(
	response: HttpResponse,
	schema: Schema,
	path: string,
): z.output<Schema> {
	let value: unknown
	try {
		value = JSON.parse(response.body)
	} catch {
		throw unexpectedResponse(response.status, path)
	}
	const parsed = schema.safeParse(value)
	if (!parsed.success) throw unexpectedResponse(response.status, path)
	return parsed.data
}
