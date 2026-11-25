import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTenantApiApp } from '../app.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'

/**
 * `POST /delivery/locations` shares the quote's limits (#161): 20 a minute per
 * client, behind the same `/delivery/*` gate as `POST /delivery/quote`. The
 * limiter is off in development and test, so this runs the gate in production
 * mode. The body is invalid on purpose: the limit answers before any lookup.
 */
describe('POST /delivery/locations rate limit', () => {
	beforeEach(() => {
		vi.stubEnv('NODE_ENV', 'production')
		resetRateLimits()
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		resetRateLimits()
	})

	it('limits the store picker at the same 20 a minute as quotes', async () => {
		const app = createTenantApiApp()
		const send = (route: string) =>
			app.request(route, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			})
		for (let i = 0; i < 20; i += 1) {
			expect((await send('/delivery/locations')).status).not.toBe(429)
		}
		expect((await send('/delivery/locations')).status).toBe(429)
		// Quotes and the picker draw on the same per-client allowance.
		expect((await send('/delivery/quote')).status).toBe(429)
	})
})
