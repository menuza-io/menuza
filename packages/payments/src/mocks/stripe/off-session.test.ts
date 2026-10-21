import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
	createTestHarness,
	onboardedAccount,
	type Harness,
} from '../test-helpers'

async function savedCard(harness: Harness, card: string) {
	const customer = await harness.stripe.customers.create({
		metadata: { orgId: 'org_a', guestRef: 'g_1' },
	})
	const session = await harness.stripe.checkout.sessions.create({
		mode: 'setup',
		currency: 'usd',
		payment_method_types: ['card'],
		customer: customer.id,
		setup_intent_data: {
			metadata: { type: 'shop_payment', orgId: 'org_a' },
		},
		success_url: 'http://localhost:3008/shop/done',
		cancel_url: 'http://localhost:3008/shop',
	})
	const result = await harness.emulator.testing.completeCheckout(session.id, {
		card,
	})
	return { customer, session, result }
}

async function chargeOffSession(
	harness: Harness,
	customerId: string,
	paymentMethod: string,
) {
	const destination = await onboardedAccount(harness)
	return harness.stripe.paymentIntents.create({
		amount: 5000,
		currency: 'usd',
		customer: customerId,
		payment_method: paymentMethod,
		off_session: true,
		confirm: true,
		payment_method_types: ['card'],
		application_fee_amount: 250,
		transfer_data: { destination },
		metadata: { type: 'shop_fee', orgId: 'org_a', feeId: 'fee_1' },
	})
}

describe('Stripe setup mode and off-session charges', () => {
	it('3155: setup needs 3DS, the SetupIntent succeeds, later off-session succeeds', async () => {
		const harness = createTestHarness()
		const { customer, session, result } = await savedCard(
			harness,
			'4000002500003155',
		)
		expect(result.status).toBe('saved')
		const done = await harness.stripe.checkout.sessions.retrieve(session.id, {
			expand: ['setup_intent'],
		})
		expect(done).toMatchObject({
			status: 'complete',
			payment_status: 'no_payment_required',
		})
		const setupIntent = done.setup_intent as Stripe.SetupIntent
		expect(setupIntent.status).toBe('succeeded')
		expect(setupIntent.metadata).toEqual({
			type: 'shop_payment',
			orgId: 'org_a',
		})
		const pm = setupIntent.payment_method as string
		const methods = await harness.stripe.customers.listPaymentMethods(
			customer.id,
		)
		expect(methods.data.map((entry) => entry.id)).toEqual([pm])
		expect(methods.data[0]!.card).toMatchObject({
			brand: 'visa',
			last4: '3155',
		})
		expect(JSON.stringify(methods.data[0])).not.toContain('4000002500003155')

		const intent = await chargeOffSession(harness, customer.id, pm)
		expect(intent).toMatchObject({ status: 'succeeded', amount: 5000 })
		expect(intent.latest_charge).toMatch(/^ch_/)
	})

	it('the hosted setup page asks for 3DS before it saves the card', async () => {
		const harness = createTestHarness()
		const session = await harness.stripe.checkout.sessions.create({
			mode: 'setup',
			currency: 'usd',
			success_url: 'http://localhost:3008/done',
		})
		const first = await harness.emulator.pages.stripe.submit(session.id, {
			number: '4000002500003155',
			expiry: '12/34',
			cvc: '123',
			email: 'guest@example.test',
		})
		expect(first.status).toBe('requires_3ds')
		const done = await harness.emulator.pages.stripe.resolveThreeDS(
			(first as { attemptId: string }).attemptId,
			'complete',
		)
		expect(done.status).toBe('saved')
		const completed = await harness.stripe.checkout.sessions.retrieve(
			session.id,
		)
		expect(completed.customer).toMatch(/^cus_/)
	})

	it('manual capture holds then captures with the ledger written at capture', async () => {
		const harness = createTestHarness()
		const { customer, result } = await savedCard(harness, '4242424242424242')
		expect(result.status).toBe('saved')
		const methods = await harness.stripe.customers.listPaymentMethods(
			customer.id,
		)
		const destination = await onboardedAccount(harness)
		const held = await harness.stripe.paymentIntents.create({
			amount: 3000,
			currency: 'usd',
			customer: customer.id,
			payment_method: methods.data[0]!.id,
			off_session: true,
			confirm: true,
			capture_method: 'manual',
			application_fee_amount: 300,
			transfer_data: { destination },
		})
		expect(held.status).toBe('requires_capture')
		expect(
			(await harness.emulator.pages.stripe.ledger(destination)).transfers,
		).toHaveLength(0)
		const captured = await harness.stripe.paymentIntents.capture(held.id)
		expect(captured.status).toBe('succeeded')
		expect(
			(await harness.emulator.pages.stripe.ledger(destination)).transfers[0],
		).toMatchObject({ amount: 2700 })
		const canceled = await harness.stripe.paymentIntents.create({
			amount: 1000,
			currency: 'usd',
		})
		expect(
			(await harness.stripe.paymentIntents.cancel(canceled.id)).status,
		).toBe('canceled')
	})
})

describe('Stripe decline profiles', () => {
	it('3184: off-session throws authentication_required carrying the PaymentIntent', async () => {
		const harness = createTestHarness()
		const { customer, session, result } = await savedCard(
			harness,
			'4000002760003184',
		)
		expect(result.status).toBe('saved')
		const pm = (
			(
				await harness.stripe.checkout.sessions.retrieve(session.id, {
					expand: ['setup_intent'],
				})
			).setup_intent as Stripe.SetupIntent
		).payment_method as string
		const error = await chargeOffSession(harness, customer.id, pm).catch(
			(thrown) => thrown,
		)
		expect(error).toBeInstanceOf(Stripe.errors.StripeCardError)
		expect(error).toMatchObject({
			code: 'authentication_required',
			type: 'StripeCardError',
		})
		const intent = error.raw.payment_intent as Stripe.PaymentIntent
		expect(intent.status).toBe('requires_payment_method')
		expect(intent.last_payment_error).toMatchObject({
			code: 'authentication_required',
		})
		// The saved intent is retrievable and can be canceled (the pay-link path).
		const stored = await harness.stripe.paymentIntents.retrieve(intent.id)
		expect(stored.status).toBe('requires_payment_method')
		expect((await harness.stripe.paymentIntents.cancel(intent.id)).status).toBe(
			'canceled',
		)
	})

	it('0341: setup attaches, the later charge declines with generic_decline', async () => {
		const harness = createTestHarness()
		const { customer, session, result } = await savedCard(
			harness,
			'4000000000000341',
		)
		expect(result.status).toBe('saved')
		const pm = (
			(
				await harness.stripe.checkout.sessions.retrieve(session.id, {
					expand: ['setup_intent'],
				})
			).setup_intent as Stripe.SetupIntent
		).payment_method as string
		const error = await chargeOffSession(harness, customer.id, pm).catch(
			(thrown) => thrown,
		)
		expect(error).toBeInstanceOf(Stripe.errors.StripeCardError)
		expect(error).toMatchObject({
			code: 'card_declined',
			decline_code: 'generic_decline',
		})
	})

	it('9995: setup fails with insufficient_funds and nothing is attached', async () => {
		const harness = createTestHarness()
		const { customer, result } = await savedCard(harness, '4000000000009995')
		expect(result).toMatchObject({
			status: 'declined',
			code: 'insufficient_funds',
		})
		expect(
			(await harness.stripe.customers.listPaymentMethods(customer.id)).data,
		).toEqual([])
	})

	it('server tokens: pm_card_visa attaches; the insufficient-funds token attaches but declines to charge', async () => {
		const harness = createTestHarness()
		const customer = await harness.stripe.customers.create({})
		const visa = await harness.stripe.paymentMethods.attach('pm_card_visa', {
			customer: customer.id,
		})
		expect(visa.customer).toBe(customer.id)
		const poor = await harness.stripe.paymentMethods.attach(
			'pm_card_visa_chargeDeclinedInsufficientFunds',
			{ customer: customer.id },
		)
		const error = await chargeOffSession(harness, customer.id, poor.id).catch(
			(thrown) => thrown,
		)
		expect(error).toMatchObject({
			code: 'card_declined',
			decline_code: 'insufficient_funds',
		})
		const authRequired = await harness.stripe.paymentMethods.attach(
			'pm_card_authenticationRequired',
			{ customer: customer.id },
		)
		const authError = await chargeOffSession(
			harness,
			customer.id,
			authRequired.id,
		).catch((thrown) => thrown)
		expect(authError.code).toBe('authentication_required')
		const again = await harness.stripe.paymentMethods
			.attach(visa.id, { customer: customer.id })
			.catch((thrown) => thrown)
		expect(again.code).toBe('resource_already_exists')
	})

	it('an unattached or foreign PaymentMethod is refused for a customer charge', async () => {
		const harness = createTestHarness()
		const [first, second] = await Promise.all([
			harness.stripe.customers.create({}),
			harness.stripe.customers.create({}),
		])
		const method = await harness.stripe.paymentMethods.attach('pm_card_visa', {
			customer: first.id,
		})
		const foreign = await chargeOffSession(harness, second.id, method.id).catch(
			(thrown) => thrown,
		)
		expect(foreign).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
		expect(foreign.message).toContain('must be attached to the customer')
	})
})
