import { Checkout } from 'checkout-sdk-node'
import { describe, expect, it } from 'vitest'
import { MOCK_CHECKOUT_HOST, MOCK_CHECKOUT_PUBLIC_KEY } from '../env'
import { activeEntity, createTestHarness, type Harness } from '../test-helpers'

const hppBody = (entity: string, overrides: Record<string, unknown> = {}) => ({
	amount: 12_000,
	currency: 'SAR',
	reference: 'restaurant_order:org_a:ord_1',
	description: 'Restaurant order',
	processing_channel_id: 'pc_mockmockmockmockmockm',
	billing: { address: { country: 'SA' } },
	success_url: 'http://localhost:3008/menu/success?order=ord_1',
	failure_url: 'http://localhost:3008/menu',
	cancel_url: 'http://localhost:3008/menu',
	metadata: { type: 'restaurant_order', orgId: 'org_a', orderId: 'ord_1' },
	amount_allocations: [
		{ id: entity, amount: 12_000, commission: { amount: 2_400 } },
	],
	...overrides,
})

async function hostedPayment(
	harness: Harness,
	overrides: Record<string, unknown> = {},
) {
	const entity = await activeEntity(harness)
	const hpp = (await harness.checkout.hostedPayments.create(
		hppBody(entity, overrides) as never,
	)) as {
		id: string
		_links: { redirect: { href: string }; self: { href: string } }
	}
	return { entity, hpp }
}

describe('Checkout.com protocol fidelity (VAL-PMOCK-037)', () => {
	it('answers 401 for a bad Authorization key', async () => {
		createTestHarness()
		const wrong = new Checkout('sk_sbox_wrongkeywrongkeywrongkeyabc', {
			pk: MOCK_CHECKOUT_PUBLIC_KEY,
			subdomain: 'mock',
			host: MOCK_CHECKOUT_HOST,
		})
		const error = await wrong.payments.get('pay_x').catch((thrown) => thrown)
		expect(error.name).toBe('AuthenticationError')
	})

	it('answers 422 request_invalid with error codes for malformed requests', async () => {
		const harness = createTestHarness()
		const error = await harness.checkout.hostedPayments
			.create({ amount: 'ten', currency: 'SAR' } as never)
			.catch((thrown) => thrown)
		expect(error.name).toBe('ValidationError')
		expect(error.http_code).toBe(422)
		expect(error.body).toMatchObject({ error_type: 'request_invalid' })
		expect(error.body.request_id).toMatch(/^req_/)
		expect(error.body.error_codes).toEqual(
			expect.arrayContaining([
				'amount_required',
				'reference_required',
				'success_url_required',
			]),
		)
	})

	it('POST /payment-sessions (Flow) has an id and tokens but no redirect link', async () => {
		const harness = createTestHarness()
		const entity = await activeEntity(harness)
		const session = (await harness.checkout.paymentSessions.request(
			hppBody(entity) as never,
		)) as Record<string, any>
		expect(session.id).toMatch(/^ps_/)
		expect(session.payment_session_token).toBeTruthy()
		expect(session.payment_session_secret).toBeTruthy()
		expect(session._links.self.href).toContain(session.id)
		expect(session._links.redirect).toBeUndefined()
	})

	it('creates a hosted page whose redirect link is the mock page', async () => {
		const harness = createTestHarness()
		const { hpp } = await hostedPayment(harness)
		expect(hpp.id).toMatch(/^hpp_[a-z2-7]{26}$/)
		expect(hpp._links.redirect.href).toBe(
			`http://localhost:3001/mock-payments/checkout-com/hpp/${hpp.id}`,
		)
		const fetched = (await harness.checkout.hostedPayments.get(
			hpp.id,
		)) as Record<string, any>
		expect(fetched).toMatchObject({
			id: hpp.id,
			status: 'Payment Pending',
			payment_id: null,
		})
	})

	it('GET /payments/{id} resolves both pay_ and sid_ ids', async () => {
		const harness = createTestHarness()
		const { hpp } = await hostedPayment(harness)
		const result = await harness.emulator.testing.completeHostedPayment(hpp.id)
		expect(result.status).toBe('approved')
		const approved = result as {
			sessionId: string
			paymentId: string
			redirectUrl: string
		}
		expect(approved.redirectUrl).toBe(
			`http://localhost:3008/menu/success?order=ord_1&cko-session-id=${approved.sessionId}`,
		)
		const byPayment = (await harness.checkout.payments.get(
			approved.paymentId,
		)) as Record<string, any>
		const bySession = (await harness.checkout.payments.get(
			approved.sessionId,
		)) as Record<string, any>
		expect(byPayment.id).toBe(approved.paymentId)
		expect(bySession.id).toBe(approved.paymentId)
		expect(byPayment).toMatchObject({
			approved: true,
			status: 'Captured',
			amount: 12_000,
			currency: 'SAR',
		})
		expect(byPayment.metadata).toMatchObject({ orderId: 'ord_1' })
		const hosted = (await harness.checkout.hostedPayments.get(
			hpp.id,
		)) as Record<string, any>
		expect(hosted).toMatchObject({
			status: 'Payment Received',
			payment_id: approved.paymentId,
		})
	})

	it('404 for an unknown payment, 501 for an unimplemented endpoint', async () => {
		const harness = createTestHarness()
		expect(
			await harness.checkout.payments.get('pay_nope').catch((thrown) => thrown),
		).toMatchObject({
			name: 'NotFoundError',
		})
		const response = await harness.emulator.checkout.fetch(
			new Request(`${MOCK_CHECKOUT_HOST}/forex/quotes`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer sk_sbox_mockplatformmockplatformmoc',
				},
				body: '{}',
			}),
		)
		expect(response.status).toBe(501)
		expect(harness.logs.some((line) => line.includes('/forex/quotes'))).toBe(
			true,
		)
	})

	it('searches payments by reference', async () => {
		const harness = createTestHarness()
		const { hpp } = await hostedPayment(harness)
		await harness.emulator.testing.completeHostedPayment(hpp.id)
		const found = (await harness.checkout.payments.search({
			query: "reference:'restaurant_order:org_a:ord_1'",
			limit: 5,
		} as never)) as { data: Array<{ reference: string }> }
		expect(found.data).toHaveLength(1)
		const none = (await harness.checkout.payments.search({
			query: "reference:'other'",
		} as never)) as {
			data: unknown[]
		}
		expect(none.data).toHaveLength(0)
	})
})
