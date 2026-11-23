import * as React from 'react'

/**
 * The page-load trace id (#385). One random id per page load: the browser
 * sends it on every same-origin request, the server writes it on its log line
 * and on a reported error, and the error page shows it so support can find the
 * request. It is random bytes only: no user, organization, address or time
 * goes into it.
 */

export const TRACE_ID_HEADER = 'x-trace-id'
/** The global the server writes before the app starts, read by the client entry. */
export const TRACE_ID_GLOBAL = '__MENUZA_TRACE_ID__'

const TRACE_ID_PATTERN = /^[a-f0-9]{16}$/

/** Sixteen lower-case hex characters (64 random bits). */
export function generateTraceId(): string {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

/**
 * The id when `value` is exactly one, else null. A client-sent value is checked
 * before it reaches a log line or a response header, so it cannot carry
 * anything else.
 */
export function parseTraceId(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim().toLowerCase()
	return TRACE_ID_PATTERN.test(trimmed) ? trimmed : null
}

/** The request's valid trace id (data requests carry the page's), or a new one. */
export function traceIdForRequest(request: Request): string {
	return parseTraceId(request.headers.get(TRACE_ID_HEADER)) ?? generateTraceId()
}

/**
 * The same request with its trace id set, so every later reader (the logger,
 * the PostHog capture, the error page) sees one value.
 */
export function withTraceId(request: Request): {
	request: Request
	traceId: string
} {
	const traceId = traceIdForRequest(request)
	if (request.headers.get(TRACE_ID_HEADER) === traceId) {
		return { request, traceId }
	}
	const headers = new Headers(request.headers)
	headers.set(TRACE_ID_HEADER, traceId)
	return { request: new Request(request, { headers }), traceId }
}

/** The script that hands the server's id to the client entry. */
export function traceIdBootstrapScript(traceId: string): string {
	const safe = parseTraceId(traceId)
	return safe ? `window.${TRACE_ID_GLOBAL}=${JSON.stringify(safe)};` : ''
}

/**
 * Adds the trace id to every same-origin request made with `fetch`, which
 * includes React Router's data requests. Other origins (the regional
 * tenant-api, third parties) are left alone: a custom header there would
 * trigger a CORS preflight. Returns the restore function.
 */
export function installTraceIdFetch(
	traceId: string,
	target: {
		fetch: typeof fetch
		location: { origin: string }
	} = globalThis as unknown as {
		fetch: typeof fetch
		location: { origin: string }
	},
): () => void {
	const original = target.fetch
	const wrapped: typeof fetch = (input, init) => {
		try {
			const url =
				typeof input === 'string'
					? new URL(input, target.location.origin)
					: input instanceof URL
						? input
						: new URL(input.url, target.location.origin)
			if (url.origin === target.location.origin) {
				const headers = new Headers(
					init?.headers ?? (input instanceof Request ? input.headers : {}),
				)
				if (!headers.has(TRACE_ID_HEADER)) {
					headers.set(TRACE_ID_HEADER, traceId)
				}
				return original(input, { ...init, headers })
			}
		} catch {
			// An address that does not parse goes through untouched.
		}
		return original(input, init)
	}
	target.fetch = wrapped
	return () => {
		target.fetch = original
	}
}

const TraceIdContext = React.createContext<string | null>(null)
export const TraceIdProvider = TraceIdContext.Provider
/** The page's trace id, or null outside a provider (tests, a standalone page). */
export function useTraceId(): string | null {
	return React.useContext(TraceIdContext)
}
