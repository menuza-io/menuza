import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantApiApp } from '../app.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'

/**
 * Customer loyalty calls get a per-IP burst ceiling like the other public
 * trees. Reads and writes have separate allowances, and one address never
 * spends another's. The limiter runs before the route, so no organization or
 * token is needed to reach it.
 */

const READ_CEILING = 240
const WRITE_CEILING = 120

let app: ReturnType<typeof createTenantApiApp>

function call(method: 'GET' | 'HEAD' | 'POST', path: string, ip: string) {
	return app.request(path, {
		method,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
		body: method === 'POST' ? '{}' : undefined,
	})
}

beforeEach(() => {
	app = createTenantApiApp()
	vi.stubEnv('NODE_ENV', 'production')
	resetRateLimits()
})

afterEach(() => {
	vi.unstubAllEnvs()
	resetRateLimits()
})

describe('customer loyalty IP ceiling', () => {
	it('answers 429 past the read ceiling, for that address only', async () => {
		for (let i = 0; i < READ_CEILING; i++) {
			expect(
				(await call('GET', '/loyalty/wallet', '10.7.0.1')).status,
			).not.toBe(429)
		}
		const limited = await call('GET', '/loyalty/history', '10.7.0.1')
		expect(limited.status).toBe(429)
		expect(await limited.json()).toMatchObject({
			error: 'rate_limit_exceeded',
		})
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

		// Writes keep their own allowance, and another address is unaffected.
		expect((await call('POST', '/loyalty/enroll', '10.7.0.1')).status).not.toBe(
			429,
		)
		expect((await call('GET', '/loyalty/wallet', '10.7.0.2')).status).not.toBe(
			429,
		)
	})

	it('counts HEAD and other non-POST methods as reads', async () => {
		for (let i = 0; i < READ_CEILING; i++) {
			expect(
				(await call('HEAD', '/loyalty/wallet', '10.7.2.1')).status,
			).not.toBe(429)
		}
		// The shared read allowance is spent, whatever the method.
		expect((await call('GET', '/loyalty/wallet', '10.7.2.1')).status).toBe(429)
		expect((await call('HEAD', '/loyalty/wallet', '10.7.2.1')).status).toBe(429)
		expect((await call('POST', '/loyalty/enroll', '10.7.2.1')).status).not.toBe(
			429,
		)
	})

	it('answers 429 past the write ceiling', async () => {
		for (let i = 0; i < WRITE_CEILING; i++) {
			expect(
				(await call('POST', '/loyalty/checkout/quote', '10.7.1.1')).status,
			).not.toBe(429)
		}
		const limited = await call('POST', '/loyalty/member-code', '10.7.1.1')
		expect(limited.status).toBe(429)
		expect(await limited.json()).toMatchObject({
			error: 'rate_limit_exceeded',
		})
		expect((await call('GET', '/loyalty/wallet', '10.7.1.1')).status).not.toBe(
			429,
		)
	})
})
