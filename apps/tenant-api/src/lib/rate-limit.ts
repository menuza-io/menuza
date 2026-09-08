import { LRUCache } from 'lru-cache'
import type { Context, Next } from 'hono'
import { ENV } from 'varlock/env'

interface RateLimitConfig {
	windowMs: number
	maxRequests: number
}

const limiters = new Map<string, LRUCache<string, number[]>>()

function getLimiter(name: string, config: RateLimitConfig) {
	if (!limiters.has(name)) {
		limiters.set(
			name,
			new LRUCache<string, number[]>({
				max: 5000,
				ttl: config.windowMs,
			}),
		)
	}
	return limiters.get(name)!
}

/**
 * Clear all rate limit caches (useful for testing or dev resets).
 */
export function resetRateLimits() {
	limiters.clear()
	globalSendTimestamps = []
}

export function rateLimit(name: string, config: RateLimitConfig) {
	const cache = getLimiter(name, config)

	return async (c: Context, next: Next) => {
		if (ENV.NODE_ENV !== 'production') {
			return await next()
		}

		// IP resolution priority for rate limiting:
		// 1. cf-connecting-ip: Set by Cloudflare edge proxy (verified)
		// 2. x-forwarded-for: First client IP if behind trusted reverse proxy
		// 3. Fallback: 'unknown'
		const forwardedFor = c.req.header('x-forwarded-for')
		const clientIpFromForwarded = forwardedFor
			? forwardedFor.split(',')[0]?.trim()
			: null
		const ip =
			c.req.header('cf-connecting-ip')?.trim() ||
			clientIpFromForwarded ||
			'unknown'

		const now = Date.now()
		const windowStart = now - config.windowMs

		let timestamps = cache.get(ip) || []
		// Filter out old timestamps
		timestamps = timestamps.filter((t) => t > windowStart)

		if (timestamps.length >= config.maxRequests) {
			const resetTime = timestamps[0]! + config.windowMs
			const retryAfter = Math.ceil((resetTime - now) / 1000)

			c.header('Retry-After', retryAfter.toString())
			c.header('X-RateLimit-Reset', new Date(resetTime).toISOString())

			return c.json(
				{
					error: 'rate_limit_exceeded',
					error_description: 'Too many requests. Please try again later.',
					retry_after: retryAfter,
				},
				429,
			)
		}

		timestamps.push(now)
		cache.set(ip, timestamps)

		await next()
	}
}

/**
 * Imperative per-key rate limiter for use inside handlers (e.g. per-phone).
 * Returns { limited: true, retryAfter } if the key has exceeded maxRequests
 * within windowMs, otherwise records the request and returns { limited: false }.
 */
export function rateLimitByKey(
	name: string,
	key: string,
	config: RateLimitConfig,
): { limited: true; retryAfter: number } | { limited: false } {
	if (ENV.NODE_ENV !== 'production') {
		return { limited: false }
	}

	const cache = getLimiter(name, config)
	const now = Date.now()
	const windowStart = now - config.windowMs

	let timestamps = cache.get(key) || []
	timestamps = timestamps.filter((t) => t > windowStart)

	if (timestamps.length >= config.maxRequests) {
		const resetTime = timestamps[0]! + config.windowMs
		const retryAfter = Math.ceil((resetTime - now) / 1000)
		return { limited: true, retryAfter }
	}

	timestamps.push(now)
	cache.set(key, timestamps)
	return { limited: false }
}

/**
 * Global send counter — caps total SMS sends across all IPs/phones
 * to prevent runaway Twilio costs. Defaults to 500/hour.
 */
const GLOBAL_SEND_WINDOW_MS = 60 * 60 * 1000 // 1 hour
export function getGlobalSendMax() {
	const raw = process.env.GLOBAL_SMS_CAP ?? ENV.GLOBAL_SMS_CAP
	if (!raw) return 500
	const parsed = Number.parseInt(String(raw), 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 500
}
let globalSendTimestamps: number[] = []

export function checkGlobalSendCap():
	{ limited: true; retryAfter: number } | { limited: false } {
	if (ENV.NODE_ENV !== 'production') {
		return { limited: false }
	}

	const now = Date.now()
	const windowStart = now - GLOBAL_SEND_WINDOW_MS

	globalSendTimestamps = globalSendTimestamps.filter((t) => t > windowStart)

	if (globalSendTimestamps.length >= getGlobalSendMax()) {
		const resetTime = globalSendTimestamps[0]! + GLOBAL_SEND_WINDOW_MS
		const retryAfter = Math.ceil((resetTime - now) / 1000)
		return { limited: true, retryAfter }
	}

	globalSendTimestamps.push(now)
	return { limited: false }
}
