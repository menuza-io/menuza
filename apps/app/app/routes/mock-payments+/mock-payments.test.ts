import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as ckoHppLoader } from './checkout-com.hpp.$hppId.tsx'
import { loader as dashboardLoader } from './dashboard.tsx'
import { action as clockAction } from './dev.clock.advance.ts'
import { action as flushAction } from './dev.events.flush.ts'
import { loader as eventsLoader } from './dev.events.ts'
import { loader as objectLoader } from './dev.objects.$provider.$id.ts'
import { action as onboardAction } from './dev.onboard.ts'
import { action as resetAction } from './dev.reset.ts'
import { loader as stripeCheckoutLoader } from './stripe.checkout.$sessionId.tsx'

function args(
	path: string,
	init?: RequestInit,
	params: Record<string, string> = {},
) {
	return {
		request: new Request(`http://localhost:3001${path}`, init),
		params,
		context: new RouterContextProvider(),
		unstable_pattern: path,
	} as never
}

async function settle(run: () => unknown) {
	try {
		const result = (await run()) as Response
		return result
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

const post = (body: unknown = {}, headers: Record<string, string> = {}) => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json', ...headers },
	body: JSON.stringify(body),
})

describe('mock routes with the mock off', () => {
	beforeEach(() => {
		vi.stubEnv('MOCKS', '')
		vi.stubEnv('PAYMENTS_MOCK', '')
	})
	afterEach(() => vi.unstubAllEnvs())

	it('every route answers 404', async () => {
		const results = await Promise.all([
			settle(() => dashboardLoader(args('/mock-payments/dashboard'))),
			settle(() =>
				stripeCheckoutLoader(
					args('/mock-payments/stripe/checkout/x', undefined, {
						sessionId: 'x',
					}),
				),
			),
			settle(() =>
				ckoHppLoader(
					args('/mock-payments/checkout-com/hpp/x', undefined, { hppId: 'x' }),
				),
			),
			settle(() => eventsLoader(args('/mock-payments/dev/events'))),
			settle(() =>
				onboardAction(
					args(
						'/mock-payments/dev/onboard',
						post({ orgSlug: 'acme', provider: 'stripe' }),
					),
				),
			),
			settle(() => resetAction(args('/mock-payments/dev/reset', post()))),
			settle(() =>
				flushAction(args('/mock-payments/dev/events/flush', post())),
			),
			settle(() =>
				objectLoader(
					args('/mock-payments/dev/objects/stripe/x', undefined, {
						provider: 'stripe',
						id: 'x',
					}),
				),
			),
		])
		expect(results.map((response) => response.status)).toEqual(
			Array(results.length).fill(404),
		)
	})

	it('PAYMENTS_MOCK=false beats MOCKS=true', async () => {
		vi.stubEnv('MOCKS', 'true')
		vi.stubEnv('PAYMENTS_MOCK', 'false')
		expect(
			(await settle(() => eventsLoader(args('/mock-payments/dev/events'))))
				.status,
		).toBe(404)
		expect(
			(
				await settle(() =>
					eventsLoader(args('/mock-payments/dev/events', post())),
				)
			).status,
		).toBe(404)
	})
})

describe('dev control API with the mock on', () => {
	beforeEach(() => {
		vi.stubEnv('MOCKS', 'true')
		vi.stubEnv('PAYMENTS_MOCK', '')
		vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_***')
		vi.stubEnv('CHECKOUT_SECRET_KEY', '')
	})
	afterEach(() => vi.unstubAllEnvs())

	it('resets, lists events, reads objects and moves the clock', async () => {
		expect(
			(
				await settle(() =>
					resetAction(args('/mock-payments/dev/reset', post())),
				)
			).status,
		).toBe(200)
		const events = await settle(() =>
			eventsLoader(args('/mock-payments/dev/events?provider=stripe')),
		)
		expect(events.status).toBe(200)
		expect(await events.json()).toEqual([])
		expect(
			(
				await settle(() =>
					eventsLoader(args('/mock-payments/dev/events?provider=nope')),
				)
			).status,
		).toBe(400)

		const missing = await settle(() =>
			objectLoader(
				args('/x', undefined, { provider: 'stripe', id: 'cs_nope' }),
			),
		)
		expect(missing.status).toBe(404)
		const clock = await settle(() =>
			clockAction(args('/x', post({ seconds: 60 }))),
		)
		expect(clock.status).toBe(200)
		expect(
			((await clock.json()) as { offsetMs: number }).offsetMs,
		).toBeGreaterThanOrEqual(60_000)
		expect(
			(await settle(() => clockAction(args('/x', post({ seconds: 'soon' })))))
				.status,
		).toBe(400)
	})

	it('serves a hosted page for a real session and answers 405 to a GET on a POST route', async () => {
		const response = await settle(() =>
			stripeCheckoutLoader(
				args('/x', undefined, { sessionId: 'cs_test_missing' }),
			),
		)
		expect(response.status).toBe(404)
		const wrongMethod = await settle(() =>
			onboardAction(args('/x', { method: 'GET' })),
		)
		expect(wrongMethod.status).toBe(405)
	})

	it('rejects an invalid onboarding body without echoing it', async () => {
		const response = await settle(() =>
			onboardAction(
				args('/x', post({ orgSlug: 'acme', provider: 'sekret-value' })),
			),
		)
		expect(response.status).toBe(400)
		const body = JSON.stringify(await response.json())
		expect(body).not.toContain('sekret-value')
	})

	it('refuses a state-changing request that is not JSON or comes from another site', async () => {
		const seedClock = () => clockAction(args('/x', post({ seconds: 60 })))
		const before = (await (await settle(seedClock)).json()) as {
			offsetMs: number
		}
		const attempts: Array<RequestInit & { expect: number }> = [
			// A cross-site form or `text/plain` fetch cannot set a JSON type.
			{
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: JSON.stringify({ seconds: 3600 }),
				expect: 415,
			},
			{ method: 'POST', body: JSON.stringify({ seconds: 3600 }), expect: 415 },
			{
				...post({ seconds: 3600 }, { 'Sec-Fetch-Site': 'cross-site' }),
				expect: 403,
			},
			{
				...post({ seconds: 3600 }, { 'Sec-Fetch-Site': 'same-site' }),
				expect: 403,
			},
			{
				...post({ seconds: 3600 }, { Origin: 'https://evil.example' }),
				expect: 403,
			},
		]
		for (const { expect: status, ...init } of attempts) {
			const response = await settle(() => clockAction(args('/x', init)))
			expect(response.status).toBe(status)
		}
		// The clock did not move (only the final 1 s call above did).
		const after = (await (
			await settle(() => clockAction(args('/x', post({ seconds: 1 }))))
		).json()) as { offsetMs: number }
		expect(after.offsetMs).toBe(before.offsetMs + 1000)

		// Same-origin browser calls, direct tools and a JSON charset all work.
		for (const headers of [
			{ 'Sec-Fetch-Site': 'same-origin' },
			{ 'Sec-Fetch-Site': 'none' },
			{ Origin: 'http://localhost:3001' },
			{ 'Content-Type': 'application/json; charset=utf-8' },
		] as Array<Record<string, string>>) {
			expect(
				(
					await settle(() =>
						resetAction(args('/mock-payments/dev/reset', post({}, headers))),
					)
				).status,
			).toBe(200)
		}
	})
})
