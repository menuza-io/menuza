import { describe, expect, it } from 'vitest'
import { activeEntity, createTestHarness, type Harness } from '../test-helpers'

const channel = 'pc_mockmockmockmockmockm'

async function citPayment(
	harness: Harness,
	card = '4242424242424242',
	amount = 20_000,
) {
	const entity = await activeEntity(harness)
	const hpp = (await harness.checkout.hostedPayments.create({
		amount,
		currency: 'SAR',
		reference: 'shop_payment:org_a:ord_9',
		processing_channel_id: channel,
		payment_type: 'Unscheduled',
		billing: { address: { country: 'SA' } },
		success_url: 'http://localhost:3008/shop/done',
		failure_url: 'http://localhost:3008/shop',
		cancel_url: 'http://localhost:3008/shop',
		metadata: {
			type: 'shop_payment',
			orgId: 'org_a',
			orderRef: 'ord_9',
		},
		amount_allocations: [{ id: entity, amount, commission: { amount: 0 } }],
	} as never)) as { id: string }
	const result = (await harness.emulator.testing.completeHostedPayment(hpp.id, {
		card,
	})) as {
		status: string
		paymentId: string
	}
	const payment = (await harness.checkout.payments.get(
		result.paymentId,
	)) as Record<string, any>
	return { entity, payment, result }
}

function mit(
	harness: Harness,
	entity: string,
	source: string,
	previous: string,
	amount: number,
	extra: Record<string, unknown> = {},
) {
	return harness.checkout.payments.request(
		{
			source: { type: 'id', id: source },
			merchant_initiated: true,
			payment_type: 'Unscheduled',
			previous_payment_id: previous,
			amount,
			currency: 'SAR',
			processing_channel_id: channel,
			reference: 'shop_fee:org_a:fee_1',
			metadata: { type: 'shop_fee' },
			amount_allocations: [{ id: entity, amount, commission: { amount: 0 } }],
			...extra,
		} as never,
		`idem-${Math.random()}`,
	) as Promise<Record<string, any>>
}

describe('Checkout.com stored instrument and MIT', () => {
	it('an Unscheduled customer-initiated payment stores the card and exposes src_, cus_ and scheme_id', async () => {
		const harness = createTestHarness()
		const { payment } = await citPayment(harness)
		expect(payment.source.id).toMatch(/^src_/)
		expect(payment.customer.id).toMatch(/^cus_/)
		expect(payment.scheme_id).toMatch(/^\d{15}$/)
		expect(payment.payment_type).toBe('Unscheduled')
		expect(JSON.stringify(payment)).not.toContain('4242424242424242')
	})

	it('a Regular payment stores nothing', async () => {
		const harness = createTestHarness()
		const entity = await activeEntity(harness)
		const hpp = (await harness.checkout.hostedPayments.create({
			amount: 1000,
			currency: 'SAR',
			reference: 'r',
			processing_channel_id: channel,
			billing: { address: { country: 'SA' } },
			success_url: 'http://localhost:3008/a',
			failure_url: 'http://localhost:3008/b',
			cancel_url: 'http://localhost:3008/c',
			amount_allocations: [
				{ id: entity, amount: 1000, commission: { amount: 0 } },
			],
		} as never)) as { id: string }
		const result = (await harness.emulator.testing.completeHostedPayment(
			hpp.id,
		)) as { paymentId: string }
		const payment = (await harness.checkout.payments.get(
			result.paymentId,
		)) as Record<string, any>
		expect(payment.source.id).toBeUndefined()
	})

	it('MIT approves for Visa and carries the stored source', async () => {
		const harness = createTestHarness()
		const { entity, payment } = await citPayment(harness)
		const charge = await mit(
			harness,
			entity,
			payment.source.id,
			payment.id,
			5_000,
		)
		expect(charge).toMatchObject({
			approved: true,
			status: 'Captured',
			response_code: '10000',
		})
		expect(charge.source.id).toBe(payment.source.id)
		const stored = (await harness.checkout.payments.get(charge.id)) as Record<
			string,
			any
		>
		expect(stored).toMatchObject({
			merchant_initiated: true,
			previous_payment_id: payment.id,
		})
	})

	it('an amount ending 05 declines with 20005 as a 201 with approved:false', async () => {
		const harness = createTestHarness()
		const { entity, payment } = await citPayment(harness)
		const charge = await mit(
			harness,
			entity,
			payment.source.id,
			payment.id,
			5_005,
		)
		expect(charge).toMatchObject({
			approved: false,
			status: 'Declined',
			response_code: '20005',
		})
		const events = await harness.emulator.events.list({
			provider: 'checkout',
			type: 'payment_declined',
		})
		expect(events).toHaveLength(1)
	})

	it('the labeled mock mada card approves the CIT but its MIT declines with 20046', async () => {
		const harness = createTestHarness()
		const { entity, payment, result } = await citPayment(
			harness,
			'5297412542005689',
		)
		// mada is 3DS, so the headless helper passes the right password.
		expect(result.status).toBe('approved')
		const charge = await mit(
			harness,
			entity,
			payment.source.id,
			payment.id,
			5_000,
		)
		expect(charge).toMatchObject({
			approved: false,
			status: 'Declined',
			response_code: '20046',
		})
		expect(charge.response_summary).toContain('mock')
	})

	it('previous_payment_id must be a customer-initiated payment on the same source', async () => {
		const harness = createTestHarness()
		const first = await citPayment(harness)
		const second = await citPayment(harness)
		const good = await mit(
			harness,
			first.entity,
			first.payment.source.id,
			first.payment.id,
			5_000,
		)
		expect(good.approved).toBe(true)
		// Another source's CIT, an MIT as the "previous" payment, and a missing id.
		for (const previous of [
			second.payment.id,
			good.id,
			'pay_nope',
			undefined,
		]) {
			const error = await mit(
				harness,
				first.entity,
				first.payment.source.id,
				previous as string,
				5_000,
				{
					previous_payment_id: previous,
				},
			).catch((thrown) => thrown)
			expect(error.name).toBe('ValidationError')
			expect(error.body.error_type).toBe('request_invalid')
		}
		const unknownSource = await mit(
			harness,
			first.entity,
			'src_unknown',
			first.payment.id,
			5_000,
		).catch((thrown) => thrown)
		expect(unknownSource.body.error_codes).toContain('source_id_invalid')
	})

	it('honors Cko-Idempotency-Key on payments', async () => {
		const harness = createTestHarness()
		const { entity, payment } = await citPayment(harness)
		const body = {
			source: { type: 'id', id: payment.source.id },
			merchant_initiated: true,
			payment_type: 'Unscheduled',
			previous_payment_id: payment.id,
			amount: 4_000,
			currency: 'SAR',
			processing_channel_id: channel,
			amount_allocations: [
				{ id: entity, amount: 4_000, commission: { amount: 0 } },
			],
		}
		const first = (await harness.checkout.payments.request(
			body as never,
			'same-key',
		)) as Record<string, any>
		const second = (await harness.checkout.payments.request(
			body as never,
			'same-key',
		)) as Record<string, any>
		expect(second.id).toBe(first.id)
		const mismatch = await harness.checkout.payments
			.request(
				{
					...body,
					amount: 4_100,
					amount_allocations: [{ id: entity, amount: 4_100 }],
				} as never,
				'same-key',
			)
			.catch((thrown) => thrown)
		expect(mismatch.http_code ?? mismatch.status).toBe(409)
	})
})
