import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
	createTestHarness,
	onboardedAccount,
	type Harness,
} from '../test-helpers'

function sessionParams(
	destination: string,
	extra: Partial<Stripe.Checkout.SessionCreateParams> = {},
) {
	return {
		mode: 'payment',
		line_items: [
			{
				price_data: {
					currency: 'usd',
					product_data: { name: 'Order' },
					unit_amount: 1200,
				},
				quantity: 1,
			},
		],
		payment_intent_data: {
			application_fee_amount: 100,
			transfer_data: { destination },
		},
		success_url: 'http://localhost:3008/done',
		...extra,
	} satisfies Stripe.Checkout.SessionCreateParams
}

async function raw(
	harness: Harness,
	method: string,
	path: string,
	body?: string,
	headers: Record<string, string> = {},
) {
	return harness.emulator.stripe.fetch(
		new Request(`https://api.stripe.com${path}`, {
			method,
			headers: {
				authorization: 'Bearer sk_test_mock_platform',
				'content-type': 'application/x-www-form-urlencoded',
				...headers,
			},
			body,
		}),
	)
}

describe('Stripe protocol fidelity (VAL-PMOCK-028)', () => {
	it('replays the stored response for the same Idempotency-Key and parameters', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const params = sessionParams(destination)
		const first = await harness.stripe.checkout.sessions.create(params, {
			idempotencyKey: 'k_same',
		})
		const second = await harness.stripe.checkout.sessions.create(params, {
			idempotencyKey: 'k_same',
		})
		expect(second.id).toBe(first.id)
		const replay = await raw(harness, 'POST', '/v1/customers', 'name=Same', {
			'idempotency-key': 'k_raw',
		})
		const again = await raw(harness, 'POST', '/v1/customers', 'name=Same', {
			'idempotency-key': 'k_raw',
		})
		expect(again.headers.get('idempotent-replayed')).toBe('true')
		expect(await again.json()).toEqual(await replay.json())
	})

	it('same key with different parameters is an idempotency_error', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		await harness.stripe.checkout.sessions.create(sessionParams(destination), {
			idempotencyKey: 'k_diff',
		})
		const error = await harness.stripe.checkout.sessions
			.create(sessionParams(destination, { metadata: { changed: 'yes' } }), {
				idempotencyKey: 'k_diff',
			})
			.catch((thrown) => thrown)
		expect(error).toBeInstanceOf(Stripe.errors.StripeIdempotencyError)
		expect(error.statusCode).toBe(400)
	})

	it('a key expires after 24 hours of mock time', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const first = await harness.stripe.checkout.sessions.create(
			sessionParams(destination),
			{ idempotencyKey: 'k_old' },
		)
		await harness.emulator.testing.advanceClock(25 * 3600)
		const second = await harness.stripe.checkout.sessions.create(
			sessionParams(destination),
			{ idempotencyKey: 'k_old' },
		)
		expect(second.id).not.toBe(first.id)
	})

	it('rejects expires_at outside the 30 minute to 24 hour window', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const now = Math.floor(harness.clock.now() / 1000)
		for (const offset of [10 * 60, 25 * 3600]) {
			const error = await harness.stripe.checkout.sessions
				.create(sessionParams(destination, { expires_at: now + offset }))
				.catch((thrown) => thrown)
			expect(error).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
			expect(error.param).toBe('expires_at')
		}
		await expect(
			harness.stripe.checkout.sessions.create(
				sessionParams(destination, { expires_at: now + 31 * 60 }),
			),
		).resolves.toMatchObject({ expires_at: now + 31 * 60 })
	})

	it('rejects a USD amount below 50 minor units', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const params = sessionParams(destination)
		params.line_items[0]!.price_data!.unit_amount = 49
		params.payment_intent_data = { transfer_data: { destination } }
		const error = await harness.stripe.checkout.sessions
			.create(params)
			.catch((thrown) => thrown)
		expect(error.code).toBe('amount_too_small')
		const intent = await harness.stripe.paymentIntents
			.create({ amount: 49, currency: 'usd' })
			.catch((thrown) => thrown)
		expect(intent.code).toBe('amount_too_small')
	})

	it('requires a charges-enabled destination for destination charges', async () => {
		const harness = createTestHarness()
		const account = await harness.stripe.accounts.create({
			type: 'express',
			country: 'US',
		})
		const notReady = await harness.stripe.checkout.sessions
			.create(sessionParams(account.id))
			.catch((thrown) => thrown)
		expect(notReady.code).toBe('transfers_not_allowed')
		const missing = await harness.stripe.checkout.sessions
			.create(sessionParams('acct_missing'))
			.catch((thrown) => thrown)
		expect(missing).toMatchObject({ code: 'resource_missing', statusCode: 404 })
	})

	it('validates setup mode, custom text and the application fee', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const setup = await harness.stripe.checkout.sessions
			.create({ mode: 'setup', success_url: 'http://localhost:3008/done' })
			.catch((thrown) => thrown)
		expect(setup.param).toBe('currency')
		const text = await harness.stripe.checkout.sessions
			.create(
				sessionParams(destination, {
					custom_text: { submit: { message: 'x'.repeat(1201) } },
				}),
			)
			.catch((thrown) => thrown)
		expect(text.code).toBe('parameter_invalid_string_length')
		const fee = sessionParams(destination)
		fee.payment_intent_data.application_fee_amount = 5_000
		expect(
			await harness.stripe.checkout.sessions
				.create(fee)
				.catch((thrown) => thrown),
		).toMatchObject({
			code: 'application_fee_amount_too_large',
		})
	})

	it('refuses unknown parameters like Stripe does', async () => {
		const harness = createTestHarness()
		const response = await raw(harness, 'POST', '/v1/customers', 'nme=Typo')
		expect(response.status).toBe(400)
		const body = (await response.json()) as {
			error: { code: string; param: string }
		}
		expect(body.error).toMatchObject({
			code: 'parameter_unknown',
			param: 'nme',
		})
	})

	it('requires a Bearer secret key', async () => {
		const harness = createTestHarness()
		const response = await harness.emulator.stripe.fetch(
			new Request('https://api.stripe.com/v1/customers', {
				method: 'POST',
				body: '',
			}),
		)
		expect(response.status).toBe(401)
	})

	it('answers 501 with a loud log for an unimplemented endpoint, never success', async () => {
		const harness = createTestHarness()
		const error = await harness.stripe.products.list().catch((thrown) => thrown)
		expect(error).toBeInstanceOf(Stripe.errors.StripeAPIError)
		expect(error.statusCode).toBe(501)
		expect(
			harness.logs.some(
				(line) => line.includes('GET /v1/products') && line.includes('501'),
			),
		).toBe(true)
		const post = await raw(harness, 'POST', '/v1/prices', 'currency=usd')
		expect(post.status).toBe(501)
	})

	it('decodes the nested form encoding the SDK sends', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await harness.stripe.checkout.sessions.create(
			sessionParams(destination, {
				line_items: [
					{
						price_data: {
							currency: 'usd',
							product_data: { name: 'A' },
							unit_amount: 600,
						},
						quantity: 2,
					},
					{
						price_data: {
							currency: 'usd',
							product_data: { name: 'B' },
							unit_amount: 100,
						},
						quantity: 1,
					},
				],
				metadata: { orderId: 'o_1' },
			}),
		)
		expect(session.amount_total).toBe(1300)
		expect(session.metadata).toEqual({ orderId: 'o_1' })
	})
})
