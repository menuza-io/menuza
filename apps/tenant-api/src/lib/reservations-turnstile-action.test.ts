import { RESERVATIONS_TURNSTILE_ACTION } from '@repo/reservations'
import { type Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyPublicChallenge } from './reservations-public-auth.ts'

function fakeContext(): Context {
	return {
		req: { header: () => undefined },
	} as unknown as Context
}

function stubSiteverify(action: string) {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ success: true, action, hostname: 'x.test' }),
				{
					status: 200,
				},
			),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

describe('public challenge Turnstile action', () => {
	beforeEach(() => {
		process.env.TURNSTILE_SECRET_KEY = 'unit-turnstile-secret-key'
		process.env.TURNSTILE_HOSTNAMES = ''
	})
	afterEach(() => {
		process.env.TURNSTILE_SECRET_KEY = ''
		vi.unstubAllGlobals()
	})

	it('rejects a token minted for another action', async () => {
		stubSiteverify('waitlist-join')
		expect(
			await verifyPublicChallenge(fakeContext(), 'tok', { hasCustomer: false }),
		).toBe(false)
		stubSiteverify('reservation-notify')
		expect(
			await verifyPublicChallenge(fakeContext(), 'tok', { hasCustomer: false }),
		).toBe(false)
	})

	it('accepts a token minted for the shared reservations action', async () => {
		stubSiteverify(RESERVATIONS_TURNSTILE_ACTION)
		expect(
			await verifyPublicChallenge(fakeContext(), 'tok', { hasCustomer: false }),
		).toBe(true)
	})
})
