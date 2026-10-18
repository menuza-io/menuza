import { describe, expect, it } from 'vitest'
import { mapCheckoutPaymentToReservationPayment } from '../connect/reservation-checkout'
import { mapStripeSessionToReservationPayment } from '../connect/reservation-stripe'
import { paymentsMockMode } from '../mocks/env'
import {
	activeEntity,
	createTestHarness,
	onboardedAccount,
	type Harness,
} from '../mocks/test-helpers'
import { createMockStripeHttpClient } from '../mocks/transport'
import { createShopCommerce } from './commerce'
import { createShopCommerceConfigFromEnv } from './config'
import { applyPaymentsMockConfig } from './mock-config'
import {
	buildReservationFeeMetadata,
	buildReservationPaymentMetadata,
	reservationCheckoutReference,
} from './reservation'

function commerceFor(harness: Harness) {
	const env = {
		MOCKS: 'true',
		STRIPE_SECRET_KEY: 'sk_test_***',
		STRIPE_PUBLISHABLE_KEY: 'pk_test_***',
		STRIPE_WEBHOOK_SECRET: 'whsec_***',
	}
	return createShopCommerce(
		applyPaymentsMockConfig(
			createShopCommerceConfigFromEnv(env),
			env,
			paymentsMockMode(env),
			{
				stripeHttpClient: createMockStripeHttpClient(harness.emulator),
				checkoutDashboardUrl: 'http://localhost:3001/mock',
			},
		),
	)
}

const ORG = 'org_a'
const RSV = 'rsv_1'

describe('ShopCommerce reservation methods on the emulators', () => {
	it('Stripe: deposit, guarantee, off-session fee with dangling cancel, refund', async () => {
		const harness = createTestHarness()
		const commerce = commerceFor(harness)
		const destination = await onboardedAccount(harness)
		const hold = new Date(harness.clock.now() + 20 * 60_000).toISOString()
		const common = {
			connectedAccountId: destination,
			currency: 'USD',
			platformFeeMinor: 0,
			successUrl: 'http://localhost:3008/done',
			cancelUrl: 'http://localhost:3008/cancel',
			paymentExpiresAt: hold,
			nowMs: harness.clock.now(),
		}
		const deposit = await commerce.createReservationStripeSession({
			...common,
			productName: 'Reservation deposit',
			amountMinor: 4000,
			platformFeeMinor: 60,
			idempotencyKey: 'k_deposit',
			metadata: buildReservationPaymentMetadata({
				orgId: ORG,
				reservationId: RSV,
				purpose: 'deposit',
			}),
		})
		expect(deposit.url).toContain('/mock-payments/stripe/checkout/')
		await harness.emulator.testing.completeCheckout(deposit.id)
		const paid = await commerce.retrieveReservationStripeSession(deposit.id)
		const event = mapStripeSessionToReservationPayment(paid)!
		expect(event.status).toBe('paid')

		const guarantee = await commerce.createReservationStripeSession({
			...common,
			guarantee: {
				orgId: ORG,
				guestRef: 'guest_ref_1234',
				consentText: 'Consent',
			},
			productName: 'Card guarantee',
			amountMinor: 0,
			idempotencyKey: 'k_guarantee',
			metadata: buildReservationPaymentMetadata({
				orgId: ORG,
				reservationId: 'rsv_2',
				purpose: 'guarantee',
			}),
		})
		expect(guarantee.customerId).toMatch(/^cus_/)
		await harness.emulator.testing.completeCheckout(guarantee.id, {
			card: '4000002760003184',
		})
		const saved = mapStripeSessionToReservationPayment(
			await commerce.retrieveReservationStripeSession(guarantee.id, {
				setup: true,
			}),
		)!
		expect(saved.status).toBe('setup_succeeded')

		const fee = await commerce.chargeReservationFeeStripe({
			connectedAccountId: destination,
			customerId: saved.providerCustomerRef!,
			paymentMethodId: saved.paymentMethodRef!,
			amountMinor: 2500,
			currency: 'USD',
			platformFeeMinor: 38,
			idempotencyKey: 'k_fee',
			metadata: buildReservationFeeMetadata({
				orgId: ORG,
				reservationId: 'rsv_2',
				feeId: 'fee_1',
			}),
		})
		expect(fee).toMatchObject({
			status: 'requires_action',
			danglingCanceled: true,
		})
		const intentId = (fee as { danglingPaymentIntentId: string })
			.danglingPaymentIntentId
		expect(
			(await commerce.retrieveReservationPaymentIntent(intentId)).status,
		).toBe('canceled')

		const refund = await commerce.createReservationStripeRefund({
			paymentIntentId: event.paymentRef!,
			amountMinor: 4000,
			idempotencyKey: 'k_refund',
			metadata: { type: 'reservation_refund', orgId: ORG, reservationId: RSV },
		})
		expect(refund.status).toBe('succeeded')
		expect(
			(await commerce.retrieveReservationStripeRefund(refund.refundRef!))
				.status,
		).toBe('succeeded')
	})

	it('Checkout.com: guarantee stores the card, MIT fee and refund', async () => {
		const harness = createTestHarness()
		const commerce = commerceFor(harness)
		const entity = await activeEntity(harness)
		const reference = reservationCheckoutReference({
			orgId: ORG,
			reservationId: RSV,
			purpose: 'guarantee',
		})
		const page = await commerce.createReservationCheckoutHostedPayment({
			subEntityId: entity,
			productName: 'Card guarantee',
			amountMinor: 0,
			currency: 'SAR',
			reference,
			guarantee: true,
			platformFeeMinor: 0,
			successUrl: 'http://localhost:3008/done',
			failureUrl: 'http://localhost:3008/fail',
			cancelUrl: 'http://localhost:3008/cancel',
			billingCountry: 'SA',
			metadata: buildReservationPaymentMetadata({
				orgId: ORG,
				reservationId: RSV,
				purpose: 'guarantee',
			}),
		})
		await harness.emulator.testing.completeHostedPayment(page.id)
		const [payment] = await commerce.findReservationCheckoutPayments(reference)
		const saved = mapCheckoutPaymentToReservationPayment(payment!)!
		expect(saved.status).toBe('setup_succeeded')
		const fee = await commerce.chargeReservationFeeCheckout({
			subEntityId: entity,
			sourceId: saved.paymentMethodRef!,
			previousPaymentId: saved.previousPaymentRef!,
			amountMinor: 5000,
			currency: 'SAR',
			reference: 'rsv_mit_fee_1_1',
			platformFeeMinor: 0,
			idempotencyKey: 'k_mit',
			metadata: buildReservationFeeMetadata({
				orgId: ORG,
				reservationId: RSV,
				feeId: 'fee_1',
			}),
		})
		expect(fee.status).toBe('succeeded')
		const refund = await commerce.createReservationCheckoutRefund({
			paymentId: (fee as { paymentRef: string }).paymentRef,
			subEntityId: entity,
			amountMinor: 5000,
			feeReversalMinor: 0,
			reference: 'rsv_refund_rr_1',
			idempotencyKey: 'k_refund',
		})
		expect(refund.status).toBe('pending')
		const actions = await commerce.listReservationCheckoutPaymentActions(
			(fee as { paymentRef: string }).paymentRef,
		)
		expect(actions.some((action) => action.id === refund.refundRef)).toBe(true)
		expect(
			(await commerce.retrieveReservationCheckoutPayment(payment!.id)).sourceId,
		).toBe(saved.paymentMethodRef)
	})
})
