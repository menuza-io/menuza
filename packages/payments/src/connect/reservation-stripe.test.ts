import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
	createTestHarness,
	onboardedAccount,
	type Harness,
} from '../mocks/test-helpers'
import {
	buildReservationFeeIdempotencyKey,
	buildReservationFeeMetadata,
	buildReservationPaymentMetadata,
	buildReservationRefundIdempotencyKey,
	buildReservationRefundMetadata,
	buildReservationSessionIdempotencyKey,
	reservationStripeExpiresAt,
} from '../shop/reservation'
import {
	cancelReservationPaymentIntent,
	chargeReservationFeeOffSession,
	createReservationPaymentSession,
	createReservationSetupSession,
	createReservationStripeCustomer,
	createReservationStripeRefund,
	isStripeTransientError,
	mapStripeDisputeToReservation,
	mapStripeRefundToReservation,
	mapStripeSessionToReservationPayment,
	retrieveReservationStripeRefund,
	retrieveReservationStripeSession,
	stripeErrorCode,
} from './reservation-stripe'

const ORG = 'org_a'
const RSV = 'rsv_1'

function sessionInput(
	harness: Harness,
	destination: string,
	overrides: Partial<
		Parameters<typeof createReservationPaymentSession>[1]
	> = {},
) {
	const paymentExpiresAt = new Date(
		harness.clock.now() + 20 * 60_000,
	).toISOString()
	return {
		connectedAccountId: destination,
		productName: 'Reservation deposit',
		amountMinor: 3333,
		currency: 'usd',
		platformFeeMinor: 49,
		successUrl: 'http://localhost:3008/reserve/pay/done?r=rsv_1',
		cancelUrl: 'http://localhost:3008/reserve/pay',
		expiresAt: reservationStripeExpiresAt(
			harness.clock.now(),
			paymentExpiresAt,
		),
		statementDescriptorSuffix: 'ACME GRILL',
		idempotencyKey: buildReservationSessionIdempotencyKey({
			orgId: ORG,
			reservationId: RSV,
			purpose: 'deposit',
			amountMinor: 3333,
			currency: 'USD',
			paymentExpiresAt,
		}),
		metadata: buildReservationPaymentMetadata({
			orgId: ORG,
			reservationId: RSV,
			purpose: 'deposit',
		}),
		...overrides,
	}
}

async function paidDeposit(harness: Harness, card = '4242424242424242') {
	const destination = await onboardedAccount(harness)
	const session = await createReservationPaymentSession(
		harness.stripe,
		sessionInput(harness, destination),
	)
	await harness.emulator.testing.completeCheckout(session.id, { card })
	const done = await harness.stripe.checkout.sessions.retrieve(session.id)
	return { destination, session, intent: done.payment_intent as string }
}

describe('reservation payment sessions on the Stripe emulator', () => {
	it('creates a destination charge with the platform fee floor and opaque metadata (VAL-PAY-005, VAL-PAY-007)', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await createReservationPaymentSession(
			harness.stripe,
			sessionInput(harness, destination),
		)
		expect(session).toMatchObject({
			mode: 'payment',
			status: 'open',
			amount_total: 3333,
			currency: 'usd',
		})
		expect(session.customer_email ?? null).toBeNull()
		expect(session.metadata).toEqual({
			type: 'reservation_payment',
			orgId: ORG,
			reservationId: RSV,
			purpose: 'deposit',
		})
		const result = await harness.emulator.testing.completeCheckout(session.id)
		expect(result.status).toBe('paid')
		const done = await harness.stripe.checkout.sessions.retrieve(session.id, {
			expand: ['payment_intent'],
		})
		const intent = done.payment_intent as Stripe.PaymentIntent
		// floor(3333 * 150 / 10000) = 49; the transfer is the rest.
		expect(intent).toMatchObject({
			amount: 3333,
			application_fee_amount: 49,
			payment_method_types: ['card'],
		})
		expect(intent.metadata).toEqual(session.metadata)
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.applicationFees[0]).toMatchObject({ amount: 49 })
		expect(ledger.transfers[0]).toMatchObject({
			amount: 3333 - 49,
			destination,
		})

		const event = mapStripeSessionToReservationPayment(done)
		expect(event).toEqual({
			orgId: ORG,
			reservationId: RSV,
			feeId: null,
			purpose: 'deposit',
			sessionId: session.id,
			processor: 'stripe',
			status: 'paid',
			amountMinor: 3333,
			currency: 'USD',
			paymentRef: intent.id,
			paymentMethodRef: null,
			providerCustomerRef: null,
			previousPaymentRef: null,
			card: null,
		})
	})

	it('sends no application fee at 0 bp and a per-cover line item when the quote prices covers', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await createReservationPaymentSession(
			harness.stripe,
			sessionInput(harness, destination, {
				platformFeeMinor: 0,
				amountMinor: 6000,
				quantity: 4,
				unitAmountMinor: 1500,
				idempotencyKey: 'key_cover',
			}),
		)
		await harness.emulator.testing.completeCheckout(session.id)
		const done = await harness.stripe.checkout.sessions.retrieve(session.id, {
			expand: ['payment_intent'],
		})
		expect(
			(done.payment_intent as Stripe.PaymentIntent).application_fee_amount,
		).toBeNull()
		expect(done.amount_total).toBe(6000)
	})

	it('replays the same session for the same idempotency key', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const input = sessionInput(harness, destination)
		const first = await createReservationPaymentSession(harness.stripe, input)
		const second = await createReservationPaymentSession(harness.stripe, input)
		expect(second.id).toBe(first.id)
	})

	it('maps a failed async payment, an expired session and an unpaid session', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await createReservationPaymentSession(
			harness.stripe,
			sessionInput(harness, destination),
		)
		const open = await retrieveReservationStripeSession(
			harness.stripe,
			session.id,
		)
		expect(mapStripeSessionToReservationPayment(open)?.status).toBe('pending')
		expect(
			mapStripeSessionToReservationPayment(open, { failed: true })?.status,
		).toBe('failed')
		await harness.stripe.checkout.sessions.expire(session.id)
		const expired = await retrieveReservationStripeSession(
			harness.stripe,
			session.id,
		)
		expect(mapStripeSessionToReservationPayment(expired)?.status).toBe(
			'expired',
		)
	})

	it('ignores sessions that are not reservations', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await createReservationPaymentSession(
			harness.stripe,
			sessionInput(harness, destination, {
				metadata: { type: 'restaurant_order', orgId: ORG, orderId: 'o' },
				idempotencyKey: 'key_other',
			}),
		)
		expect(mapStripeSessionToReservationPayment(session)).toBeNull()
	})

	it('a fee pay link carries the fee metadata and maps the fee id', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await createReservationPaymentSession(
			harness.stripe,
			sessionInput(harness, destination, {
				productName: 'No-show fee',
				metadata: buildReservationFeeMetadata({
					orgId: ORG,
					reservationId: RSV,
					feeId: 'fee_1',
				}),
				idempotencyKey: 'key_fee_link',
			}),
		)
		await harness.emulator.testing.completeCheckout(session.id)
		const done = await retrieveReservationStripeSession(
			harness.stripe,
			session.id,
		)
		expect(mapStripeSessionToReservationPayment(done)).toMatchObject({
			purpose: 'fee',
			feeId: 'fee_1',
			status: 'paid',
		})
	})
})

describe('reservation card guarantees (setup mode)', () => {
	async function guaranteeSession(harness: Harness) {
		const customerId = await createReservationStripeCustomer(harness.stripe, {
			orgId: ORG,
			guestRef: 'guest_ref_abcdef',
		})
		const session = await createReservationSetupSession(harness.stripe, {
			customerId,
			currency: 'USD',
			successUrl: 'http://localhost:3008/reserve/pay/done',
			cancelUrl: 'http://localhost:3008/reserve/pay',
			expiresAt: reservationStripeExpiresAt(
				harness.clock.now(),
				new Date(harness.clock.now() + 20 * 60_000).toISOString(),
			),
			consentText: 'Consent text with amounts only.',
			idempotencyKey: 'key_setup',
			metadata: buildReservationPaymentMetadata({
				orgId: ORG,
				reservationId: RSV,
				purpose: 'guarantee',
			}),
		})
		return { customerId, session }
	}

	it('the Customer is PII-free and idempotent per (org, guest) (VAL-PAY-008)', async () => {
		const harness = createTestHarness()
		const first = await createReservationStripeCustomer(harness.stripe, {
			orgId: ORG,
			guestRef: 'guest_ref_abcdef',
		})
		const again = await createReservationStripeCustomer(harness.stripe, {
			orgId: ORG,
			guestRef: 'guest_ref_abcdef',
		})
		expect(again).toBe(first)
		const other = await createReservationStripeCustomer(harness.stripe, {
			orgId: 'org_b',
			guestRef: 'guest_ref_abcdef',
		})
		expect(other).not.toBe(first)
		const customer = (await harness.stripe.customers.retrieve(
			first,
		)) as Stripe.Customer
		expect(customer.metadata).toEqual({
			orgId: ORG,
			guestRef: 'guest_ref_abcdef',
		})
		expect(customer.email ?? null).toBeNull()
		expect(customer.name ?? null).toBeNull()
		expect(customer.phone ?? null).toBeNull()
	})

	it('3155 passes 3DS, saves the card and maps customer, method and card facts (VAL-PAY-008)', async () => {
		const harness = createTestHarness()
		const { customerId, session } = await guaranteeSession(harness)
		expect(session).toMatchObject({ mode: 'setup', status: 'open' })
		const result = await harness.emulator.testing.completeCheckout(session.id, {
			card: '4000002500003155',
		})
		expect(result.status).toBe('saved')
		const done = await retrieveReservationStripeSession(
			harness.stripe,
			session.id,
			{
				setup: true,
			},
		)
		const event = mapStripeSessionToReservationPayment(done)
		expect(event).toMatchObject({
			purpose: 'guarantee',
			status: 'setup_succeeded',
			amountMinor: 0,
			currency: 'USD',
			providerCustomerRef: customerId,
			card: { brand: 'visa', last4: '3155' },
		})
		expect(event?.paymentMethodRef).toMatch(/^pm_/)
		expect(JSON.stringify(event)).not.toContain('4000002500003155')
	})

	it('9995 fails the setup: the session stays pending and nothing is saved (VAL-PAY-008)', async () => {
		const harness = createTestHarness()
		const { session } = await guaranteeSession(harness)
		const result = await harness.emulator.testing.completeCheckout(session.id, {
			card: '4000000000009995',
		})
		expect(result).toMatchObject({ status: 'declined' })
		const open = await retrieveReservationStripeSession(
			harness.stripe,
			session.id,
			{
				setup: true,
			},
		)
		expect(mapStripeSessionToReservationPayment(open)?.status).toBe('pending')
	})
})

describe('off-session fee charges (VAL-PAY-009, VAL-PAY-010)', () => {
	async function savedCard(harness: Harness, card: string) {
		const customerId = await createReservationStripeCustomer(harness.stripe, {
			orgId: ORG,
			guestRef: `guest_ref_${card}`,
		})
		const session = await createReservationSetupSession(harness.stripe, {
			customerId,
			currency: 'USD',
			successUrl: 'http://localhost:3008/done',
			cancelUrl: 'http://localhost:3008/cancel',
			expiresAt: reservationStripeExpiresAt(
				harness.clock.now(),
				new Date(harness.clock.now() + 20 * 60_000).toISOString(),
			),
			consentText: 'Consent',
			idempotencyKey: `key_${card}`,
			metadata: buildReservationPaymentMetadata({
				orgId: ORG,
				reservationId: RSV,
				purpose: 'guarantee',
			}),
		})
		await harness.emulator.testing.completeCheckout(session.id, { card })
		const done = await retrieveReservationStripeSession(
			harness.stripe,
			session.id,
			{
				setup: true,
			},
		)
		const event = mapStripeSessionToReservationPayment(done)!
		return { customerId, paymentMethodId: event.paymentMethodRef! }
	}

	function charge(
		harness: Harness,
		destination: string,
		saved: { customerId: string; paymentMethodId: string },
		attempt = 1,
	) {
		return chargeReservationFeeOffSession(harness.stripe, {
			connectedAccountId: destination,
			...saved,
			amountMinor: 5000,
			currency: 'USD',
			platformFeeMinor: 75,
			statementDescriptorSuffix: 'ACME GRILL',
			idempotencyKey: buildReservationFeeIdempotencyKey({
				orgId: ORG,
				reservationId: RSV,
				feeId: 'fee_1',
				attempt,
			}),
			metadata: buildReservationFeeMetadata({
				orgId: ORG,
				reservationId: RSV,
				feeId: 'fee_1',
			}),
		})
	}

	it('3155: the saved card is charged and the destination gets the net (VAL-PAY-009)', async () => {
		const harness = createTestHarness()
		const saved = await savedCard(harness, '4000002500003155')
		const destination = await onboardedAccount(harness)
		const outcome = await charge(harness, destination, saved)
		expect(outcome.status).toBe('succeeded')
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.applicationFees[0]).toMatchObject({ amount: 75 })
		// Same attempt replays the same PaymentIntent (no double charge).
		const replay = await charge(harness, destination, saved)
		expect(replay).toEqual(outcome)
	})

	it('3184: authentication_required reports requires_action and the dangling intent cancels (VAL-PAY-010)', async () => {
		const harness = createTestHarness()
		const saved = await savedCard(harness, '4000002760003184')
		const destination = await onboardedAccount(harness)
		const outcome = await charge(harness, destination, saved)
		expect(outcome).toMatchObject({
			status: 'requires_action',
			danglingPaymentIntentId: expect.stringMatching(/^pi_/),
		})
		const id = (outcome as { danglingPaymentIntentId: string })
			.danglingPaymentIntentId
		await cancelReservationPaymentIntent(harness.stripe, id)
		expect((await harness.stripe.paymentIntents.retrieve(id)).status).toBe(
			'canceled',
		)
	})

	it('0341: the decline carries the decline code (VAL-PAY-010)', async () => {
		const harness = createTestHarness()
		const saved = await savedCard(harness, '4000000000000341')
		const destination = await onboardedAccount(harness)
		const outcome = await charge(harness, destination, saved)
		expect(outcome).toMatchObject({
			status: 'failed',
			declineCode: 'generic_decline',
		})
	})

	it('a retry with the next attempt uses a new key; other errors are not reported as a decline', async () => {
		const harness = createTestHarness()
		const saved = await savedCard(harness, '4242424242424242')
		const destination = await onboardedAccount(harness)
		await expect(
			charge(
				harness,
				destination,
				{ ...saved, paymentMethodId: 'pm_missing' },
				9,
			),
		).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
		const first = await charge(harness, destination, saved, 1)
		const second = await charge(harness, destination, saved, 2)
		expect(first.status).toBe('succeeded')
		expect((second as { paymentRef: string }).paymentRef).not.toBe(
			(first as { paymentRef: string }).paymentRef,
		)
	})

	it('transient failures are rethrown, never mapped to an outcome', async () => {
		const failing = new Stripe('sk_test_mock', {
			apiVersion: '2025-08-27.basil',
			maxNetworkRetries: 0,
			httpClient: Stripe.createFetchHttpClient(async () => {
				throw new TypeError('network down')
			}),
		})
		const error = await chargeReservationFeeOffSession(failing, {
			connectedAccountId: 'acct_1',
			customerId: 'cus_1',
			paymentMethodId: 'pm_1',
			amountMinor: 500,
			currency: 'USD',
			platformFeeMinor: 0,
			idempotencyKey: 'k',
			metadata: {},
		}).catch((thrown) => thrown)
		expect(error).toBeInstanceOf(Stripe.errors.StripeConnectionError)
		expect(isStripeTransientError(error)).toBe(true)
		expect(stripeErrorCode(error)).toBeTruthy()
		expect(
			isStripeTransientError(
				new Stripe.errors.StripeCardError({
					message: 'x',
					type: 'card_error',
				} as never),
			),
		).toBe(false)
	})
})

describe('reservation refunds (VAL-PAY-011)', () => {
	function refund(
		harness: Harness,
		intent: string,
		amountMinor: number,
		requestId: string,
	) {
		return createReservationStripeRefund(harness.stripe, {
			paymentIntentId: intent,
			amountMinor,
			idempotencyKey: buildReservationRefundIdempotencyKey({
				orgId: ORG,
				refundRequestId: requestId,
			}),
			metadata: buildReservationRefundMetadata({
				orgId: ORG,
				reservationId: RSV,
				refundRequestId: requestId,
			}),
		})
	}

	it('reverses the transfer and the fee; partial fee reversals add up (sums to 333)', async () => {
		const harness = createTestHarness()
		const destination = await onboardedAccount(harness)
		const session = await createReservationPaymentSession(
			harness.stripe,
			sessionInput(harness, destination, {
				amountMinor: 3333,
				platformFeeMinor: 333,
				idempotencyKey: 'key_refund',
			}),
		)
		await harness.emulator.testing.completeCheckout(session.id)
		const intent = (await harness.stripe.checkout.sessions.retrieve(session.id))
			.payment_intent as string
		const first = await refund(harness, intent, 1667, 'rr_1')
		const second = await refund(harness, intent, 1666, 'rr_2')
		expect(first).toMatchObject({ status: 'succeeded', amountMinor: 1667 })
		expect(second.status).toBe('succeeded')
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		// Stripe splits the reversal itself; the parts differ by at most one and
		// always add up to the snapshot (the regional directive says 167 then 166).
		const parts = ledger.feeRefunds.map((entry) => entry.amount)
		expect(parts).toHaveLength(2)
		for (const part of parts) expect([166, 167]).toContain(part)
		expect(
			ledger.feeRefunds.reduce((sum, entry) => sum + entry.amount, 0),
		).toBe(333)
		expect(ledger.reversals.reduce((sum, entry) => sum + entry.amount, 0)).toBe(
			3333 - 333,
		)
		expect(ledger.charges[0]).toMatchObject({ refunded: true })
	})

	it('replays by key, and read-back of the request id works on the refund object', async () => {
		const harness = createTestHarness()
		const { intent } = await paidDeposit(harness)
		const first = await refund(harness, intent, 1000, 'rr_replay')
		const replay = await refund(harness, intent, 1000, 'rr_replay')
		expect(replay.refundRef).toBe(first.refundRef)
		const stored = await retrieveReservationStripeRefund(
			harness.stripe,
			first.refundRef!,
		)
		expect(mapStripeRefundToReservation(stored)).toEqual({
			orgId: ORG,
			reservationId: RSV,
			refundRequestId: 'rr_replay',
			late: false,
			processor: 'stripe',
			paymentRef: intent,
			refundRef: first.refundRef,
			amountMinor: 1000,
			currency: 'USD',
			status: 'succeeded',
		})
	})

	it('7726: pending, then succeeded after settlement (VAL-PAY-011)', async () => {
		const harness = createTestHarness()
		const { intent } = await paidDeposit(harness, '4000000000007726')
		const outcome = await refund(harness, intent, 3333, 'rr_async')
		expect(outcome.status).toBe('pending')
		await harness.emulator.testing.settleRefund(outcome.refundRef!, 'succeeded')
		const settled = await retrieveReservationStripeRefund(
			harness.stripe,
			outcome.refundRef!,
		)
		expect(mapStripeRefundToReservation(settled)?.status).toBe('succeeded')
	})

	it('5126: pending, then failed', async () => {
		const harness = createTestHarness()
		const { intent } = await paidDeposit(harness, '4000000000005126')
		const outcome = await refund(harness, intent, 3333, 'rr_fail')
		expect(outcome.status).toBe('pending')
		await harness.emulator.testing.settleRefund(outcome.refundRef!)
		const settled = await retrieveReservationStripeRefund(
			harness.stripe,
			outcome.refundRef!,
		)
		expect(mapStripeRefundToReservation(settled)?.status).toBe('failed')
	})

	it('a definitive rejection (over-refund) is reported failed; a late refund reads back its marker', async () => {
		const harness = createTestHarness()
		const { intent } = await paidDeposit(harness)
		const over = await refund(harness, intent, 999_999, 'rr_over')
		expect(over).toMatchObject({ status: 'failed', refundRef: null })

		const late = await createReservationStripeRefund(harness.stripe, {
			paymentIntentId: intent,
			amountMinor: 3333,
			idempotencyKey: 'reservation_late_refund_' + intent,
			metadata: buildReservationRefundMetadata({
				orgId: ORG,
				reservationId: RSV,
			}),
		})
		const stored = await retrieveReservationStripeRefund(
			harness.stripe,
			late.refundRef!,
		)
		expect(mapStripeRefundToReservation(stored)).toMatchObject({
			refundRequestId: null,
			late: true,
			paymentRef: intent,
		})
	})
})

describe('reservation disputes', () => {
	it('0259 opens a dispute that maps by the payment intent metadata', async () => {
		const harness = createTestHarness()
		const { destination, intent } = await paidDeposit(
			harness,
			'4000000000000259',
		)
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		const dispute = ledger.disputes[0] as unknown as Stripe.Dispute
		const paymentIntent = await harness.stripe.paymentIntents.retrieve(intent)
		expect(
			mapStripeDisputeToReservation(dispute, paymentIntent, false),
		).toEqual({
			orgId: ORG,
			reservationId: RSV,
			processor: 'stripe',
			paymentRef: intent,
			disputeRef: dispute.id,
			status: 'opened',
		})
		const closed = await harness.emulator.testing.closeDispute(
			dispute.id,
			'lost',
		)
		expect(
			mapStripeDisputeToReservation(
				{ ...dispute, status: closed.status as Stripe.Dispute.Status },
				paymentIntent,
				true,
			)?.status,
		).toBe('lost')
		expect(mapStripeDisputeToReservation(dispute, null, false)).toBeNull()
	})
})
