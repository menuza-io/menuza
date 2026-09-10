/**
 * IP Address Utilities
 *
 * Provides utilities for extracting client IP addresses from HTTP requests,
 * handling various proxy headers and request types.
 */

import { ENV } from './package-env.ts'

/**
 * Options for configuring IP address extraction behavior
 */
export interface GetClientIpOptions {
	/**
	 * Fallback value to return if no IP can be determined
	 * @default '127.0.0.1'
	 */
	fallback?: string
	/**
	 * Whether to return undefined instead of a fallback when IP cannot be determined
	 * @default false
	 */
	returnUndefined?: boolean
	/**
	 * Whether to trust proxy headers (X-Forwarded-For, etc.)
	 * Defaults to true unless TRUST_PROXY='false' environment variable is explicitly set
	 */
	trustProxy?: boolean
	/**
	 * Number of trusted proxy hops to strip right-to-left when parsing X-Forwarded-For
	 * @default undefined (takes leftmost IP)
	 */
	trustedProxyCount?: number
}

/**
 * Type guard to check if an object has a get method (Express-style request)
 */
function hasGetMethod(
	obj: any,
): obj is { get: (name: string) => string | undefined } {
	return typeof obj?.get === 'function'
}

/**
 * Type guard to check if an object has headers.get method (Web API Request)
 */
function hasHeadersGet(
	obj: any,
): obj is { headers: { get: (name: string) => string | null } } {
	return obj?.headers && typeof obj.headers.get === 'function'
}

/**
 * Extract client IP address from various request types and proxy headers
 *
 * This function handles both Express-style requests (with `.get()` method) and
 * Web API Requests (with `.headers.get()` method). It parses X-Forwarded-For
 * right-to-left based on trustedProxyCount to prevent client IP spoofing.
 */
export function getClientIp(
	request: any,
	options: GetClientIpOptions & { returnUndefined: true },
): string | undefined
export function getClientIp(request: any, options?: GetClientIpOptions): string
export function getClientIp(
	request: any,
	options: GetClientIpOptions = {},
): string | undefined {
	const {
		fallback = '127.0.0.1',
		returnUndefined = false,
		trustProxy = ENV.TRUST_PROXY !== false,
		trustedProxyCount = ENV.TRUSTED_PROXY_COUNT
			? Number(ENV.TRUSTED_PROXY_COUNT)
			: undefined,
	} = options

	// Handle null/undefined requests early
	if (request == null) {
		return returnUndefined ? undefined : fallback
	}

	// If proxy headers are untrusted, rely strictly on direct request connection IP
	if (!trustProxy) {
		if (request.ip) return request.ip
		if (request.socket?.remoteAddress) return request.socket.remoteAddress
		return returnUndefined ? undefined : fallback
	}

	// Helper function to get header value regardless of request type
	const getHeader = (name: string): string | null | undefined => {
		if (hasGetMethod(request)) {
			return request.get(name)
		} else if (hasHeadersGet(request)) {
			return request.headers.get(name)
		}
		return undefined
	}

	// Check provider-controlled edge headers first (Cloudflare preferred)
	const cfConnectingIp = getHeader('CF-Connecting-IP')
	if (cfConnectingIp) return cfConnectingIp

	const realIp = getHeader('X-Real-IP')
	if (realIp) return realIp

	// Parse X-Forwarded-For
	const forwarded = getHeader('X-Forwarded-For')
	if (forwarded) {
		const ips = forwarded
			.split(',')
			.map((ip) => ip.trim())
			.filter(Boolean)
		if (ips.length > 0) {
			if (typeof trustedProxyCount === 'number' && trustedProxyCount > 0) {
				const targetIndex = Math.max(0, ips.length - 1 - trustedProxyCount)
				const clientIp = ips[targetIndex]
				if (clientIp) return clientIp
			} else {
				const clientIp = ips[0]
				if (clientIp) return clientIp
			}
		}
	}

	// Try to get IP from request object directly (Express/Socket)
	if (request.ip) return request.ip
	if (request.socket?.remoteAddress) return request.socket.remoteAddress

	// No IP found, return fallback or undefined based on options
	return returnUndefined ? undefined : fallback
}
