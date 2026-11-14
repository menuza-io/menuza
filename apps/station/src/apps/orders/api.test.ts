import { describe, expect, it, vi } from 'vitest'
import { createOrdersApi, OrdersError } from './api.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

const settings = {
	tenantApiUrl: 'https://us.node.test/',
	deviceToken: 'pdv1.org.dev.secret',
} as PosSettings
const session = { serverSession: { token: 'staff-token' } } as Session
const feed = {
	orders: [],
	phonePickups: [],
	grants: {
		view: true,
		manage: true,
		contact: false,
		cancel: false,
		refund: false,
	},
	serverNow: Date.now(),
	truncated: false,
}

describe('online orders regional client', () => {
	it('calls /pos/online-orders on the region directly, with the device and staff credentials, no cookies, no cache', async () => {
		const fetchImpl = vi.fn(async () => Response.json(feed))
		await expect(
			createOrdersApi(settings, session, fetchImpl).feed(),
		).resolves.toEqual(feed)
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://us.node.test/pos/online-orders',
			expect.objectContaining({
				cache: 'no-store',
				credentials: 'omit',
				headers: {
					Authorization: `Bearer ${settings.deviceToken}`,
					'Pos-Staff-Session': 'staff-token',
				},
			}),
		)
	})

	it('sends a refund once with its idempotency key, and reads the error code and limit', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json(
				{ error: 'refund_exceeds_payment', refundableCents: 400 },
				{ status: 422 },
			),
		)
		const failure = await createOrdersApi(settings, session, fetchImpl)
			.refund(
				'order 1',
				{ expectedVersion: 'a'.repeat(64), amountCents: 500, note: 'Cold' },
				'rf-key-1',
			)
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(OrdersError)
		expect(failure).toMatchObject({
			code: 'refund_exceeds_payment',
			status: 422,
			refundableCents: 400,
		})
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://us.node.test/pos/online-orders/order%201/refunds',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ 'Idempotency-Key': 'rf-key-1' }),
			}),
		)
	})

	it('parses the refund fields and outcome the region now sends', async () => {
		const detail = {
			order: {
				id: 'o1',
				number: 'W-1',
				version: 'a'.repeat(64),
				status: 'cancelled',
				fulfillment: 'pickup',
				channel: 'web',
				tableLabel: null,
				guestName: 'Maya',
				createdAt: 1,
				dueAt: null,
				paymentMethod: 'online',
				paymentStatus: 'paid',
				onTab: false,
				currency: 'USD',
				totalCents: 1000,
				refundedCents: 0,
				itemCount: 1,
				openedAt: 1,
				completedAt: null,
				cancelledAt: 2,
				refundStatus: 'pending',
				refundPendingCents: 1000,
				disputed: false,
				lines: [],
				phoneMasked: '•••• 1',
				hasEmail: false,
				delivery: null,
				subtotalCents: 1000,
				taxCents: 0,
				deliveryFeeCents: 0,
				tipCents: 0,
				discountCents: 0,
				loyaltyDiscountCents: 0,
				paidAt: 1,
				refundableCents: 0,
				refunds: [
					{
						amountCents: 1000,
						note: '',
						at: 2,
						kind: 'provider',
						status: 'pending',
						failureCode: null,
					},
				],
				history: [],
			},
			grants: feed.grants,
			serverNow: 3,
			refundOutcome: { started: true, code: null },
		}
		const answer = await createOrdersApi(settings, session, async () =>
			Response.json(detail),
		).detail('o1')
		expect(answer.refundOutcome).toEqual({ started: true, code: null })
		expect(answer.order.refundStatus).toBe('pending')
	})

	it('treats a network failure as a lost connection and an odd answer as invalid', async () => {
		await expect(
			createOrdersApi(settings, session, async () => {
				throw new TypeError('offline')
			}).feed(),
		).rejects.toMatchObject({ code: 'connection_lost' })
		await expect(
			createOrdersApi(settings, session, async () =>
				Response.json({ orders: 'nope' }),
			).feed(),
		).rejects.toMatchObject({ code: 'invalid_response' })
	})
})
