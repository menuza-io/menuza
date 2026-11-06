import { type CacheControlValue, parse, format } from '@tusbar/cache-control'
import { type HeadersArgs } from 'react-router'

/**
 * A utility for handling route headers, merging common use-case headers.
 *
 * This function combines headers by:
 * 1. Forwarding headers from the route's loader or action.
 * 2. Inheriting headers from the parent.
 * 3. Falling back to parent headers (if any) when headers are missing.
 */
export function pipeHeaders({
	parentHeaders,
	loaderHeaders,
	actionHeaders,
	errorHeaders,
}: HeadersArgs) {
	const headers = new Headers()

	// get the one that's actually in use
	let currentHeaders: Headers
	if (errorHeaders !== undefined) {
		currentHeaders = errorHeaders
	} else if (loaderHeaders.entries().next().done) {
		currentHeaders = actionHeaders
	} else {
		currentHeaders = loaderHeaders
	}

	// take in useful headers route loader/action
	// pass this point currentHeaders can be ignored
	const forwardHeaders = ['Cache-Control', 'Vary', 'Server-Timing']
	for (const headerName of forwardHeaders) {
		const header = currentHeaders.get(headerName)
		if (header) {
			headers.set(headerName, header)
		}
	}

	headers.set(
		'Cache-Control',
		getConservativeCacheControl(
			parentHeaders.get('Cache-Control'),
			headers.get('Cache-Control'),
		),
	)

	// append useful parent headers
	const inheritHeaders = ['Vary', 'Server-Timing']
	for (const headerName of inheritHeaders) {
		const header = parentHeaders.get(headerName)
		if (header) {
			headers.append(headerName, header)
		}
	}

	// fallback to parent headers if loader don't have
	const fallbackHeaders = ['Cache-Control', 'Vary']
	for (const headerName of fallbackHeaders) {
		if (headers.has(headerName)) {
			continue
		}
		const fallbackHeader = parentHeaders.get(headerName)
		if (fallbackHeader) {
			headers.set(headerName, fallbackHeader)
		}
	}

	return headers
}

/**
 * Given multiple Cache-Control headers, merge them and get the most conservative one.
 */
export function getConservativeCacheControl(
	...cacheControlHeaders: Array<string | null>
): string {
	return format(
		cacheControlHeaders
			.filter((header): header is string => Boolean(header))
			.map((header) => parse(header))
			.reduce<CacheControlValue>((acc, current) => {
				for (const key in current) {
					const directive = key as keyof Required<CacheControlValue> // keyof CacheControl includes functions

					const currentValue = current[directive]

					switch (typeof currentValue) {
						case 'boolean': {
							if (currentValue) {
								acc[directive] = true as any
							}

							break
						}
						case 'number': {
							const accValue = acc[directive] as number | undefined

							if (accValue === undefined) {
								acc[directive] = currentValue as any
							} else {
								const result = Math.min(accValue, currentValue)
								acc[directive] = result as any
							}

							break
						}
					}
				}

				return acc
			}, {}),
	)
}

/**
 * Parses a Host-style value (`name` or `name:port`) and returns it normalized,
 * or null when it is anything more than a bare host: userinfo
 * (`localhost:80@evil.example`), a path, query, fragment or stray characters
 * would otherwise turn a "validated" host into a different fetch destination.
 */
function parseBareHost(
	value: string,
): { host: string; hostname: string } | null {
	const candidate = value.trim().toLowerCase()
	if (!candidate || /[\s/\\?#@]/.test(candidate)) return null
	let url: URL
	try {
		url = new URL(`http://${candidate}`)
	} catch {
		return null
	}
	if (url.username || url.password || url.host !== candidate) return null
	return { host: url.host, hostname: url.hostname.replace(/^\[|\]$/g, '') }
}

/**
 * Validates and extracts the host from a request, checking against allowed hosts.
 * Returns the validated host or null if invalid.
 *
 * Accepts localhost, 127.0.0.1, ::1, and hosts matching the BASE_URL. When the
 * forwarded host is not allowed, falls back to the request's own Host header
 * (the routed hostname on Workers), still only as a bare host.
 */
export function getValidatedHost(
	request: Request,
	baseUrl: string,
): string | null {
	const forwardedHost = request.headers.get('X-Forwarded-Host')
	const host = request.headers.get('host')
	const candidateHost = forwardedHost ?? host

	if (!candidateHost) {
		return null
	}

	const parsed = parseBareHost(candidateHost)
	if (parsed) {
		const { hostname } = parsed
		if (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '::1'
		) {
			return parsed.host
		}

		const baseUrlHost = new URL(baseUrl).hostname.toLowerCase()
		if (hostname === baseUrlHost || hostname.endsWith(`.${baseUrlHost}`)) {
			return parsed.host
		}
	}

	return host ? (parseBareHost(host)?.host ?? null) : null
}
