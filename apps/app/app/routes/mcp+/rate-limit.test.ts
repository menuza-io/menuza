import { faker } from '@faker-js/faker'
import { RateLimitEntry, count, db, eq } from '@repo/database'
import { getClientIp } from '@repo/security'
import { describe, it, expect, vi } from 'vitest'
import { checkRateLimit, RATE_LIMITS } from '#app/utils/rate-limit.server.ts'

describe('Rate Limiting', () => {
	describe('Authorization Rate Limit (10 per hour per user)', () => {
		it('should allow requests within the limit', async () => {
			const userId = `auth-allow-${faker.string.uuid()}`

			for (let i = 0; i < 10; i++) {
				const result = await checkRateLimit(
					{ type: 'user', value: userId },
					RATE_LIMITS.authorization,
				)
				expect(result.allowed).toBe(true)
				expect(result.remaining).toBe(9 - i)
			}
		})

		it('should reject requests exceeding the limit', async () => {
			const userId = `auth-reject-${faker.string.uuid()}`

			// Make 10 requests (at limit)
			for (let i = 0; i < 10; i++) {
				await checkRateLimit(
					{ type: 'user', value: userId },
					RATE_LIMITS.authorization,
				)
			}

			// 11th request should be rejected
			const result = await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)
			expect(result.allowed).toBe(false)
			expect(result.remaining).toBe(0)
		})

		it('should track remaining requests correctly', async () => {
			const userId = `auth-track-${faker.string.uuid()}`

			const result1 = await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)
			expect(result1.remaining).toBe(9)

			const result2 = await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)
			expect(result2.remaining).toBe(8)

			const result3 = await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)
			expect(result3.remaining).toBe(7)
		})

		it('should isolate rate limits per user', async () => {
			const user1 = `auth-user1-${faker.string.uuid()}`
			const user2 = `auth-user2-${faker.string.uuid()}`

			// User 1 makes 5 requests
			for (let i = 0; i < 5; i++) {
				await checkRateLimit(
					{ type: 'user', value: user1 },
					RATE_LIMITS.authorization,
				)
			}

			// User 2 should still have full limit
			const result = await checkRateLimit(
				{ type: 'user', value: user2 },
				RATE_LIMITS.authorization,
			)
			expect(result.allowed).toBe(true)
			expect(result.remaining).toBe(9)
		})
	})

	describe('Token Rate Limit (20 per hour per IP)', () => {
		it('should allow requests within the limit', async () => {
			const ip = `10.0.0.${faker.number.int({ min: 1, max: 250 })}`

			for (let i = 0; i < 20; i++) {
				const result = await checkRateLimit(
					{ type: 'ip', value: ip },
					RATE_LIMITS.token,
				)
				expect(result.allowed).toBe(true)
				expect(result.remaining).toBe(19 - i)
			}
		})

		it('should reject requests exceeding the limit', async () => {
			const ip = `10.0.1.${faker.number.int({ min: 1, max: 250 })}`

			// Make 20 requests (at limit)
			for (let i = 0; i < 20; i++) {
				await checkRateLimit({ type: 'ip', value: ip }, RATE_LIMITS.token)
			}

			// 21st request should be rejected
			const result = await checkRateLimit(
				{ type: 'ip', value: ip },
				RATE_LIMITS.token,
			)
			expect(result.allowed).toBe(false)
		})

		it('should isolate rate limits per IP', async () => {
			const ip1 = `10.0.2.${faker.number.int({ min: 1, max: 125 })}`
			const ip2 = `10.0.2.${faker.number.int({ min: 126, max: 250 })}`

			// IP 1 makes 15 requests
			for (let i = 0; i < 15; i++) {
				await checkRateLimit({ type: 'ip', value: ip1 }, RATE_LIMITS.token)
			}

			// IP 2 should still have full limit
			const result = await checkRateLimit(
				{ type: 'ip', value: ip2 },
				RATE_LIMITS.token,
			)
			expect(result.allowed).toBe(true)
			expect(result.remaining).toBe(19)
		})
	})

	describe('Tool Invocation Rate Limit (1000 per hour per token)', () => {
		it('should allow requests within the limit', async () => {
			const token = `token-allow-${faker.string.uuid()}`

			// Test a sample of requests
			for (let i = 0; i < 100; i++) {
				const result = await checkRateLimit(
					{ type: 'token', value: token },
					RATE_LIMITS.toolInvocation,
				)
				expect(result.allowed).toBe(true)
			}
		})

		it('should reject requests exceeding the limit', async () => {
			const token = `token-reject-${faker.string.uuid()}`

			// Make maxRequests requests (at limit) - batch them for speed
			const batchSize = 100
			const batches = RATE_LIMITS.toolInvocation.maxRequests / batchSize
			for (let batch = 0; batch < batches; batch++) {
				await Promise.all(
					Array.from({ length: batchSize }, () =>
						checkRateLimit(
							{ type: 'token', value: token },
							RATE_LIMITS.toolInvocation,
						),
					),
				)
			}

			// (maxRequests + 1)th request should be rejected
			const result = await checkRateLimit(
				{ type: 'token', value: token },
				RATE_LIMITS.toolInvocation,
			)
			expect(result.allowed).toBe(false)
		}, 30000)

		it('should isolate rate limits per token', async () => {
			const token1 = `token1-${faker.string.uuid()}`
			const token2 = `token2-${faker.string.uuid()}`

			// Token 1 makes 500 requests - batch them for speed
			const batchSize = 100
			for (let batch = 0; batch < 5; batch++) {
				await Promise.all(
					Array.from({ length: batchSize }, () =>
						checkRateLimit(
							{ type: 'token', value: token1 },
							RATE_LIMITS.toolInvocation,
						),
					),
				)
			}

			// Token 2 should still have full limit
			const result = await checkRateLimit(
				{ type: 'token', value: token2 },
				RATE_LIMITS.toolInvocation,
			)
			expect(result.allowed).toBe(true)
			expect(result.remaining).toBe(999)
		}, 30000)
	})

	describe('getClientIp', () => {
		it('should extract IP from X-Forwarded-For header', () => {
			const request = new Request('http://localhost', {
				headers: {
					'x-forwarded-for': '203.0.113.1, 198.51.100.1',
				},
			})

			const ip = getClientIp(request)
			expect(ip).toBe('203.0.113.1')
		})

		it('should extract IP from X-Real-IP header', () => {
			const request = new Request('http://localhost', {
				headers: {
					'x-real-ip': '203.0.113.2',
				},
			})

			const ip = getClientIp(request)
			expect(ip).toBe('203.0.113.2')
		})

		it('should return fallback IP when no IP headers present', () => {
			const request = new Request('http://localhost')

			const ip = getClientIp(request)
			expect(ip).toBe('127.0.0.1')
		})

		it('should prefer X-Real-IP over X-Forwarded-For', () => {
			const request = new Request('http://localhost', {
				headers: {
					'x-forwarded-for': '203.0.113.3',
					'x-real-ip': '203.0.113.4',
				},
			})

			const ip = getClientIp(request)
			expect(ip).toBe('203.0.113.4')
		})
	})

	describe('Rate Limit Window Cleanup', () => {
		it('should clean up old entries outside the window', async () => {
			const userId = `cleanup-${faker.string.uuid()}`
			const now = Date.now()
			const keyId = `${RATE_LIMITS.authorization.scope}:user:${userId}`

			// Create an entry that's outside the window
			await db.insert(RateLimitEntry).values({
				keyId,
				keyType: 'user',
				keyValue: userId,
				createdAt: new Date(now - RATE_LIMITS.authorization.windowMs - 1000),
			})

			// Verify old entry exists
			const [countRow] = await db
				.select({ count: count() })
				.from(RateLimitEntry)
				.where(eq(RateLimitEntry.keyId, keyId))
			if (!countRow) throw new Error('Failed to count entries')
			const entryCount = countRow.count
			expect(entryCount).toBe(1)

			// Make a new request (should trigger cleanup)
			await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)

			// Old entry should be deleted
			const [countRowLater] = await db
				.select({ count: count() })
				.from(RateLimitEntry)
				.where(eq(RateLimitEntry.keyId, keyId))
			if (!countRowLater) throw new Error('Failed to count entries')
			const entryCountAfter = countRowLater.count
			expect(entryCountAfter).toBe(1) // Only the new entry
		})
	})

	describe('Rate Limit Reset Time', () => {
		it('resets a full windowMs from now when there is no prior entry', async () => {
			const userId = `reset-${faker.string.uuid()}`
			const beforeTime = Date.now()

			const result = await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)

			const afterTime = Date.now()

			// The reset time is derived from the oldest surviving entry (this
			// request's own, since there was no prior one) plus the window - not
			// `windowStart + windowMs`, which always equals `now`.
			const expectedMin = beforeTime + RATE_LIMITS.authorization.windowMs
			const expectedMax = afterTime + RATE_LIMITS.authorization.windowMs + 1000 // 1s buffer

			expect(result.resetAt.getTime()).toBeGreaterThanOrEqual(expectedMin)
			expect(result.resetAt.getTime()).toBeLessThanOrEqual(expectedMax)
		})

		it('does not report an immediate reset while a 429 is still in effect', async () => {
			const userId = `reset-denied-${faker.string.uuid()}`

			// Exhaust the limit
			for (let i = 0; i < RATE_LIMITS.authorization.maxRequests; i++) {
				await checkRateLimit(
					{ type: 'user', value: userId },
					RATE_LIMITS.authorization,
				)
			}

			const result = await checkRateLimit(
				{ type: 'user', value: userId },
				RATE_LIMITS.authorization,
			)

			expect(result.allowed).toBe(false)
			// All prior entries were inserted moments ago, so the reset should
			// still be nearly a full window away - not "now".
			const remainingMs = result.resetAt.getTime() - Date.now()
			expect(remainingMs).toBeGreaterThan(
				RATE_LIMITS.authorization.windowMs - 5000,
			)
		})
	})

	describe('Concurrent request atomicity', () => {
		it('never allows more than maxRequests when requests race', async () => {
			const userId = `concurrency-${faker.string.uuid()}`
			const config = {
				scope: 'test-concurrency',
				maxRequests: 5,
				windowMs: 60_000,
			}

			const results = await Promise.all(
				Array.from({ length: 20 }, () =>
					checkRateLimit({ type: 'user', value: userId }, config),
				),
			)

			const allowedCount = results.filter((r) => r.allowed).length
			expect(allowedCount).toBe(5)
		}, 15000)
	})

	describe('Rule namespacing (scope)', () => {
		it('does not share buckets between different rules using the same key', async () => {
			const ip = `10.0.0.${faker.number.int({ min: 1, max: 250 })}`
			const ruleA = { scope: 'test-rule-a', maxRequests: 1, windowMs: 60_000 }
			const ruleB = { scope: 'test-rule-b', maxRequests: 1, windowMs: 60_000 }

			const first = await checkRateLimit({ type: 'ip', value: ip }, ruleA)
			expect(first.allowed).toBe(true)

			// Exhaust rule A
			const second = await checkRateLimit({ type: 'ip', value: ip }, ruleA)
			expect(second.allowed).toBe(false)

			// Rule B, same IP, must still have its own full budget
			const third = await checkRateLimit({ type: 'ip', value: ip }, ruleB)
			expect(third.allowed).toBe(true)
		})

		it("does not let a short-window rule's cleanup delete a long-window rule's entries for the same key", async () => {
			const ip = `10.0.1.${faker.number.int({ min: 1, max: 250 })}`
			const shortRule = {
				scope: 'test-short-window',
				maxRequests: 100,
				windowMs: 1000, // 1 second
			}
			const longRule = {
				scope: 'test-long-window',
				maxRequests: 3,
				windowMs: 60 * 60 * 1000, // 1 hour
			}

			// Exhaust the long-window rule for this IP
			for (let i = 0; i < 3; i++) {
				await checkRateLimit({ type: 'ip', value: ip }, longRule)
			}
			const longDenied = await checkRateLimit(
				{ type: 'ip', value: ip },
				longRule,
			)
			expect(longDenied.allowed).toBe(false)

			// Exercise the short-window rule for the SAME ip; its cleanup pass
			// (which deletes entries older than *its own* 1s window) must not
			// touch the long-window rule's still-active entries.
			await checkRateLimit({ type: 'ip', value: ip }, shortRule)

			const stillDenied = await checkRateLimit(
				{ type: 'ip', value: ip },
				longRule,
			)
			expect(stillDenied.allowed).toBe(false)
		})
	})

	describe('Atomic allow decision', () => {
		it('never admits more than maxRequests across separate isolates', async () => {
			// Each `vi.resetModules()` import is a fresh module instance, like a
			// second Workers isolate: no in-memory state is shared between them.
			const isolates: Array<{ checkRateLimit: typeof checkRateLimit }> = []
			for (let i = 0; i < 4; i++) {
				vi.resetModules()
				isolates.push(await import('#app/utils/rate-limit.server.ts'))
			}
			const config = {
				scope: `atomic-${faker.string.uuid()}`,
				maxRequests: 3,
				windowMs: 60_000,
			}
			const key = { type: 'ip' as const, value: faker.internet.ipv4() }
			const results = await Promise.all(
				Array.from({ length: 12 }, (_, i) =>
					isolates[i % isolates.length]!.checkRateLimit(key, config),
				),
			)
			expect(results.filter((r) => r.allowed)).toHaveLength(3)
			const [row] = await db
				.select({ value: count() })
				.from(RateLimitEntry)
				.where(eq(RateLimitEntry.keyId, `${config.scope}:ip:${key.value}`))
			expect(row?.value).toBe(3)
		})
	})
})
