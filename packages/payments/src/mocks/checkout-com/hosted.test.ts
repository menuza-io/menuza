import { describe, expect, it } from 'vitest'
import {
	activeEntity,
	checkoutSignatureValid,
	createTestHarness,
	type Harness,
} from '../test-helpers'

async function hosted(
	harness: Harness,
	amount = 12_000,
	reference = 'shop_order:org_a:ord_1',
) {
	const entity = await activeEntity(harness)
	const hpp = (await harness.checkout.hostedPayments.create({
		amount,
		currency: 'SAR',
		reference,
		processing_channel_id: 'pc_mockmockmockmockmockm',
		billing: { address: { country: 'SA' } },
		success_url: 'http://localhost:3008/menu/success?order=ord_1',
		failure_url: 'http://localhost:3008/menu',
		cancel_url: 'http://localhost:3008/menu',
		metadata: { type: 'shop_order', orgId: 'org_a', orderId: 'ord_1' },
		amount_allocations: [
			{ id: entity, amount, commission: { amount: Math.round(amount / 5) } },
		],
	} as never)) as { id: string }
	return { entity, hppId: hpp.id }
}

describe('Checkout.com hosted payment page', () => {
	it('frictionless Visa and Mastercard approve and emit signed approved + captured events', async () => {
		const harness = createTestHarness()
		for (const card of ['4242424242424242', '5436031030606378']) {
			const { hppId } = await hosted(harness)
			harness.deliveries.length = 0
			const result = await harness.emulator.testing.completeHostedPayment(
				hppId,
				{ card },
			)
			expect(result.status).toBe('approved')
			const types = harness.deliveries.map(
				(entry) => JSON.parse(entry.body).type,
			)
			expect(types).toEqual(['payment_approved', 'payment_captured'])
			for (const delivery of harness.deliveries) {
				expect(delivery.path).toBe('/api/shop/webhook')
				expect(await checkoutSignatureValid(delivery)).toBe(true)
			}
			const data = JSON.parse(harness.deliveries[0]!.body).data
			expect(data).toMatchObject({
				amount: 12_000,
				currency: 'SAR',
				approved: true,
				reference: 'shop_order:org_a:ord_1',
				metadata: {
					type: 'shop_order',
					orgId: 'org_a',
					orderId: 'ord_1',
				},
			})
			expect(data.processing.payment_session_id).toBeUndefined()
		}
	})

	it('the HPP id rides on processing.payment_session_id only with the fidelity switch', async () => {
		const harness = createTestHarness({
			fidelity: { checkoutSessionIdOnWebhooks: true },
		})
		const { hppId } = await hosted(harness)
		harness.deliveries.length = 0
		await harness.emulator.testing.completeHostedPayment(hppId)
		expect(
			JSON.parse(harness.deliveries[0]!.body).data.processing
				.payment_session_id,
		).toBe(hppId)
	})

	it('amount-based declines fail at submit and redirect to failure_url', async () => {
		const harness = createTestHarness()
		const expected: Record<string, [number, string]> = {
			'05': [1005, '20005'],
			'51': [1051, '20051'],
			'12': [1012, '20012'],
			'54': [1054, '20054'],
		}
		for (const [amount, code] of Object.values(expected)) {
			const { hppId } = await hosted(harness, amount)
			harness.deliveries.length = 0
			const result = await harness.emulator.testing.completeHostedPayment(hppId)
			expect(result.status).toBe('declined')
			const declined = result as {
				redirectUrl: string
				sessionId: string
				paymentId: string
			}
			expect(declined.redirectUrl).toBe(
				`http://localhost:3008/menu?cko-session-id=${declined.sessionId}`,
			)
			const payment = (await harness.emulator.object(
				'checkout',
				declined.sessionId,
			)) as Record<string, any>
			expect(payment).toMatchObject({
				approved: false,
				status: 'Declined',
				response_code: code,
			})
			expect(JSON.parse(harness.deliveries[0]!.body).type).toBe(
				'payment_declined',
			)
			// A declined HPP stays pending with no associated payment.
			const page = (await harness.checkout.hostedPayments.get(hppId)) as Record<
				string,
				any
			>
			expect(page).toMatchObject({
				status: 'Payment Pending',
				payment_id: null,
			})
		}
	})

	it('3DS: the wrong password fails, Checkout1! succeeds', async () => {
		const harness = createTestHarness()
		const wrong = await hosted(harness)
		const first = await harness.emulator.pages.checkout.submit(wrong.hppId, {
			number: '4543 4740 0224 9996',
			expiry: '12/34',
			cvc: '100',
		})
		expect(first.status).toBe('requires_3ds')
		const attemptId = (first as { attemptId: string }).attemptId
		expect(
			await harness.emulator.pages.checkout.describeAttempt(attemptId),
		).toMatchObject({ open: true })
		const failed = await harness.emulator.pages.checkout.resolveThreeDS(
			attemptId,
			'nope',
		)
		expect(failed.status).toBe('declined')
		expect(
			await harness.emulator.pages.checkout.resolveThreeDS(
				attemptId,
				'Checkout1!',
			),
		).toMatchObject({ status: 'inactive' })

		const fresh = await hosted(harness, 12_000, 'shop_order:org_a:ord_2')
		const challenge = await harness.emulator.pages.checkout.submit(
			fresh.hppId,
			{
				number: '5352151570003404',
				expiry: '12/34',
				cvc: '100',
			},
		)
		const paid = await harness.emulator.pages.checkout.resolveThreeDS(
			(challenge as { attemptId: string }).attemptId,
			'Checkout1!',
		)
		expect(paid.status).toBe('approved')
	})

	it('one hosted page is paid once under a race', async () => {
		const harness = createTestHarness()
		const { hppId } = await hosted(harness)
		const results = await Promise.all([
			harness.emulator.testing.completeHostedPayment(hppId),
			harness.emulator.testing.completeHostedPayment(hppId),
		])
		expect(results.map((entry) => entry.status).sort()).toEqual([
			'approved',
			'inactive',
		])
	})

	it('rejects bad card input and unknown cards', async () => {
		const harness = createTestHarness()
		const { hppId } = await hosted(harness)
		expect(
			await harness.emulator.testing.completeHostedPayment(hppId, {
				card: '4242424242424241',
			}),
		).toMatchObject({ status: 'invalid', field: 'number' })
		const unknown = await harness.emulator.testing.completeHostedPayment(
			hppId,
			{ card: '4111111111111111' },
		)
		expect(unknown.status).toBe('declined')
	})

	it('inline mode delivers the webhook before the redirect is returned; manual does not', async () => {
		const manual = createTestHarness({ webhookMode: 'manual' })
		const { hppId } = await hosted(manual)
		await manual.emulator.testing.completeHostedPayment(hppId)
		expect(manual.deliveries).toHaveLength(0)
		// The status is still discoverable through the API without any webhook.
		const status = (await manual.checkout.hostedPayments.get(hppId)) as {
			payment_id: string
		}
		const payment = (await manual.checkout.payments.get(
			status.payment_id,
		)) as Record<string, any>
		expect(payment.approved).toBe(true)
		const flush = await manual.emulator.events.flush({ provider: 'checkout' })
		expect(flush.delivered).toBe(2)
		expect(
			(await manual.emulator.events.list({ provider: 'checkout' })).every(
				(entry) => entry.lastStatus === 200,
			),
		).toBe(true)
	})

	it('shows the dashboard snapshot with allocations and commission', async () => {
		const harness = createTestHarness()
		const { hppId, entity } = await hosted(harness, 10_000)
		await harness.emulator.testing.completeHostedPayment(hppId)
		const snapshot = await harness.emulator.pages.checkout.dashboard()
		expect(snapshot.entities.map((item) => item.id)).toContain(entity)
		expect(snapshot.payments[0]!.amount_allocations).toEqual([
			{
				id: entity,
				amount: 10_000,
				commission: { amount: 2_000, percentage: 20 },
			},
		])
	})
})

describe('Checkout.com sub-entities', () => {
	it('starts as a draft that is not payments-enabled until the dashboard activates it', async () => {
		const harness = createTestHarness()
		const entity = (await harness.checkout.platforms.onboardSubEntity({
			reference: 'org_riyadh',
			contact_details: { invitee: { email: 'owner@example.test' } },
			is_draft: true,
		} as never)) as { id: string; status: string; capabilities: any }
		expect(entity.id).toMatch(/^ent_/)
		expect(entity).toMatchObject({
			status: 'draft',
			capabilities: { payments: { enabled: false } },
		})
		const details = (await harness.checkout.platforms.getSubEntityDetails(
			entity.id,
		)) as Record<string, any>
		expect(details.capabilities.payments.enabled).toBe(false)
		await harness.emulator.pages.checkout.activate(entity.id, {
			payments: true,
		})
		const active = (await harness.checkout.platforms.getSubEntityDetails(
			entity.id,
		)) as Record<string, any>
		expect(active).toMatchObject({
			status: 'active',
			capabilities: {
				payments: { enabled: true },
				payouts: { enabled: false },
			},
		})
	})

	it('422 for a missing reference or email', async () => {
		const harness = createTestHarness()
		const error = await harness.checkout.platforms
			.onboardSubEntity({
				contact_details: { invitee: { email: 'nope' } },
			} as never)
			.catch((thrown) => thrown)
		expect(error.body.error_codes).toEqual([
			'reference_required',
			'contact_details_invitee_email_invalid',
		])
	})
})
