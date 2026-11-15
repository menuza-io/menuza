import { describe, expect, it } from 'vitest'
import { createCheckoutShopHostedPayment } from '../connect/checkout-shop'
import {
	createReservationCheckoutRefund,
	listReservationCheckoutActions,
	retrieveReservationCheckoutPayment,
} from '../connect/reservation-checkout'
import {
	createReservationStripeRefund,
	retrieveReservationStripeRefund,
} from '../connect/reservation-stripe'
import { calculateShopFees } from '../connect/shop-fees'
import { createShopCheckoutSession } from '../connect/stripe-connect'
import {
	activeEntity,
	createTestHarness,
	onboardedAccount,
	type Harness,
} from '../mocks/test-helpers'
import {
	buildRestaurantOrderMetadata,
	restaurantOrderCheckoutReference,
} from './restaurant'
import {
	buildRestaurantOrderRefundIdempotencyKey,
	buildRestaurantOrderRefundMetadata,
	mapCheckoutDisputeWebhookToRestaurantOrder,
	mapCheckoutRefundWebhookToRestaurantOrder,
	mapStripeDisputeStatusToRestaurantOrder,
	mapStripeRefundToRestaurantOrder,
	parseRestaurantOrderRefundReference,
	restaurantOrderCommissionReversal,
	restaurantOrderFromMetadata,
	restaurantOrderRefundFailureCode,
	restaurantOrderRefundReference,
} from './restaurant-refunds'

const ORG = 'org_a'
const ORDER = 'ord_1'
const CHANNEL = 'pc_mockmockmockmockmockm'

describe('restaurant order refund ids', () => {
	it('metadata carries opaque ids only, with the order type', () => {
		expect(
			buildRestaurantOrderRefundMetadata({
				orgId: ORG,
				orderId: ORDER,
				refundId: 'rf_1',
			}),
		).toEqual({
			type: 'restaurant_order',
			orgId: ORG,
			orderId: ORDER,
			refundId: 'rf_1',
		})
	})

	it('one key per refund row, different per organization and refund', () => {
		const key = buildRestaurantOrderRefundIdempotencyKey({
			orgId: ORG,
			refundId: 'rf_1',
		})
		expect(key).toMatch(/^restaurant_order_refund_[0-9a-f]{40}$/)
		expect(
			buildRestaurantOrderRefundIdempotencyKey({
				orgId: ORG,
				refundId: 'rf_1',
			}),
		).toBe(key)
		expect(
			buildRestaurantOrderRefundIdempotencyKey({
				orgId: ORG,
				refundId: 'rf_2',
			}),
		).not.toBe(key)
		expect(
			buildRestaurantOrderRefundIdempotencyKey({
				orgId: 'org_b',
				refundId: 'rf_1',
			}),
		).not.toBe(key)
	})

	it('the Checkout.com reference round-trips, and an id too long for it has none', () => {
		expect(restaurantOrderRefundReference('rf_1')).toBe('ror_rf_1')
		expect(parseRestaurantOrderRefundReference('ror_rf_1')).toBe('rf_1')
		expect(parseRestaurantOrderRefundReference('rsv_refund_x')).toBeNull()
		expect(parseRestaurantOrderRefundReference(null)).toBeNull()
		expect(restaurantOrderRefundReference('x'.repeat(60))).toBeNull()
	})

	it('a payment of an order is told apart from a refund of it', () => {
		expect(
			restaurantOrderFromMetadata(buildRestaurantOrderMetadata(ORG, ORDER)),
		).toEqual({ orgId: ORG, orderId: ORDER })
		expect(
			restaurantOrderFromMetadata(
				buildRestaurantOrderRefundMetadata({
					orgId: ORG,
					orderId: ORDER,
					refundId: 'rf_1',
				}),
			),
		).toBeNull()
		expect(
			restaurantOrderFromMetadata({ type: 'reservation_payment' }),
		).toBeNull()
	})

	it('failure codes are short machine words', () => {
		expect(restaurantOrderRefundFailureCode('expired_or_canceled_card')).toBe(
			'expired_or_canceled_card',
		)
		expect(restaurantOrderRefundFailureCode('Bad thing!')).toBe('bad_thing_')
		expect(restaurantOrderRefundFailureCode(null)).toBe('provider_failed')
	})
})

describe('restaurant order dispute states', () => {
	it('maps Stripe statuses to open, won and lost', () => {
		const status = (value: string, closed: boolean) =>
			mapStripeDisputeStatusToRestaurantOrder(
				{ status: value as never },
				closed,
			)
		expect(status('needs_response', false)).toBe('open')
		expect(status('under_review', false)).toBe('open')
		expect(status('won', true)).toBe('won')
		expect(status('lost', true)).toBe('lost')
		expect(status('lost', false)).toBe('lost')
	})

	it('does not report a Stripe inquiry as a blocking dispute', () => {
		const status = (value: string, closed: boolean) =>
			mapStripeDisputeStatusToRestaurantOrder(
				{ status: value as never },
				closed,
			)
		expect(status('warning_needs_response', false)).toBeNull()
		expect(status('warning_under_review', false)).toBeNull()
		expect(status('warning_closed', true)).toBeNull()
		// Escalated to a chargeback: the same dispute now needs a response.
		expect(status('needs_response', false)).toBe('open')
	})

	it('maps Checkout.com dispute events and ignores other events', () => {
		const event = (type: string) =>
			mapCheckoutDisputeWebhookToRestaurantOrder({
				type,
				data: { id: 'dsp_1', payment_id: 'pay_1' },
			})
		expect(event('dispute_received')).toEqual({
			paymentId: 'pay_1',
			status: 'open',
		})
		expect(event('dispute_won')?.status).toBe('won')
		expect(event('dispute_lost')?.status).toBe('lost')
		expect(event('dispute_accepted')?.status).toBe('lost')
		expect(event('dispute_canceled')?.status).toBe('won')
		expect(event('payment_captured')).toBeNull()
	})
})

describe('commission reversal', () => {
	it('partial refunds add up to the commission taken', () => {
		const paymentCents = 3333
		const commissionCents = calculateShopFees(paymentCents).platformFeeCents
		let before = 0
		let reversed = 0
		for (const amountCents of [1000, 1, 1332, 1000]) {
			const part = restaurantOrderCommissionReversal({
				paymentCents,
				commissionCents,
				refundedBeforeCents: before,
				amountCents,
			})
			expect(part).toBeGreaterThanOrEqual(0)
			expect(part).toBeLessThanOrEqual(amountCents)
			reversed += part
			before += amountCents
		}
		expect(before).toBe(paymentCents)
		expect(reversed).toBe(commissionCents)
	})

	it('a full refund reverses the whole commission; nothing when there is none', () => {
		expect(
			restaurantOrderCommissionReversal({
				paymentCents: 4250,
				commissionCents: 850,
				refundedBeforeCents: 0,
				amountCents: 4250,
			}),
		).toBe(850)
		expect(
			restaurantOrderCommissionReversal({
				paymentCents: 4250,
				commissionCents: 0,
				refundedBeforeCents: 0,
				amountCents: 4250,
			}),
		).toBe(0)
	})
})

async function paidStripeOrder(harness: Harness, card = '4242424242424242') {
	const destination = await onboardedAccount(harness)
	const session = await createShopCheckoutSession(harness.stripe, {
		connectedAccountId: destination,
		productName: 'Restaurant order',
		amountCents: 4250,
		currency: 'usd',
		successUrl: 'http://localhost:3008/menu/success?order=ord_1',
		cancelUrl: 'http://localhost:3008/menu',
		metadata: buildRestaurantOrderMetadata(ORG, ORDER),
	})
	await harness.emulator.testing.completeCheckout(session.id, { card })
	const intent = (await harness.stripe.checkout.sessions.retrieve(session.id))
		.payment_intent as string
	return { destination, intent }
}

function stripeRefund(
	harness: Harness,
	intent: string,
	amountMinor: number,
	refundId: string,
) {
	return createReservationStripeRefund(harness.stripe, {
		paymentIntentId: intent,
		amountMinor,
		idempotencyKey: buildRestaurantOrderRefundIdempotencyKey({
			orgId: ORG,
			refundId,
		}),
		metadata: buildRestaurantOrderRefundMetadata({
			orgId: ORG,
			orderId: ORDER,
			refundId,
		}),
	})
}

describe('restaurant order refunds on the Stripe emulator', () => {
	it('a full refund reverses the transfer and the platform fee, replays by key and reads back its ids', async () => {
		const harness = createTestHarness()
		const { destination, intent } = await paidStripeOrder(harness)
		const first = await stripeRefund(harness, intent, 4250, 'rf_1')
		expect(first).toMatchObject({ status: 'succeeded', amountMinor: 4250 })
		const replay = await stripeRefund(harness, intent, 4250, 'rf_1')
		expect(replay.refundRef).toBe(first.refundRef)

		const stored = await retrieveReservationStripeRefund(
			harness.stripe,
			first.refundRef!,
		)
		expect(mapStripeRefundToRestaurantOrder(stored)).toEqual({
			orgId: ORG,
			orderId: ORDER,
			refundId: 'rf_1',
			providerRefundId: first.refundRef,
			paymentId: intent,
			amountCents: 4250,
			currency: 'USD',
			status: 'succeeded',
			failureCode: null,
		})
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		const fee = calculateShopFees(4250).platformFeeCents
		expect(ledger.feeRefunds.reduce((sum, row) => sum + row.amount, 0)).toBe(
			fee,
		)
		expect(ledger.reversals.reduce((sum, row) => sum + row.amount, 0)).toBe(
			4250 - fee,
		)
	})

	it('a second refund over what is left is a definitive failure with Stripe’s code', async () => {
		const harness = createTestHarness()
		const { intent } = await paidStripeOrder(harness)
		await stripeRefund(harness, intent, 4250, 'rf_1')
		const again = await stripeRefund(harness, intent, 100, 'rf_2')
		expect(again).toMatchObject({
			status: 'failed',
			refundRef: null,
			failureCode: 'charge_already_refunded',
		})
	})

	it('5126: pending, then failed with a failure reason', async () => {
		const harness = createTestHarness()
		const { intent } = await paidStripeOrder(harness, '4000000000005126')
		const outcome = await stripeRefund(harness, intent, 4250, 'rf_fail')
		expect(outcome.status).toBe('pending')
		await harness.emulator.testing.settleRefund(outcome.refundRef!)
		const settled = await retrieveReservationStripeRefund(
			harness.stripe,
			outcome.refundRef!,
		)
		expect(mapStripeRefundToRestaurantOrder(settled)).toMatchObject({
			refundId: 'rf_fail',
			status: 'failed',
			failureCode: 'expired_or_canceled_card',
		})
	})
})

describe('restaurant order refunds on the Checkout.com emulator', () => {
	async function paidCheckoutOrder(harness: Harness) {
		const entity = await activeEntity(harness)
		const page = await createCheckoutShopHostedPayment(harness.checkout, {
			subEntityId: entity,
			productName: 'Restaurant order',
			amountCents: 4250,
			currency: 'SAR',
			processingChannelId: CHANNEL,
			successUrl: 'http://localhost:3008/menu/success?order=ord_1',
			failureUrl: 'http://localhost:3008/menu',
			metadata: buildRestaurantOrderMetadata(ORG, ORDER),
			reference: restaurantOrderCheckoutReference(ORG, ORDER),
			billingCountry: 'SA',
		})
		const result = (await harness.emulator.testing.completeHostedPayment(
			page.id,
		)) as { paymentId: string }
		harness.deliveries.length = 0
		return { entity, paymentId: result.paymentId }
	}

	it('partial refunds reverse the commission in parts; the refund event names the order and the action', async () => {
		const harness = createTestHarness()
		const { entity, paymentId } = await paidCheckoutOrder(harness)
		const payment = await retrieveReservationCheckoutPayment(
			harness.checkout,
			paymentId,
		)
		const commissionCents = calculateShopFees(
			payment.amountMinor,
		).platformFeeCents
		let before = 0
		const actions: string[] = []
		for (const [index, amountCents] of [1000, 3250].entries()) {
			const refundId = `rf_${index}`
			const outcome = await createReservationCheckoutRefund(harness.checkout, {
				paymentId,
				subEntityId: entity,
				amountMinor: amountCents,
				feeReversalMinor: restaurantOrderCommissionReversal({
					paymentCents: payment.amountMinor,
					commissionCents,
					refundedBeforeCents: before,
					amountCents,
				}),
				reference: restaurantOrderRefundReference(refundId)!,
				idempotencyKey: buildRestaurantOrderRefundIdempotencyKey({
					orgId: ORG,
					refundId,
				}),
			})
			expect(outcome.status).toBe('pending')
			actions.push(outcome.refundRef!)
			before += amountCents
			await harness.emulator.testing.settleCheckoutRefund(outcome.refundRef!)
		}
		const listed = await listReservationCheckoutActions(
			harness.checkout,
			paymentId,
		)
		const refunds = listed.filter((action) => action.type === 'Refund')
		expect(
			refunds.map((action) =>
				parseRestaurantOrderRefundReference(action.reference),
			),
		).toEqual(expect.arrayContaining(['rf_0', 'rf_1']))

		const delivered = harness.deliveries
			.map(
				(delivery) =>
					JSON.parse(delivery.body) as { type: string; data: unknown },
			)
			.filter((event) => event.type === 'payment_refunded')
		expect(delivered).toHaveLength(2)
		expect(mapCheckoutRefundWebhookToRestaurantOrder(delivered[0]!)).toEqual({
			orgId: ORG,
			orderId: ORDER,
			paymentId,
			actionId: actions[0],
			amountCents: 1000,
			currency: 'SAR',
			declined: false,
			responseCode: '10000',
		})
		const raw = (await harness.checkout.payments.get(paymentId)) as {
			balances?: { total_refunded?: number }
		}
		expect(raw.balances?.total_refunded).toBe(4250)
	})

	it('a refund over the balance is a definitive failure with the provider code', async () => {
		const harness = createTestHarness()
		const { entity, paymentId } = await paidCheckoutOrder(harness)
		const outcome = await createReservationCheckoutRefund(harness.checkout, {
			paymentId,
			subEntityId: entity,
			amountMinor: 999_999,
			feeReversalMinor: 0,
			reference: 'ror_rf_over',
			idempotencyKey: 'restaurant_order_refund_over',
		})
		expect(outcome).toMatchObject({ status: 'failed', refundRef: null })
		expect(outcome.failureCode).toBeTruthy()
	})
})
