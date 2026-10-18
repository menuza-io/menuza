import { describe, expect, it } from 'vitest'
import {
	activeEntity,
	createTestHarness,
	type Harness,
} from '../mocks/test-helpers'
import {
	buildReservationFeeMetadata,
	buildReservationPaymentMetadata,
	buildReservationRefundIdempotencyKey,
	reservationCheckoutReference,
	reservationRefundReference,
} from '../shop/reservation'
import {
	buildCheckoutRefundEvent,
	checkoutRefundActionStatus,
	chargeReservationFeeMit,
	createReservationCheckoutRefund,
	createReservationHostedPayment,
	extractCheckoutDisputeWebhook,
	extractCheckoutRefundWebhook,
	findReservationCheckoutPaymentsByReference,
	isCheckoutDefinitiveRejection,
	listReservationCheckoutActions,
	mapCheckoutDisputeToReservation,
	mapCheckoutPaymentToReservationPayment,
	mapCheckoutWebhookToReservationPayment,
	reservationFeeChargeReference,
	retrieveReservationCheckoutPayment,
	RESERVATION_CHECKOUT_VERIFICATION_MINOR,
} from './reservation-checkout'

const CHANNEL = 'pc_mockmockmockmockmockm'
const ORG = 'org_a'
const RSV = 'rsv_1'

async function hosted(
	harness: Harness,
	options: {
		purpose?: 'deposit' | 'guarantee' | 'prepay'
		amountMinor?: number
		platformFeeMinor?: number
	} = {},
) {
	const purpose = options.purpose ?? 'deposit'
	const entity = await activeEntity(harness)
	const reference = reservationCheckoutReference({
		orgId: ORG,
		reservationId: RSV,
		purpose,
	})
	const amountMinor = options.amountMinor ?? 20_000
	const page = await createReservationHostedPayment(harness.checkout, {
		subEntityId: entity,
		productName: 'Reservation deposit',
		amountMinor:
			purpose === 'guarantee'
				? RESERVATION_CHECKOUT_VERIFICATION_MINOR
				: amountMinor,
		currency: 'SAR',
		processingChannelId: CHANNEL,
		reference,
		guarantee: purpose === 'guarantee',
		platformFeeMinor: options.platformFeeMinor ?? 0,
		successUrl: 'http://localhost:3008/reserve/pay/done?r=rsv_1',
		failureUrl: 'http://localhost:3008/reserve/pay',
		cancelUrl: 'http://localhost:3008/reserve/pay',
		billingCountry: 'SA',
		metadata: buildReservationPaymentMetadata({
			orgId: ORG,
			reservationId: RSV,
			purpose,
		}),
	})
	return { entity, page, reference }
}

async function pay(harness: Harness, hppId: string, card?: string) {
	return (await harness.emulator.testing.completeHostedPayment(
		hppId,
		card ? { card } : undefined,
	)) as { status: string; paymentId: string }
}

describe('reservation hosted payments on the Checkout.com emulator', () => {
	it('deposit: allocation with the platform commission and a reference-bound paid event (VAL-PAY-021, VAL-PAY-022)', async () => {
		const harness = createTestHarness()
		const { page, reference, entity } = await hosted(harness, {
			amountMinor: 3333,
			platformFeeMinor: 49,
		})
		expect(page.id).toMatch(/^hpp_/)
		expect(page.url).toContain('hpp_')
		expect(page.reference).toBe(reference)
		harness.deliveries.length = 0
		const result = await pay(harness, page.id)
		expect(result.status).toBe('approved')
		const payment = await retrieveReservationCheckoutPayment(
			harness.checkout,
			result.paymentId,
		)
		expect(payment).toMatchObject({
			reference,
			amountMinor: 3333,
			currency: 'SAR',
			approved: true,
			metadata: {
				type: 'reservation_payment',
				orgId: ORG,
				reservationId: RSV,
				purpose: 'deposit',
			},
		})
		const raw = (await harness.checkout.payments.get(result.paymentId)) as {
			amount_allocations: unknown
		}
		expect(raw.amount_allocations).toEqual([
			{
				id: entity,
				amount: 3333,
				commission: { amount: 49, percentage: expect.any(Number) },
			},
		])
		const event = mapCheckoutPaymentToReservationPayment(payment)
		expect(event).toEqual({
			orgId: ORG,
			reservationId: RSV,
			feeId: null,
			purpose: 'deposit',
			sessionId: reference,
			processor: 'checkout',
			status: 'paid',
			amountMinor: 3333,
			currency: 'SAR',
			paymentRef: result.paymentId,
			paymentMethodRef: null,
			providerCustomerRef: null,
			previousPaymentRef: null,
			card: null,
		})
		// The signed webhooks map to the same event.
		const approved = harness.deliveries
			.map((delivery) => JSON.parse(delivery.body))
			.find((entry) => entry.type === 'payment_approved')
		expect(mapCheckoutWebhookToReservationPayment(approved)).toEqual(event)
	})

	it('a decline (amount ending 05) maps to failed; a payment found by reference works without a webhook (VAL-PAY-023)', async () => {
		const harness = createTestHarness()
		const { page, reference } = await hosted(harness, { amountMinor: 1005 })
		const result = await pay(harness, page.id)
		expect(result.status).toBe('declined')
		const found = await findReservationCheckoutPaymentsByReference(
			harness.checkout,
			reference,
		)
		expect(found.length).toBeGreaterThan(0)
		expect(mapCheckoutPaymentToReservationPayment(found[0]!)).toMatchObject({
			status: 'failed',
			sessionId: reference,
		})
	})

	it('refuses a payment whose reference is not the one its ids produce, and merchant-initiated ones', async () => {
		const harness = createTestHarness()
		const { page } = await hosted(harness)
		const result = await pay(harness, page.id)
		const payment = await retrieveReservationCheckoutPayment(
			harness.checkout,
			result.paymentId,
		)
		expect(
			mapCheckoutPaymentToReservationPayment({
				...payment,
				reference: 'rsv_deposit_other',
			}),
		).toBeNull()
		expect(
			mapCheckoutPaymentToReservationPayment({
				...payment,
				merchantInitiated: true,
			}),
		).toBeNull()
		expect(
			mapCheckoutPaymentToReservationPayment({
				...payment,
				metadata: { type: 'restaurant_order', orgId: ORG, orderId: 'o' },
			}),
		).toBeNull()
	})

	it('hosted pages are paid once: a second webhook mapping is the same event (duplicates stay inert)', async () => {
		const harness = createTestHarness()
		const { page } = await hosted(harness)
		await pay(harness, page.id)
		const events = harness.deliveries.map((delivery) =>
			JSON.parse(delivery.body),
		)
		const mapped = events
			.map((event) => mapCheckoutWebhookToReservationPayment(event))
			.filter(Boolean)
		expect(mapped.length).toBeGreaterThanOrEqual(1)
		expect(new Set(mapped.map((event) => JSON.stringify(event))).size).toBe(1)
	})
})

describe('Checkout.com card guarantees and merchant-initiated fees (VAL-PAY-024, VAL-PAY-025)', () => {
	async function guarantee(harness: Harness, card = '4242424242424242') {
		const { page, entity, reference } = await hosted(harness, {
			purpose: 'guarantee',
		})
		const result = await pay(harness, page.id, card)
		const payment = await retrieveReservationCheckoutPayment(
			harness.checkout,
			result.paymentId,
		)
		return { entity, reference, payment, result }
	}

	it('stores the card: src_, cus_ and the CIT payment id come back as a setup event', async () => {
		const harness = createTestHarness()
		const { payment, reference } = await guarantee(harness)
		expect(payment.amountMinor).toBe(RESERVATION_CHECKOUT_VERIFICATION_MINOR)
		const event = mapCheckoutPaymentToReservationPayment(payment)
		expect(event).toMatchObject({
			purpose: 'guarantee',
			status: 'setup_succeeded',
			sessionId: reference,
			amountMinor: 0,
			currency: 'SAR',
			paymentRef: payment.id,
			previousPaymentRef: payment.id,
			paymentMethodRef: payment.sourceId,
			providerCustomerRef: payment.customerId,
			card: { brand: 'visa', last4: '4242' },
		})
		expect(event?.paymentMethodRef).toMatch(/^src_/)
		expect(event?.providerCustomerRef).toMatch(/^cus_/)
		expect(JSON.stringify(event)).not.toContain('4242424242424242')
	})

	function mit(
		harness: Harness,
		stored: Awaited<ReturnType<typeof guarantee>>,
		amountMinor: number,
		key = `mit-${Math.random()}`,
	) {
		return chargeReservationFeeMit(harness.checkout, {
			subEntityId: stored.entity,
			sourceId: stored.payment.sourceId!,
			previousPaymentId: stored.payment.id,
			amountMinor,
			currency: 'SAR',
			processingChannelId: CHANNEL,
			reference: reservationFeeChargeReference({ feeId: 'fee_1', attempt: 1 }),
			platformFeeMinor: 75,
			idempotencyKey: key,
			metadata: buildReservationFeeMetadata({
				orgId: ORG,
				reservationId: RSV,
				feeId: 'fee_1',
			}),
		})
	}

	it('approves the MIT with the commission allocation, replays by key and ignores its own webhook', async () => {
		const harness = createTestHarness()
		const stored = await guarantee(harness)
		harness.deliveries.length = 0
		const outcome = await mit(harness, stored, 5000, 'fee-key')
		expect(outcome.status).toBe('succeeded')
		const paymentRef = (outcome as { paymentRef: string }).paymentRef
		const raw = (await harness.checkout.payments.get(paymentRef)) as {
			amount_allocations: Array<{ commission: { amount: number } }>
			merchant_initiated: boolean
		}
		expect(raw.merchant_initiated).toBe(true)
		expect(raw.amount_allocations[0]!.commission.amount).toBe(75)
		expect(await mit(harness, stored, 5000, 'fee-key')).toEqual(outcome)
		// The MIT's own payment events never look like a hosted-page payment.
		const events = harness.deliveries.map((delivery) =>
			JSON.parse(delivery.body),
		)
		expect(events.length).toBeGreaterThan(0)
		for (const event of events) {
			expect(mapCheckoutWebhookToReservationPayment(event)).toBeNull()
		}
	})

	it('an amount ending 05 declines with the response code (20005)', async () => {
		const harness = createTestHarness()
		const stored = await guarantee(harness)
		expect(await mit(harness, stored, 5005)).toMatchObject({
			status: 'failed',
			declineCode: '20005',
		})
	})

	it('the mock mada card approves the guarantee but its MIT declines with 20046', async () => {
		const harness = createTestHarness()
		const stored = await guarantee(harness, '5297412542005689')
		expect(await mit(harness, stored, 5000)).toMatchObject({
			status: 'failed',
			declineCode: '20046',
		})
	})

	it('a rejected request (unknown source) is a definitive failure with a stable code', async () => {
		const harness = createTestHarness()
		const stored = await guarantee(harness)
		const outcome = await chargeReservationFeeMit(harness.checkout, {
			subEntityId: stored.entity,
			sourceId: 'src_unknown',
			previousPaymentId: stored.payment.id,
			amountMinor: 5000,
			currency: 'SAR',
			processingChannelId: CHANNEL,
			reference: 'rsv_mit_x',
			platformFeeMinor: 0,
			idempotencyKey: 'k-unknown',
			metadata: {},
		})
		expect(outcome).toEqual({
			status: 'failed',
			paymentRef: null,
			declineCode: 'source_id_invalid',
		})
	})

	it('classifies provider errors: only validation, not-allowed and not-found are definitive', () => {
		for (const code of [400, 403, 404, 422]) {
			expect(isCheckoutDefinitiveRejection({ http_code: code })).toBe(true)
		}
		for (const code of [401, 408, 409, 429, 500, 502]) {
			expect(isCheckoutDefinitiveRejection({ http_code: code })).toBe(false)
		}
		expect(isCheckoutDefinitiveRejection(new TypeError('network'))).toBe(false)
	})
})

describe('Checkout.com refunds with commission reversal (VAL-PAY-026, VAL-PAY-027)', () => {
	async function captured(harness: Harness, amount = 10_000, fee = 1_001) {
		const { page, entity } = await hosted(harness, {
			amountMinor: amount,
			platformFeeMinor: fee,
		})
		const result = await pay(harness, page.id)
		harness.deliveries.length = 0
		return { entity, paymentId: result.paymentId }
	}

	function refund(
		harness: Harness,
		stored: { entity: string; paymentId: string },
		input: { amountMinor: number; feeReversalMinor: number; requestId: string },
	) {
		return createReservationCheckoutRefund(harness.checkout, {
			paymentId: stored.paymentId,
			subEntityId: stored.entity,
			amountMinor: input.amountMinor,
			feeReversalMinor: input.feeReversalMinor,
			reference: reservationRefundReference({
				refundRequestId: input.requestId,
				paymentRef: stored.paymentId,
			}),
			idempotencyKey: buildReservationRefundIdempotencyKey({
				orgId: ORG,
				refundRequestId: input.requestId,
			}),
		})
	}

	it('returns pending with the action id; reversals use the directive fee and sum to the snapshot', async () => {
		const harness = createTestHarness()
		const stored = await captured(harness, 3333, 333)
		// The regional directive's cumulative rounding: 167 then 166 of 333.
		const first = await refund(harness, stored, {
			amountMinor: 1667,
			feeReversalMinor: 167,
			requestId: 'rr_1',
		})
		const second = await refund(harness, stored, {
			amountMinor: 1666,
			feeReversalMinor: 166,
			requestId: 'rr_2',
		})
		expect(first).toMatchObject({ status: 'pending', amountMinor: 1667 })
		expect(first.refundRef).toMatch(/^act_/)
		expect(second.refundRef).not.toBe(first.refundRef)
		await harness.emulator.testing.advanceClock(5)
		const refunded = harness.deliveries
			.map((delivery) => JSON.parse(delivery.body))
			.filter((event) => event.type === 'payment_refunded')
		const commissions = refunded.flatMap((event) =>
			event.data.amount_allocations.map(
				(entry: { commission: { amount: number } }) => entry.commission.amount,
			),
		)
		expect(commissions.sort()).toEqual([166, 167])
		expect(
			commissions.reduce((sum: number, value: number) => sum + value, 0),
		).toBe(333)
	})

	it('replays by key; settles through the action list and the webhook identifies the request by reference', async () => {
		const harness = createTestHarness()
		const stored = await captured(harness)
		const input = {
			amountMinor: 4000,
			feeReversalMinor: 400,
			requestId: 'rr_ref',
		}
		const first = await refund(harness, stored, input)
		const replay = await refund(harness, stored, input)
		expect(replay.refundRef).toBe(first.refundRef)

		let actions = await listReservationCheckoutActions(
			harness.checkout,
			stored.paymentId,
		)
		const pending = actions.find((action) => action.id === first.refundRef)!
		expect(checkoutRefundActionStatus(pending)).toBe('pending')
		expect(pending.reference).toBe('rsv_refund_rr_ref')

		await harness.emulator.testing.advanceClock(5)
		actions = await listReservationCheckoutActions(
			harness.checkout,
			stored.paymentId,
		)
		expect(
			checkoutRefundActionStatus(
				actions.find((action) => action.id === first.refundRef)!,
			),
		).toBe('succeeded')

		const event = harness.deliveries
			.map((delivery) => JSON.parse(delivery.body))
			.find((entry) => entry.type === 'payment_refunded')
		const webhook = extractCheckoutRefundWebhook(event)!
		expect(webhook).toMatchObject({
			declined: false,
			paymentId: stored.paymentId,
			actionId: first.refundRef,
			amountMinor: 4000,
			orgId: ORG,
			reservationId: RSV,
		})
		// The emulator's event echoes the payment reference, so the caller reads
		// the refund reference from the action list instead.
		expect(buildCheckoutRefundEvent(webhook, null)).toBeNull()
		const action = actions.find((entry) => entry.id === webhook.actionId)!
		expect(buildCheckoutRefundEvent(webhook, action.reference)).toEqual({
			orgId: ORG,
			reservationId: RSV,
			refundRequestId: 'rr_ref',
			late: false,
			processor: 'checkout',
			paymentRef: stored.paymentId,
			refundRef: first.refundRef,
			amountMinor: 4000,
			currency: 'SAR',
			status: 'succeeded',
		})
	})

	it('a declined refund settles failed (payment_refund_declined)', async () => {
		const harness = createTestHarness()
		const stored = await captured(harness)
		const outcome = await refund(harness, stored, {
			amountMinor: 6000,
			feeReversalMinor: 600,
			requestId: 'rr_decl',
		})
		await harness.emulator.testing.forceCheckoutRefundDecline(
			outcome.refundRef!,
		)
		await harness.emulator.testing.advanceClock(5)
		const declined = harness.deliveries
			.map((delivery) => JSON.parse(delivery.body))
			.find((entry) => entry.type === 'payment_refund_declined')
		const webhook = extractCheckoutRefundWebhook(declined)!
		expect(webhook.declined).toBe(true)
		expect(
			buildCheckoutRefundEvent(webhook, 'rsv_refund_rr_decl')?.status,
		).toBe('failed')
		const actions = await listReservationCheckoutActions(
			harness.checkout,
			stored.paymentId,
		)
		expect(
			checkoutRefundActionStatus(
				actions.find((a) => a.id === outcome.refundRef)!,
			),
		).toBe('failed')
	})

	it('late-payment refunds read back their marker; unrelated refunds are ignored', async () => {
		const harness = createTestHarness()
		const stored = await captured(harness)
		const late = await createReservationCheckoutRefund(harness.checkout, {
			paymentId: stored.paymentId,
			subEntityId: stored.entity,
			amountMinor: 10_000,
			feeReversalMinor: 1_001,
			reference: reservationRefundReference({ paymentRef: stored.paymentId }),
			idempotencyKey: `reservation_late_refund_${stored.paymentId}`,
		})
		await harness.emulator.testing.advanceClock(5)
		const event = harness.deliveries
			.map((delivery) => JSON.parse(delivery.body))
			.find((entry) => entry.type === 'payment_refunded')
		const webhook = extractCheckoutRefundWebhook(event)!
		const actions = await listReservationCheckoutActions(
			harness.checkout,
			stored.paymentId,
		)
		const reference = actions.find(
			(action) => action.id === late.refundRef,
		)!.reference
		expect(buildCheckoutRefundEvent(webhook, reference)).toMatchObject({
			refundRequestId: null,
			late: true,
		})
		expect(buildCheckoutRefundEvent(webhook, 'order_refund_1')).toBeNull()
	})

	it('a definitive rejection (over-refund) is failed; the id is null', async () => {
		const harness = createTestHarness()
		const stored = await captured(harness)
		const outcome = await refund(harness, stored, {
			amountMinor: 10_001,
			feeReversalMinor: 0,
			requestId: 'rr_over',
		})
		expect(outcome).toMatchObject({ status: 'failed', refundRef: null })
	})
})

describe('Checkout.com disputes', () => {
	it('maps dispute events through the payment metadata', async () => {
		const harness = createTestHarness()
		const { page } = await hosted(harness)
		const result = await pay(harness, page.id)
		const payment = await retrieveReservationCheckoutPayment(
			harness.checkout,
			result.paymentId,
		)
		const received = extractCheckoutDisputeWebhook({
			type: 'dispute_received',
			data: { id: 'dsp_1', payment_id: result.paymentId },
		})!
		expect(mapCheckoutDisputeToReservation(received, payment)).toEqual({
			orgId: ORG,
			reservationId: RSV,
			processor: 'checkout',
			paymentRef: result.paymentId,
			disputeRef: 'dsp_1',
			status: 'opened',
		})
		for (const [type, status] of [
			['dispute_won', 'won'],
			['dispute_lost', 'lost'],
			['dispute_canceled', 'closed'],
		] as const) {
			expect(
				extractCheckoutDisputeWebhook({
					type,
					data: { id: 'dsp_1', payment_id: result.paymentId },
				})?.status,
			).toBe(status)
		}
		expect(
			extractCheckoutDisputeWebhook({ type: 'payment_approved', data: {} }),
		).toBeNull()
		expect(
			mapCheckoutDisputeToReservation(received, {
				...payment,
				metadata: { type: 'restaurant_order', orgId: ORG },
			}),
		).toBeNull()
	})
})
