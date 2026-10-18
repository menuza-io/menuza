import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
	createTestHarness,
	onboardedAccount,
	verifyStripeDelivery,
	type Harness,
} from '../test-helpers'

async function paidCharge(
	harness: Harness,
	card = '4242424242424242',
	amount = 10_000,
	fee = 1_000,
) {
	const destination = await onboardedAccount(harness)
	const session = await harness.stripe.checkout.sessions.create({
		mode: 'payment',
		line_items: [
			{
				price_data: {
					currency: 'usd',
					product_data: { name: 'Deposit' },
					unit_amount: amount,
				},
				quantity: 1,
			},
		],
		payment_intent_data: {
			application_fee_amount: fee,
			transfer_data: { destination },
			metadata: { type: 'reservation_payment' },
		},
		success_url: 'http://localhost:3008/done',
	})
	await harness.emulator.testing.completeCheckout(session.id, { card })
	const done = await harness.stripe.checkout.sessions.retrieve(session.id)
	return { destination, intent: done.payment_intent as string }
}

const refundParams = {
	reverse_transfer: true,
	refund_application_fee: true,
} as const

describe('Stripe refunds with ledger reversal (VAL-PMOCK-025)', () => {
	it('a full refund reverses the transfer and refunds the whole fee', async () => {
		const harness = createTestHarness()
		const { destination, intent } = await paidCharge(harness)
		harness.deliveries.length = 0
		const refund = await harness.stripe.refunds.create({
			payment_intent: intent,
			...refundParams,
		})
		expect(refund).toMatchObject({ status: 'succeeded', amount: 10_000 })
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.reversals).toHaveLength(1)
		expect(ledger.reversals[0]).toMatchObject({ amount: 9_000 })
		expect(ledger.reversals[0]!.id).toMatch(/^trr_/)
		expect(ledger.feeRefunds[0]).toMatchObject({ amount: 1_000 })
		expect(ledger.feeRefunds[0]!.id).toMatch(/^fr_/)
		expect(ledger.transfers[0]).toMatchObject({
			amount_reversed: 9_000,
			reversed: true,
		})
		expect(ledger.applicationFees[0]).toMatchObject({
			amount_refunded: 1_000,
			refunded: true,
		})
		expect(ledger.charges[0]).toMatchObject({
			amount_refunded: 10_000,
			refunded: true,
		})
		const types = harness.deliveries.map(
			(entry) => verifyStripeDelivery(entry).type,
		)
		expect(types).toEqual(
			expect.arrayContaining(['refund.created', 'charge.refunded']),
		)
	})

	it('partial refunds reverse transfer and fee proportionally and add up exactly', async () => {
		const harness = createTestHarness()
		const { destination, intent } = await paidCharge(
			harness,
			'4242424242424242',
			10_000,
			1_000,
		)
		await harness.stripe.refunds.create({
			payment_intent: intent,
			amount: 2_500,
			...refundParams,
		})
		let ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.reversals[0]).toMatchObject({ amount: 2_250 })
		expect(ledger.feeRefunds[0]).toMatchObject({ amount: 250 })
		expect(ledger.charges[0]!.refunded).toBe(false)
		await harness.stripe.refunds.create({
			payment_intent: intent,
			amount: 3_333,
			...refundParams,
		})
		await harness.stripe.refunds.create({
			payment_intent: intent,
			...refundParams,
		})
		ledger = await harness.emulator.pages.stripe.ledger(destination)
		const reversed = ledger.reversals.reduce(
			(sum, entry) => sum + entry.amount,
			0,
		)
		const feeBack = ledger.feeRefunds.reduce(
			(sum, entry) => sum + entry.amount,
			0,
		)
		expect(reversed).toBe(9_000)
		expect(feeBack).toBe(1_000)
		expect(ledger.charges[0]).toMatchObject({
			amount_refunded: 10_000,
			refunded: true,
		})
	})

	it('refuses an over-refund and an already refunded charge', async () => {
		const harness = createTestHarness()
		const { intent } = await paidCharge(harness)
		const over = await harness.stripe.refunds
			.create({ payment_intent: intent, amount: 10_001 })
			.catch((thrown) => thrown)
		expect(over).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
		expect(over.code).toBe('amount_too_large')
		await harness.stripe.refunds.create({ payment_intent: intent })
		const again = await harness.stripe.refunds
			.create({ payment_intent: intent })
			.catch((thrown) => thrown)
		expect(again.code).toBe('charge_already_refunded')
	})

	it('concurrent refunds cannot exceed the charge', async () => {
		const harness = createTestHarness()
		const { intent } = await paidCharge(harness)
		const results = await Promise.allSettled([
			harness.stripe.refunds.create({ payment_intent: intent, amount: 6_000 }),
			harness.stripe.refunds.create({ payment_intent: intent, amount: 6_000 }),
		])
		expect(
			results.filter((entry) => entry.status === 'fulfilled'),
		).toHaveLength(1)
	})

	it('refund_application_fee needs reverse_transfer', async () => {
		const harness = createTestHarness()
		const { intent } = await paidCharge(harness)
		await expect(
			harness.stripe.refunds.create({
				payment_intent: intent,
				refund_application_fee: true,
			}),
		).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
	})
})

describe('asynchronous refunds (VAL-PMOCK-026)', () => {
	it('7726: pending, then succeeded once settled, with matching events', async () => {
		const harness = createTestHarness()
		const { intent } = await paidCharge(harness, '4000000000007726')
		harness.deliveries.length = 0
		const refund = await harness.stripe.refunds.create({
			payment_intent: intent,
			...refundParams,
		})
		expect(refund.status).toBe('pending')
		await harness.emulator.testing.settleRefund(refund.id, 'succeeded')
		const settled = await harness.stripe.refunds.retrieve(refund.id)
		expect(settled.status).toBe('succeeded')
		const types = harness.deliveries.map(
			(entry) => verifyStripeDelivery(entry).type,
		)
		expect(types).toEqual([
			'refund.created',
			'refund.updated',
			'charge.refunded',
		])
	})

	it('5126: pending, then failed with refund.failed and charge.refund.updated, unwinding the ledger', async () => {
		const harness = createTestHarness()
		const { destination, intent } = await paidCharge(
			harness,
			'4000000000005126',
		)
		harness.deliveries.length = 0
		const refund = await harness.stripe.refunds.create({
			payment_intent: intent,
			...refundParams,
		})
		expect(refund.status).toBe('pending')
		await harness.emulator.testing.settleRefund(refund.id)
		const failed = await harness.stripe.refunds.retrieve(refund.id)
		expect(failed).toMatchObject({
			status: 'failed',
			failure_reason: 'expired_or_canceled_card',
		})
		const types = harness.deliveries.map(
			(entry) => verifyStripeDelivery(entry).type,
		)
		expect(types).toEqual(
			expect.arrayContaining(['refund.failed', 'charge.refund.updated']),
		)
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.charges[0]).toMatchObject({
			amount_refunded: 0,
			refunded: false,
		})
		expect(ledger.transfers[0]).toMatchObject({ amount_reversed: 0 })
		// The full amount can be refunded again.
		await expect(
			harness.stripe.refunds.create({ payment_intent: intent }),
		).resolves.toMatchObject({
			amount: 10_000,
		})
	})

	it('a pending refund settles on its own as mock time passes', async () => {
		const harness = createTestHarness()
		const { intent } = await paidCharge(harness, '4000000000007726')
		const refund = await harness.stripe.refunds.create({
			payment_intent: intent,
		})
		expect(refund.status).toBe('pending')
		await harness.emulator.testing.advanceClock(2 * 60 * 60)
		expect((await harness.stripe.refunds.retrieve(refund.id)).status).toBe(
			'succeeded',
		)
	})
})

describe('disputes', () => {
	it('0259 opens a dispute after the charge; the dev helper can open and close one', async () => {
		const harness = createTestHarness()
		const { destination, intent } = await paidCharge(
			harness,
			'4000000000000259',
		)
		const ledger = await harness.emulator.pages.stripe.ledger(destination)
		expect(ledger.disputes).toHaveLength(1)
		expect(ledger.disputes[0]).toMatchObject({
			status: 'needs_response',
			payment_intent: intent,
		})
		expect(ledger.charges[0]!.disputed).toBe(true)
		const closed = await harness.emulator.testing.closeDispute(
			String(ledger.disputes[0]!.id),
			'lost',
		)
		expect(closed.status).toBe('lost')
		const types = (
			await harness.emulator.events.list({ provider: 'stripe' })
		).map((entry) => entry.type)
		expect(types).toEqual(
			expect.arrayContaining([
				'charge.dispute.created',
				'charge.dispute.closed',
			]),
		)

		const second = createTestHarness()
		const paid = await paidCharge(second)
		second.deliveries.length = 0
		const dispute = await second.emulator.testing.createDispute(paid.intent)
		expect(dispute.id).toMatch(/^dp_/)
		const delivered = second.deliveries.find((entry) =>
			entry.body.includes('charge.dispute.created'),
		)!
		expect(verifyStripeDelivery(delivered).type).toBe('charge.dispute.created')
	})
})
