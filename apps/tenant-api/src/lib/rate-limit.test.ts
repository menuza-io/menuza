import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
	getGlobalSendMax,
	rateLimitByKey,
	resetRateLimits,
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
})
