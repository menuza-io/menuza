import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
	createTestHarness,
	onboardedAccount,
	verifyStripeDelivery,
	type Harness,
} from '../test-helpers'

async function paymentSession(
	harness: Harness,
	overrides: Partial<Stripe.Checkout.SessionCreateParams> = {},
) {
	const destination = await onboardedAccount(harness)
	harness.deliveries.length = 0
	const session = await harness.stripe.checkout.sessions.create(
		{
			mode: 'payment',
			line_items: [
				{
					price_data: {
						currency: 'usd',
						product_data: { name: 'Shop order' },
						unit_amount: 2500,
					},
					quantity: 1,
				},
			],
			payment_intent_data: {
				application_fee_amount: 500,
				transfer_data: { destination },
				metadata: {
					type: 'shop_order',
					orgId: 'org_a',
					orderId: 'ord_1',
				},
			},
			success_url: 'http://localhost:3008/menu/success?order=ord_1',
			cancel_url: 'http://localhost:3008/menu',
			metadata: { type: 'shop_order', orgId: 'org_a', orderId: 'ord_1' },
			...overrides,
		},
		{ idempotencyKey: `key_${Math.random()}` },
	)
	return { session, destination }
}

describe('Stripe Checkout payment mode', () => {
	it('accepts tax codes and tax behavior on line items', async () => {
		const harness = createTestHarness()
		const session = await harness.stripe.checkout.sessions.create({
			mode: 'payment',
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: 'usd',
						unit_amount: 1200,
						tax_behavior: 'exclusive',
						product_data: { name: 'Prints', tax_code: 'txcd_99999999' },
					},
				},
			],
			success_url: 'http://localhost:3001/done',
		})
		expect(session).toMatchObject({ status: 'open', amount_total: 1200 })
	})

	it('creates an open session whose url is the mock hosted page', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		expect(session.id).toMatch(/^cs_test_/)
		expect(session.url).toBe(
			`http://localhost:3001/mock-payments/stripe/checkout/${session.id}`,
		)
		expect(session).toMatchObject({
			status: 'open',
			payment_status: 'unpaid',
			amount_total: 2500,
			currency: 'usd',
		})
		const retrieved = await harness.stripe.checkout.sessions.retrieve(
			session.id,
		)
		expect(retrieved.payment_intent).toBeNull()
	})

	it('pays with 4242: session complete, ledger consistent, signed events delivered inline', async () => {
		const harness = createTestHarness()
		const { session, destination } = await paymentSession(harness)
		const result = await harness.emulator.testing.completeCheckout(session.id)
		expect(result).toEqual({
			status: 'paid',
			redirectUrl: 'http://localhost:3008/menu/success?order=ord_1',
		})
		const done = await harness.stripe.checkout.sessions.retrieve(session.id, {
			expand: ['payment_intent'],
		})
		expect(done).toMatchObject({ status: 'complete', payment_status: 'paid' })
		const intent = done.payment_intent as Stripe.PaymentIntent
		expect(intent).toMatchObject({
			status: 'succeeded',
			amount: 2500,
			application_fee_amount: 500,
		})
		expect(intent.metadata).toEqual({
			type: 'shop_order',
			orgId: 'org_a',
			orderId: 'ord_1',
		})

		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.charges).toHaveLength(1)
		expect(ledger.transfers[0]).toMatchObject({ amount: 2000, destination })
		expect(ledger.applicationFees[0]).toMatchObject({ amount: 500 })
		const charge = ledger.charges[0]!
		expect(charge.transfer).toBe(ledger.transfers[0]!.id)

		const types = harness.deliveries.map(
			(entry) => verifyStripeDelivery(entry).type,
		)
		expect(types).toEqual(
			expect.arrayContaining([
				'payment_intent.succeeded',
				'checkout.session.completed',
			]),
		)
		expect(harness.deliveries.every((entry) => entry.status === 200)).toBe(true)
		const events = await harness.emulator.events.list({ provider: 'stripe' })
		expect(
			events.every(
				(entry) => entry.deliveredAt !== null && entry.lastStatus === 200,
			),
		).toBe(true)
	})

	it('a decline keeps the session open and carries the card error', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		const result = await harness.emulator.testing.completeCheckout(session.id, {
			card: '4000000000000002',
		})
		expect(result).toMatchObject({
			status: 'declined',
			code: 'generic_decline',
		})
		const current = await harness.stripe.checkout.sessions.retrieve(session.id)
		expect(current.status).toBe('open')
		// The guest can retry on the same session.
		const retry = await harness.emulator.testing.completeCheckout(session.id)
		expect(retry.status).toBe('paid')
	})

	it('rejects invalid input and valid non-test cards inline', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		expect(
			await harness.emulator.testing.completeCheckout(session.id, {
				card: '4242424242424241',
			}),
		).toMatchObject({ status: 'invalid', field: 'number' })
		expect(
			await harness.emulator.testing.completeCheckout(session.id, {
				expiry: '01/20',
			}),
		).toMatchObject({ status: 'invalid', field: 'expiry' })
		expect(
			await harness.emulator.testing.completeCheckout(session.id, { cvc: '1' }),
		).toMatchObject({ status: 'invalid', field: 'cvc' })
		const nonTest = await harness.emulator.testing.completeCheckout(
			session.id,
			{ card: '4111111111111111' },
		)
		expect(nonTest).toMatchObject({ status: 'declined' })
		expect((nonTest as { message: string }).message).toContain('non test card')
		expect(
			(await harness.stripe.checkout.sessions.retrieve(session.id)).status,
		).toBe('open')
	})

	it('3DS: the page asks for a challenge, completing it pays', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		const first = await harness.emulator.pages.stripe.submit(session.id, {
			number: '4000 0025 0000 3155',
			expiry: '12/34',
			cvc: '123',
		})
		expect(first.status).toBe('requires_3ds')
		const attemptId = (first as { attemptId: string }).attemptId
		expect(
			await harness.emulator.pages.stripe.describeAttempt(attemptId),
		).toMatchObject({ open: true })
		const done = await harness.emulator.pages.stripe.resolveThreeDS(
			attemptId,
			'complete',
		)
		expect(done.status).toBe('paid')
		// The challenge is single-use.
		expect(
			(
				await harness.emulator.pages.stripe.resolveThreeDS(
					attemptId,
					'complete',
				)
			).status,
		).toBe('inactive')
		expect(
			(await harness.stripe.checkout.sessions.retrieve(session.id))
				.payment_status,
		).toBe('paid')
	})

	it('3DS failure declines and leaves the session open for another card', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		const first = await harness.emulator.pages.stripe.submit(session.id, {
			number: '4000002500003155',
			expiry: '12/34',
			cvc: '123',
		})
		const result = await harness.emulator.pages.stripe.resolveThreeDS(
			(first as { attemptId: string }).attemptId,
			'fail',
		)
		expect(result).toMatchObject({
			status: 'declined',
			code: 'payment_intent_authentication_failure',
		})
		expect(
			(await harness.stripe.checkout.sessions.retrieve(session.id)).status,
		).toBe('open')
		expect(
			(await harness.emulator.testing.completeCheckout(session.id)).status,
		).toBe('paid')
	})

	it('3178 passes 3DS and then fails with insufficient funds', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		const result = await harness.emulator.testing.completeCheckout(session.id, {
			card: '4000008260003178',
		})
		expect(result).toMatchObject({
			status: 'declined',
			code: 'insufficient_funds',
		})
	})

	it('one session can be paid once even when two submissions race', async () => {
		const harness = createTestHarness()
		const { session, destination } = await paymentSession(harness)
		const results = await Promise.all([
			harness.emulator.testing.completeCheckout(session.id),
			harness.emulator.testing.completeCheckout(session.id),
		])
		expect(results.map((entry) => entry.status).sort()).toEqual([
			'inactive',
			'paid',
		])
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.charges).toHaveLength(1)
	})

	it('forced and time-based expiry close the session and emit one event', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness)
		await harness.stripe.checkout.sessions.expire(session.id)
		await harness.stripe.checkout.sessions
			.expire(session.id)
			.catch(() => undefined)
		const expired = await harness.stripe.checkout.sessions.retrieve(session.id)
		expect(expired.status).toBe('expired')
		expect(
			(await harness.emulator.testing.completeCheckout(session.id)).status,
		).toBe('inactive')
		const events = await harness.emulator.events.list({
			provider: 'stripe',
			type: 'checkout.session.expired',
		})
		expect(events).toHaveLength(1)

		const { session: later } = await paymentSession(harness)
		await harness.emulator.testing.advanceClock(25 * 60 * 60)
		expect(
			(await harness.stripe.checkout.sessions.retrieve(later.id)).status,
		).toBe('expired')
		const after = await harness.emulator.events.list({
			provider: 'stripe',
			type: 'checkout.session.expired',
		})
		expect(after).toHaveLength(2)
	})

	it('describes the hosted page content (merchant, items, active)', async () => {
		const harness = createTestHarness()
		const { session } = await paymentSession(harness, {
			custom_text: { submit: { message: 'Pay for order ord_1' } },
		})
		const view = await harness.emulator.pages.stripe.describeSession(session.id)
		expect(view).toMatchObject({
			active: true,
			merchant: { name: 'Acme Test' },
		})
		expect(view?.lineItems).toEqual([
			{
				name: 'Shop order',
				description: null,
				unit_amount: 2500,
				quantity: 1,
			},
		])
		expect(view?.session.custom_text.submit.message).toBe('Pay for order ord_1')
	})

	describe('webhook modes', () => {
		it('manual only records events; flush delivers them and redelivery is explicit', async () => {
			const harness = createTestHarness({ webhookMode: 'manual' })
			const { session } = await paymentSession(harness)
			await harness.emulator.testing.completeCheckout(session.id)
			expect(harness.deliveries).toHaveLength(0)
			const flushed = await harness.emulator.events.flush()
			expect(flushed.delivered).toBeGreaterThan(0)
			expect(harness.deliveries).toHaveLength(flushed.delivered)
			const first = (
				await harness.emulator.events.list({ provider: 'stripe' })
			)[0]!
			const again = await harness.emulator.events.redeliver('stripe', first.id)
			expect(again?.attempts).toBe(2)
			// Each attempt is freshly signed and still verifies.
			expect(verifyStripeDelivery(harness.deliveries.at(-1)!).id).toBe(first.id)
		})

		it('a 500 from the route is retried on flush', async () => {
			let status = 500
			const harness = createTestHarness({ webhookMode: 'inline' })
			harness.emulator.ctx.transport = async (delivery) => {
				harness.deliveries.push({ ...delivery, status })
				return status
			}
			const { session } = await paymentSession(harness)
			await harness.emulator.testing.completeCheckout(session.id)
			const failed = await harness.emulator.events.list({ provider: 'stripe' })
			expect(
				failed.every(
					(entry) => entry.lastStatus === 500 && entry.deliveredAt === null,
				),
			).toBe(true)
			status = 200
			const flush = await harness.emulator.events.flush()
			expect(flush.delivered).toBe(failed.length)
			const after = await harness.emulator.events.list({ provider: 'stripe' })
			expect(
				after.every(
					(entry) => entry.deliveredAt !== null && entry.attempts === 2,
				),
			).toBe(true)
		})

		it('deferred waits, then the next emulator call delivers what is due', async () => {
			const harness = createTestHarness({ webhookMode: 'deferred' })
			const { session } = await paymentSession(harness)
			await harness.emulator.testing.completeCheckout(session.id)
			expect(harness.deliveries).toHaveLength(0)
			await harness.emulator.testing.advanceClock(5)
			await harness.stripe.checkout.sessions.retrieve(session.id)
			expect(harness.deliveries.length).toBeGreaterThan(0)
			expect(harness.deliveries.every((entry) => entry.status === 200)).toBe(
				true,
			)
		})
	})
})
