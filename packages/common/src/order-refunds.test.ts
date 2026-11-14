import { describe, expect, it } from 'vitest'

import {
	disputeBlocksRefund,
	operatorOrderLifecycleSchema,
	operatorOrderRefundRequestSchema,
	operatorOrderRefundSchema,
	orderDisputeStatusRequestSchema,
	orderProviderRefundRequestSchema,
	orderRefundExecuteRequestSchema,
	orderRefundIntentRequestSchema,
	orderRefundIntentResponseSchema,
	orderRefundsPendingRequestSchema,
	orderRefundStatusRequestSchema,
	orderRefundState,
	summarizeOrderRefunds,
} from './restaurant-orders.ts'

const ORG = 'clw9x0a12000008l00cafeorg1'

describe('refund request bodies', () => {
	it('keeps the record body and the provider body the same shape', () => {
		for (const body of [
			{ amountCents: 500, note: 'Cold food' },
			{ full: true, note: 'Wrong order' },
		]) {
			expect(operatorOrderRefundRequestSchema.safeParse(body).success).toBe(
				true,
			)
			expect(orderProviderRefundRequestSchema.safeParse(body).success).toBe(
				true,
			)
		}
		for (const body of [
			{ amountCents: 500 },
			{ amountCents: 0, note: 'Cold food' },
			{ full: false, note: 'Cold food' },
			{ amountCents: 500, full: true, note: 'Cold food' },
			{ amountCents: 500, note: 'ok' },
			{ amountCents: 500, note: 'Cold food', extra: 1 },
		])
			expect(orderProviderRefundRequestSchema.safeParse(body).success).toBe(
				false,
			)
	})
})

describe('region system contracts', () => {
	const intent = {
		orgId: ORG,
		orderId: 'order_1',
		amountCents: 500,
		note: 'Cold food',
		idempotencyKey: 'refund-key-0001',
		actor: { origin: 'operator', actorId: 'user_1' },
	}

	it('books an intent with an amount or full, never both or neither', () => {
		expect(orderRefundIntentRequestSchema.safeParse(intent).success).toBe(true)
		const { amountCents: ignoredAmount, ...withoutAmount } = intent
		expect(
			orderRefundIntentRequestSchema.safeParse({ ...withoutAmount, full: true })
				.success,
		).toBe(true)
		expect(
			orderRefundIntentRequestSchema.safeParse(withoutAmount).success,
		).toBe(false)
		expect(
			orderRefundIntentRequestSchema.safeParse({ ...intent, full: true })
				.success,
		).toBe(false)
	})

	it('takes a tab ref and a tab payment, and refuses unknown keys and actors', () => {
		expect(
			orderRefundIntentRequestSchema.safeParse({
				...intent,
				orderId: 'tab:abc',
				tabPaymentId: 'tp_1',
				actor: { origin: 'system' },
			}).success,
		).toBe(true)
		for (const body of [
			{ ...intent, contactEmail: 'a@b.c' },
			{ ...intent, actor: { origin: 'robot' } },
			{ ...intent, actor: { origin: 'operator', name: 'Ada' } },
			{ ...intent, idempotencyKey: 'short' },
		])
			expect(orderRefundIntentRequestSchema.safeParse(body).success).toBe(false)
	})

	it('answers an intent with ids, amounts and the provider reference only', () => {
		const parsed = orderRefundIntentResponseSchema.parse({
			refundId: 'rf_1',
			orderId: 'order_1',
			tabPaymentId: null,
			amountCents: 500,
			currency: 'USD',
			processor: 'connect',
			sessionId: 'cs_test_1',
			paymentId: null,
			status: 'pending',
			providerRefundId: null,
			createdAt: '2026-11-14T12:00:00.000Z',
			updatedAt: '2026-11-14T12:00:00.000Z',
			replayed: false,
		})
		expect(parsed.status).toBe('pending')
	})

	it('names a refund by id or provider id when reporting its status', () => {
		expect(
			orderRefundStatusRequestSchema.safeParse({
				orgId: ORG,
				refundId: 'rf_1',
				status: 'succeeded',
				providerRefundId: 're_1',
			}).success,
		).toBe(true)
		expect(
			orderRefundStatusRequestSchema.safeParse({
				orgId: ORG,
				providerRefundId: 're_1',
				status: 'failed',
				failureCode: 'Expired_Or_Canceled_Card',
			}).data?.failureCode,
		).toBe('expired_or_canceled_card')
		for (const body of [
			{ orgId: ORG, status: 'succeeded' },
			{ orgId: ORG, refundId: 'rf_1', status: 'refunded' },
			{
				orgId: ORG,
				refundId: 'rf_1',
				status: 'failed',
				failureCode: 'card was declined, call +1 555',
			},
		])
			expect(orderRefundStatusRequestSchema.safeParse(body).success).toBe(false)
	})

	it('names a disputed order by id or by payment session', () => {
		expect(
			orderDisputeStatusRequestSchema.safeParse({
				orgId: ORG,
				sessionId: 'cs_test_1',
				processor: 'connect',
				status: 'open',
			}).success,
		).toBe(true)
		expect(
			orderDisputeStatusRequestSchema.safeParse({ orgId: ORG, status: 'won' })
				.success,
		).toBe(false)
	})

	it('lists pending refunds and kicks execution with ids only', () => {
		expect(
			orderRefundsPendingRequestSchema.safeParse({
				orgId: ORG,
				olderThanMs: 15 * 60_000,
				limit: 50,
			}).success,
		).toBe(true)
		expect(
			orderRefundsPendingRequestSchema.safeParse({ orgId: ORG, limit: 500 })
				.success,
		).toBe(false)
		expect(
			orderRefundExecuteRequestSchema.safeParse({
				orgId: ORG,
				refundId: 'rf_1',
			}).success,
		).toBe(true)
		expect(
			orderRefundExecuteRequestSchema.safeParse({
				orgId: ORG,
				refundId: 'rf_1',
				amountCents: 5,
			}).success,
		).toBe(false)
	})
})

describe('disputeBlocksRefund', () => {
	it('blocks open and lost disputes only', () => {
		expect(disputeBlocksRefund('open')).toBe(true)
		expect(disputeBlocksRefund('lost')).toBe(true)
		expect(disputeBlocksRefund('won')).toBe(false)
		expect(disputeBlocksRefund(null)).toBe(false)
		expect(disputeBlocksRefund(undefined)).toBe(false)
	})
})

describe('summarizeOrderRefunds', () => {
	const paid = { paidCents: 2000, refundedCents: 0 }

	it('reads none with no refunds', () => {
		expect(summarizeOrderRefunds(paid, [])).toEqual({
			refundedCents: 0,
			pendingCents: 0,
			refundableCents: 2000,
			refundStatus: 'none',
			failureCode: null,
		})
	})

	it('reserves a pending refund without counting it as refunded', () => {
		expect(
			summarizeOrderRefunds({ paidCents: 2000, refundedCents: 500 }, [
				{ amountCents: 500, status: 'succeeded', createdAt: 1 },
				{ amountCents: 700, status: 'pending', createdAt: 2 },
			]),
		).toEqual({
			refundedCents: 500,
			pendingCents: 700,
			refundableCents: 800,
			refundStatus: 'pending',
			failureCode: null,
		})
	})

	it('gives a failed refund back and reports the newest failure', () => {
		expect(
			summarizeOrderRefunds(paid, [
				{
					amountCents: 2000,
					status: 'failed',
					failureCode: 'expired_card',
					createdAt: '2026-11-14T12:00:00Z',
				},
			]),
		).toEqual({
			refundedCents: 0,
			pendingCents: 0,
			refundableCents: 2000,
			refundStatus: 'failed',
			failureCode: 'expired_card',
		})
		// A later success hides an older failure.
		expect(
			summarizeOrderRefunds({ paidCents: 2000, refundedCents: 300 }, [
				{ amountCents: 2000, status: 'failed', createdAt: 1 },
				{ amountCents: 300, status: 'succeeded', createdAt: 2 },
			]).refundStatus,
		).toBe('partial')
	})

	it('reads full once succeeded refunds reach the payment', () => {
		const summary = summarizeOrderRefunds(
			{ paidCents: 2000, refundedCents: 2000 },
			[{ amountCents: 2000, status: 'succeeded', kind: 'provider' }],
		)
		expect(summary.refundStatus).toBe('full')
		expect(summary.refundableCents).toBe(0)
		// The stored total stays the record the old helper reads.
		expect(orderRefundState({ totalCents: 2000, refundedCents: 2000 })).toBe(
			'full',
		)
	})
})

describe('operator order JSON', () => {
	it('reads an older region without the new fields', () => {
		expect(operatorOrderLifecycleSchema.parse({})).toEqual({
			cancelReason: null,
			cancelledBy: null,
			rejectedReason: null,
			acceptanceDeadlineAt: null,
			acceptedAt: null,
			disputed: false,
			disputeStatus: null,
			disputedAt: null,
		})
		expect(
			operatorOrderRefundSchema.parse({
				id: 'rf_1',
				amountCents: 100,
				currency: 'USD',
				full: false,
				note: null,
				actorId: 'user_1',
				createdAt: '2026-11-14T12:00:00.000Z',
			}),
		).toMatchObject({
			kind: 'record',
			status: 'succeeded',
			origin: 'operator',
			failureCode: null,
		})
	})
})
