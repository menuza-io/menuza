import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runInTenantOrgScope } from '@repo/tenant-db'
import {
	getGlobalSendMax,
	rateLimitByKey,
	resetRateLimits,
	resolveClientIp,
} from './rate-limit.ts'

describe('getGlobalSendMax', () => {
	const originalEnv = process.env.GLOBAL_SMS_CAP

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.GLOBAL_SMS_CAP
		} else {
			process.env.GLOBAL_SMS_CAP = originalEnv
		}
	})

	it('returns default 500 when unset', () => {
		delete process.env.GLOBAL_SMS_CAP
		expect(getGlobalSendMax()).toBe(500)
	})

	it('returns parsed integer when valid positive integer', () => {
		process.env.GLOBAL_SMS_CAP = '1000'
		expect(getGlobalSendMax()).toBe(1000)

		process.env.GLOBAL_SMS_CAP = '50'
		expect(getGlobalSendMax()).toBe(50)
	})

	it('falls back to 500 when invalid or non-positive', () => {
		process.env.GLOBAL_SMS_CAP = 'not-a-number'
		expect(getGlobalSendMax()).toBe(500)

		process.env.GLOBAL_SMS_CAP = '-10'
		expect(getGlobalSendMax()).toBe(500)

		process.env.GLOBAL_SMS_CAP = '0'
		expect(getGlobalSendMax()).toBe(500)
	})
})

describe('rateLimitByKey', () => {
	beforeEach(() => {
		resetRateLimits()
	})

	afterEach(() => {
		resetRateLimits()
	})

	it('bypasses limiting when not in production', () => {
		const config = { maxRequests: 2, windowMs: 60 * 1000 }
		expect(rateLimitByKey('test', 'user-1', config)).toEqual({ limited: false })
		expect(rateLimitByKey('test', 'user-1', config)).toEqual({ limited: false })
		expect(rateLimitByKey('test', 'user-1', config)).toEqual({ limited: false })
	})

	it('enforces limit in production mode', () => {
		const originalNodeEnv = process.env.NODE_ENV
		try {
			process.env.NODE_ENV = 'production'
			const config = { maxRequests: 2, windowMs: 60 * 1000 }
			expect(rateLimitByKey('prod-test', '+15550001', config)).toEqual({
				limited: false,
			})
			expect(rateLimitByKey('prod-test', '+15550001', config)).toEqual({
				limited: false,
			})
			const third = rateLimitByKey('prod-test', '+15550001', config)
			expect(third.limited).toBe(true)
			if (third.limited) {
				expect(third.retryAfter).toBeGreaterThan(0)
			}
		} finally {
			process.env.NODE_ENV = originalNodeEnv
		}
	})

	it('does not share a counter between Durable Object organizations', async () => {
		const originalNodeEnv = process.env.NODE_ENV
		try {
			process.env.NODE_ENV = 'production'
			const config = { maxRequests: 1, windowMs: 60 * 1000 }
			const first = await runInTenantOrgScope('org_a', () =>
				Promise.resolve(rateLimitByKey('scoped', '+15550001', config)),
			)
			const second = await runInTenantOrgScope('org_b', () =>
				Promise.resolve(rateLimitByKey('scoped', '+15550001', config)),
			)
			const third = await runInTenantOrgScope('org_a', () =>
				Promise.resolve(rateLimitByKey('scoped', '+15550001', config)),
			)
			expect(first).toEqual({ limited: false })
			expect(second).toEqual({ limited: false })
			expect(third.limited).toBe(true)
		} finally {
			process.env.NODE_ENV = originalNodeEnv
		}
	})
})

describe('resolveClientIp', () => {
	const ctx = (headers: Record<string, string>) =>
		({
			req: {
				header: (name: string) => headers[name.toLowerCase()],
			},
		}) as unknown as import('hono').Context

	it('prefers cf-connecting-ip', () => {
		expect(
			resolveClientIp(
				ctx({
					'cf-connecting-ip': '203.0.113.9',
					'x-forwarded-for': '1.1.1.1',
				}),
			),
		).toBe('203.0.113.9')
	})

	it('uses the proxy-appended (last) x-forwarded-for entry, not the spoofable first', () => {
		expect(
			resolveClientIp(ctx({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' })),
		).toBe('198.51.100.4')
	})

	it('falls back to unknown', () => {
		expect(resolveClientIp(ctx({}))).toBe('unknown')
	})

	it('counts addresses in one IPv6 /64 as the same client', () => {
		const a = resolveClientIp(
			ctx({ 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' }),
		)
		const b = resolveClientIp(
			ctx({ 'cf-connecting-ip': '2001:db8:1:2:bbbb::9' }),
		)
		const other = resolveClientIp(
			ctx({ 'cf-connecting-ip': '2001:db8:1:3::1' }),
		)
		expect(a).toBe(b)
		expect(a).not.toBe(other)
	})
})
