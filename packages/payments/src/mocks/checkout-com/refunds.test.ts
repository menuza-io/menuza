import { describe, expect, it } from 'vitest'
import { activeEntity, createTestHarness, type Harness } from '../test-helpers'

const channel = 'pc_mockmockmockmockmockm'

async function capturedPayment(
	harness: Harness,
	amount = 10_000,
	commission = 2_000,
) {
	const entity = await activeEntity(harness)
	const hpp = (await harness.checkout.hostedPayments.create({
		amount,
		currency: 'SAR',
		reference: 'order:1',
		processing_channel_id: channel,
		billing: { address: { country: 'SA' } },
		success_url: 'http://localhost:3008/a',
		failure_url: 'http://localhost:3008/b',
		cancel_url: 'http://localhost:3008/c',
		metadata: { orderId: 'o_1' },
		amount_allocations: [
			{ id: entity, amount, commission: { amount: commission } },
		],
	} as never)) as { id: string }
	const result = (await harness.emulator.testing.completeHostedPayment(
		hpp.id,
	)) as { paymentId: string }
	harness.deliveries.length = 0
	return { entity, paymentId: result.paymentId }
}

const events = (harness: Harness) =>
	harness.deliveries.map((entry) => JSON.parse(entry.body))

describe('Checkout.com refunds with allocation reversal (VAL-PMOCK-036)', () => {
	it('202 with an action_id, settles lazily approved, emits payment_refunded with reversal allocations', async () => {
		const harness = createTestHarness()
		const { entity, paymentId } = await capturedPayment(harness)
		const refund = (await harness.checkout.payments.refund(
			paymentId,
			{ amount: 4_000, reference: 'refund_1' } as never,
			'refund-key-1',
		)) as Record<string, any>
		expect(refund.action_id).toMatch(/^act_/)
		expect(events(harness)).toHaveLength(0)
		const pending = (await harness.checkout.payments.getActions(
			paymentId,
		)) as Array<Record<string, any>>
		expect(
			pending.find((action) => action.id === refund.action_id),
		).toMatchObject({ type: 'Refund', approved: null })

		await harness.emulator.testing.advanceClock(5)
		const [event] = events(harness)
		expect(event.type).toBe('payment_refunded')
		expect(event.data).toMatchObject({
			id: paymentId,
			action_id: refund.action_id,
			amount: 4_000,
			approved: true,
		})
		// 40% of the refund, and 40% of the commission, never more than allocated.
		expect(event.data.amount_allocations).toEqual([
			{ id: entity, amount: 4_000, commission: { amount: 800 } },
		])
		const payment = (await harness.checkout.payments.get(paymentId)) as Record<
			string,
			any
		>
		expect(payment.status).toBe('Partially Refunded')
		expect(payment.balances).toMatchObject({
			total_refunded: 4_000,
			available_to_refund: 6_000,
		})
	})

	it('the final refund reverses exactly what is left, so allocations add up', async () => {
		const harness = createTestHarness()
		const { entity, paymentId } = await capturedPayment(harness, 10_000, 1_001)
		for (const amount of [3_333, 3_333]) {
			await harness.checkout.payments.refund(paymentId, { amount } as never)
		}
		await harness.checkout.payments.refund(paymentId, {} as never)
		await harness.emulator.testing.advanceClock(5)
		const reversals = events(harness).filter(
			(event) => event.type === 'payment_refunded',
		)
		expect(reversals).toHaveLength(3)
		const total = reversals
			.flatMap((event) => event.data.amount_allocations)
			.reduce(
				(sum, entry: { amount: number; commission: { amount: number } }) => ({
					amount: sum.amount + entry.amount,
					commission: sum.commission + entry.commission.amount,
				}),
				{ amount: 0, commission: 0 },
			)
		expect(total).toEqual({ amount: 10_000, commission: 1_001 })
		expect(
			reversals.every(
				(event) => event.data.amount_allocations[0].id === entity,
			),
		).toBe(true)
		expect(
			((await harness.checkout.payments.get(paymentId)) as Record<string, any>)
				.status,
		).toBe('Refunded')
	})

	it('refuses a refund beyond what is left, counting refunds still pending', async () => {
		const harness = createTestHarness()
		const { paymentId } = await capturedPayment(harness)
		await harness.checkout.payments.refund(paymentId, {
			amount: 7_000,
		} as never)
		const error = await harness.checkout.payments
			.refund(paymentId, { amount: 3_001 } as never)
			.catch((thrown) => thrown)
		expect(error.body.error_codes).toContain('refund_amount_exceeds_balance')
	})

	it('a caller-supplied reversal must stay inside the allocation and the refund', async () => {
		const harness = createTestHarness()
		const { entity, paymentId } = await capturedPayment(harness)
		const bad = [
			{ id: entity, amount: 4_001, commission: { amount: 0 } },
			{ id: entity, amount: 4_000, commission: { amount: 4_001 } },
			{ id: 'ent_other', amount: 4_000, commission: { amount: 0 } },
		]
		for (const allocations of bad) {
			const error = await harness.checkout.payments
				.refund(paymentId, {
					amount: 4_000,
					amount_allocations: [allocations],
				} as never)
				.catch((thrown) => thrown)
			expect(error.body.error_type).toBe('request_invalid')
		}
		const good = (await harness.checkout.payments.refund(paymentId, {
			amount: 4_000,
			amount_allocations: [
				{ id: entity, amount: 4_000, commission: { amount: 500 } },
			],
		} as never)) as Record<string, any>
		expect(good.action_id).toBeTruthy()
		await harness.emulator.testing.advanceClock(5)
		expect(
			events(harness)[0]!.data.amount_allocations[0].commission.amount,
		).toBe(500)
	})

	it('a forced decline emits payment_refund_declined and gives the amount back', async () => {
		const harness = createTestHarness()
		const { paymentId } = await capturedPayment(harness)
		const refund = (await harness.checkout.payments.refund(paymentId, {
			amount: 6_000,
		} as never)) as Record<string, any>
		await harness.emulator.testing.forceCheckoutRefundDecline(refund.action_id)
		await harness.emulator.testing.advanceClock(5)
		expect(events(harness)[0]!.type).toBe('payment_refund_declined')
		const payment = (await harness.checkout.payments.get(paymentId)) as Record<
			string,
			any
		>
		expect(payment.balances.total_refunded).toBe(0)
		// The full amount can be refunded again.
		await expect(
			harness.checkout.payments.refund(paymentId, {} as never),
		).resolves.toBeTruthy()
	})

	it('replays Cko-Idempotency-Key on refunds', async () => {
		const harness = createTestHarness()
		const { paymentId } = await capturedPayment(harness)
		const first = (await harness.checkout.payments.refund(
			paymentId,
			{ amount: 1_000 } as never,
			'r-key',
		)) as Record<string, any>
		const second = (await harness.checkout.payments.refund(
			paymentId,
			{ amount: 1_000 } as never,
			'r-key',
		)) as Record<string, any>
		expect(second.action_id).toBe(first.action_id)
		await harness.emulator.testing.advanceClock(5)
		expect(
			events(harness).filter((event) => event.type === 'payment_refunded'),
		).toHaveLength(1)
	})

	it('declined payments cannot be refunded', async () => {
		const harness = createTestHarness()
		const entity = await activeEntity(harness)
		const hpp = (await harness.checkout.hostedPayments.create({
			amount: 1005,
			currency: 'SAR',
			reference: 'declined',
			processing_channel_id: channel,
			billing: { address: { country: 'SA' } },
			success_url: 'http://localhost:3008/a',
			failure_url: 'http://localhost:3008/b',
			cancel_url: 'http://localhost:3008/c',
			amount_allocations: [{ id: entity, amount: 1005 }],
		} as never)) as { id: string }
		const result = (await harness.emulator.testing.completeHostedPayment(
			hpp.id,
		)) as { paymentId: string }
		const error = await harness.checkout.payments
			.refund(result.paymentId, {} as never)
			.catch((thrown) => thrown)
		expect(error.http_code ?? error.status).toBe(403)
	})
})
