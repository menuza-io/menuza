import {
	and,
	asc,
	count,
	db,
	eq,
	gte,
	lt,
	RateLimitEntry,
} from '@repo/database'

/**
 * Rate limiting utility for MCP OAuth endpoints
 * Implements sliding window rate limiting with database persistence
 */

export interface RateLimitConfig {
	/**
	 * Unique namespace for this specific rate-limit rule. Required so that
	 * unrelated rules (e.g. MCP token vs. forgot-password vs. translate)
	 * never share the same underlying rows for the same `RateLimitKey`
	 * `type`/`value` pair (most commonly an IP address), which would let a
	 * burst against one endpoint eat into - or reset - another endpoint's
	 * budget.
	 */
	scope: string
	maxRequests: number
	windowMs: number // Time window in milliseconds
}

export interface RateLimitKey {
	type: 'user' | 'ip' | 'token'
	value: string
}

// Rate limit configurations
// Development mode: much higher limits for testing
const isDev = process.env.NODE_ENV === 'development'

export const RATE_LIMITS = {
	authorization: {
		scope: 'mcp-authorization',
		maxRequests: isDev ? 1000 : 10,
		windowMs: 60 * 60 * 1000, // 1 hour
	},
	token: {
		scope: 'mcp-token',
		maxRequests: isDev ? 1000 : 20,
		windowMs: 60 * 60 * 1000, // 1 hour
	},
	// Explicit SSE connection limit (separate from token limits)
	sseConnection: {
		scope: 'mcp-sse-connection',
		maxRequests: isDev ? 1000 : 100,
		windowMs: 60 * 60 * 1000, // 1 hour
	},
	toolInvocation: {
		scope: 'mcp-tool-invocation',
		maxRequests: isDev ? 10000 : 1000,
		windowMs: 60 * 60 * 1000, // 1 hour
	},
} satisfies Record<string, RateLimitConfig>

/**
 * Shared rate limit for the public Sites read endpoints (by slug, by page,
 * and by host - see apps/app/app/routes/resources+/sites*.ts). These are
 * all part of the same public content surface, so they intentionally share
 * one IP-keyed bucket; defining the config once here (rather than
 * duplicating it per file) guarantees every caller uses the exact same,
 * correctly-scoped limit.
 */
export const PUBLIC_SITE_RATE_LIMIT: RateLimitConfig = {
	scope: 'sites-public',
	maxRequests: process.env.NODE_ENV === 'development' ? 1000 : 100,
	windowMs: 60 * 1000, // 1 minute
}

/**
 * Browser-initiated hosted checkout creation for restaurant orders
 * (`/resources/sites/order/checkout`). Each attempt reaches out to the regional
 * tenant service and a payment provider, so the per-IP budget is tighter than
 * the public read surface.
 */
export const RESTAURANT_ORDER_CHECKOUT_RATE_LIMIT: RateLimitConfig = {
	scope: 'restaurant-order-checkout',
	maxRequests: isDev ? 1000 : 10,
	windowMs: 60 * 1000, // 1 minute
}

/**
 * Browser polling of an order's payment status after the hosted checkout
 * redirect. Polling loops hit this every few seconds per customer.
 */
export const RESTAURANT_ORDER_STATUS_RATE_LIMIT: RateLimitConfig = {
	scope: 'restaurant-order-status',
	maxRequests: isDev ? 1000 : 60,
	windowMs: 60 * 1000, // 1 minute
}

export const SHOP_CONNECT_ONBOARDING_RATE_LIMIT: RateLimitConfig = {
	scope: 'shop-connect-onboarding',
	maxRequests: isDev ? 10 : 1,
	windowMs: 30 * 1000,
}

export const ORGANIZATION_INVITE_RATE_LIMIT: RateLimitConfig = {
	scope: 'org-send-invitations',
	maxRequests: isDev ? 1000 : 20,
	windowMs: 60 * 60 * 1000, // 1 hour
}

/**
 * Any authenticated member with menu write access could otherwise issue an
 * unbounded number of mutations (each of which also purges the site KV cache)
 * or a mass-reorder request. A per-user sliding window keeps legitimate editing
 * snappy while bounding amplification.
 */
export const MENU_MUTATION_RATE_LIMIT: RateLimitConfig = {
	scope: 'menu-mutations',
	maxRequests: isDev ? 10000 : 300,
	windowMs: 60 * 1000, // 1 minute
}

/**
 * Serialize all rate-limit checks within this process.
 *
 * The libsql client's `concurrency` option (see packages/database/src/client.ts)
 * only limits its HTTP/WebSocket transports - it has no effect on the local
 * SQLite file transport this app uses - so nothing else guarantees that two
 * overlapping "count, then insert" sequences for the same key can't race.
 * Wrapping the check in a `db.transaction()` (SQLite `BEGIN IMMEDIATE`)
 * would fix that in principle, but concurrent transactions against the
 * local file driver were found to be unstable under load in practice
 * (observed `SQLITE_IOERR` failures with a burst of concurrent callers).
 *
 * A simple in-process FIFO queue sidesteps that entirely: only one check
 * ever runs at a time per process, so no two callers can observe the same
 * pre-insert count. This matches how this app is actually deployed -
 * LiteFS elects a single writer across instances, so cross-process races
 * on this table are not a concern this function needs to solve.
 */
let rateLimitQueue: Promise<unknown> = Promise.resolve()
function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = rateLimitQueue.then(fn, fn)
	// Always resolve the queue tail, even when `fn` rejects, so one failed
	// check doesn't wedge every subsequent caller. The real outcome (success
	// or failure) still propagates to the caller via `run`.
	rateLimitQueue = run.then(
		() => undefined,
		() => undefined,
	)
	return run
}

/**
 * Check if a request should be rate limited.
 * Uses a sliding window algorithm with database persistence. See
 * `runSerialized` above for how concurrent callers are kept from racing.
 */
export async function checkRateLimit(
	key: RateLimitKey,
	config: RateLimitConfig,
): Promise<{
	allowed: boolean
	remaining: number
	resetAt: Date
}> {
	return runSerialized(async () => {
		const now = new Date()
		const windowStart = new Date(now.getTime() - config.windowMs)

		// Namespace the key by rule so unrelated rate limiters never share
		// rows, even when their `type`/`value` pairs are otherwise identical.
		const keyId = `${config.scope}:${key.type}:${key.value}`

		try {
			// Clean up old entries outside the window
			await db
				.delete(RateLimitEntry)
				.where(
					and(
						eq(RateLimitEntry.keyId, keyId),
						lt(RateLimitEntry.createdAt, windowStart),
					),
				)

			// Count requests in the current window
			const [countRow] = await db
				.select({ value: count() })
				.from(RateLimitEntry)
				.where(
					and(
						eq(RateLimitEntry.keyId, keyId),
						gte(RateLimitEntry.createdAt, windowStart),
					),
				)
			const requestCount = countRow?.value ?? 0

			// The reset time is when the *oldest* surviving entry ages out of
			// the window - not `windowStart + windowMs`, which always equals
			// `now` and would report an immediate reset even while a 429 is
			// still in effect.
			const [oldestRow] = await db
				.select({ createdAt: RateLimitEntry.createdAt })
				.from(RateLimitEntry)
				.where(
					and(
						eq(RateLimitEntry.keyId, keyId),
						gte(RateLimitEntry.createdAt, windowStart),
					),
				)
				.orderBy(asc(RateLimitEntry.createdAt))
				.limit(1)

			const allowed = requestCount < config.maxRequests
			const remaining = Math.max(0, config.maxRequests - requestCount - 1)
			const resetAt = oldestRow
				? new Date(oldestRow.createdAt.getTime() + config.windowMs)
				: new Date(now.getTime() + config.windowMs)

			// If allowed, record this request. Because every call to
			// `checkRateLimit` is serialized above, no concurrent caller for
			// the same key can have read a stale count before this insert
			// commits.
			if (allowed) {
				await db.insert(RateLimitEntry).values({
					keyId,
					keyType: key.type,
					keyValue: key.value,
				})
			}

			return { allowed, remaining, resetAt }
		} catch (error) {
			// SECURITY: Fail closed - deny request when rate limiting is unavailable
			// This prevents brute force attacks during database outages
			console.error('Rate limit check failed:', error)
			return {
				allowed: false,
				remaining: 0,
				resetAt: new Date(now.getTime() + 60000), // Retry in 1 minute
			}
		}
	})
}

/**
 * Create a rate limit error response
 */
export function createRateLimitResponse(resetAt: Date) {
	const retryAfter = Math.max(
		0,
		Math.ceil((resetAt.getTime() - Date.now()) / 1000),
	)

	return Response.json(
		{
			error: 'rate_limit_exceeded',
			error_description: 'Too many requests. Please try again later.',
			retry_after: retryAfter,
		},
		{
			status: 429,
			headers: {
				'Retry-After': retryAfter.toString(),
				'X-RateLimit-Reset': resetAt.toISOString(),
			},
		},
	)
}
