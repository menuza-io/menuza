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
