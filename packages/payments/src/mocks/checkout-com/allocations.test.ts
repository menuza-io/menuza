import { describe, expect, it } from 'vitest'
import { activeEntity, createTestHarness, type Harness } from '../test-helpers'

const channel = 'pc_mockmockmockmockmockm'

function hppBody(allocations: unknown, amount = 10_000) {
	return {
		amount,
		currency: 'SAR',
		reference: 'order:1',
		processing_channel_id: channel,
		billing: { address: { country: 'SA' } },
		success_url: 'http://localhost:3008/a',
		failure_url: 'http://localhost:3008/b',
		cancel_url: 'http://localhost:3008/c',
		metadata: { orderId: 'o_1' },
		amount_allocations: allocations,
	} as never
}

async function errorCodes(harness: Harness, allocations: unknown) {
	const error = await harness.checkout.hostedPayments
		.create(hppBody(allocations))
		.catch((thrown) => thrown)
	expect(error.name).toBe('ValidationError')
	expect(error.body.error_type).toBe('request_invalid')
	return error.body.error_codes as string[]
}

describe('Checkout.com amount allocations', () => {
	it('stores allocations and commission and carries them in the approved webhook', async () => {
		const harness = createTestHarness()
		const entity = await activeEntity(harness)
		const hpp = (await harness.checkout.hostedPayments.create(
			hppBody([{ id: entity, amount: 10_000, commission: { amount: 2_000 } }]),
		)) as { id: string }
		harness.deliveries.length = 0
		const result = (await harness.emulator.testing.completeHostedPayment(
			hpp.id,
		)) as { paymentId: string }
		const payment = (await harness.checkout.payments.get(
			result.paymentId,
		)) as Record<string, any>
		expect(payment.amount_allocations).toEqual([
			{
				id: entity,
				amount: 10_000,
				commission: { amount: 2_000, percentage: 20 },
			},
		])
		const approved = harness.deliveries
			.map((entry) => JSON.parse(entry.body))
			.find((event) => event.type === 'payment_approved')
		expect(approved.data.amount_allocations).toEqual(payment.amount_allocations)
	})

	it('rejects unknown ids and entities that are not payments-enabled', async () => {
		const harness = createTestHarness()
		expect(
			await errorCodes(harness, [
				{ id: 'ent_unknown', amount: 10_000, commission: { amount: 0 } },
			]),
		).toContain('amount_allocations_id_invalid')
		const draft = (await harness.checkout.platforms.onboardSubEntity({
			reference: 'org_draft',
			contact_details: { invitee: { email: 'a@example.test' } },
			is_draft: true,
		} as never)) as { id: string }
		expect(
			await errorCodes(harness, [
				{ id: draft.id, amount: 10_000, commission: { amount: 0 } },
			]),
		).toContain('amount_allocations_id_invalid')
	})

	it('rejects amounts that do not sum to the payment amount', async () => {
		const harness = createTestHarness()
		const entity = await activeEntity(harness)
		expect(
			await errorCodes(harness, [
				{ id: entity, amount: 9_000, commission: { amount: 0 } },
			]),
		).toContain('amount_allocations_amount_invalid')
		expect(
			await errorCodes(harness, [
				{ id: entity, amount: 6_000 },
				{ id: entity, amount: 6_000 },
			]),
		).toContain('amount_allocations_amount_invalid')
	})

	it('rejects commission above the allocation', async () => {
		const harness = createTestHarness()
		const entity = await activeEntity(harness)
		expect(
			await errorCodes(harness, [
				{ id: entity, amount: 10_000, commission: { amount: 10_001 } },
			]),
		).toContain('amount_allocations_commission_invalid')
	})

	it('allows no allocations at all', async () => {
		const harness = createTestHarness()
		const hpp = await harness.checkout.hostedPayments.create(hppBody(undefined))
		expect((hpp as { id: string }).id).toMatch(/^hpp_/)
	})
})
