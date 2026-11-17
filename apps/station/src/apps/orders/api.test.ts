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

	it('parses a summary without refundStatus, refundPendingCents and disputed (the region omits them by default)', async () => {
		const bare = {
			id: 'o1',
			number: 'W-1',
			version: 'a'.repeat(64),
			status: 'accepted',
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
			cancelledAt: null,
		}
		const answer = await createOrdersApi(settings, session, async () =>
			Response.json({ ...feed, orders: [bare] }),
		).feed()
		expect(answer.orders[0]).toEqual(bare)
		expect(answer.orders[0]?.refundStatus).toBeUndefined()
		expect(answer.orders[0]?.refundPendingCents ?? 0).toBe(0)
		expect(answer.orders[0]?.disputed ?? false).toBe(false)
		// The same order with the keys present still parses.
		const full = await createOrdersApi(settings, session, async () =>
			Response.json({
				...feed,
				orders: [
					{
						...bare,
						refundStatus: 'pending',
						refundPendingCents: 500,
						disputed: true,
					},
				],
			}),
		).feed()
		expect(full.orders[0]).toMatchObject({
			refundStatus: 'pending',
			refundPendingCents: 500,
			disputed: true,
		})
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

describe('order detail fields for the checkout rules (#251, #257, #355, #408)', () => {
	const order = {
		id: 'o1',
		number: 'W-1',
		version: 'a'.repeat(64),
		status: 'accepted',
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
		totalCents: 1600,
		refundedCents: 0,
		itemCount: 1,
		openedAt: 1,
		completedAt: null,
		cancelledAt: null,
		lines: [],
		phoneMasked: '•••• 1',
		hasEmail: false,
		delivery: null,
		subtotalCents: 1500,
		taxCents: 0,
		deliveryFeeCents: 0,
		tipCents: 0,
		discountCents: 0,
		loyaltyDiscountCents: 0,
		paidAt: 1,
		refundableCents: 1600,
		refunds: [],
		history: [],
	}
	const answer = (extra: Record<string, unknown>) => ({
		order: { ...order, ...extra },
		grants: feed.grants,
		serverNow: 3,
	})
	const read = (body: unknown) =>
		createOrdersApi(settings, session, async () => Response.json(body)).detail(
			'o1',
		)

	it('reads the packaging fee, utensils answer, pickup text and large-order minutes', async () => {
		const detail = await read(
			answer({
				packagingFeeCents: 100,
				packagingFeeLabel: 'Bag fee',
				utensilsRequested: false,
				pickupInstructions: 'Park in the side lot.',
				largeOrderExtraMinutes: 15,
			}),
		)
		expect(detail.order).toMatchObject({
			packagingFeeCents: 100,
			packagingFeeLabel: 'Bag fee',
			utensilsRequested: false,
			pickupInstructions: 'Park in the side lot.',
			largeOrderExtraMinutes: 15,
		})
	})

	it('still reads the answer of an older node that sends none of them', async () => {
		const detail = await read(answer({}))
		expect(detail.order.packagingFeeCents).toBeUndefined()
		expect(detail.order.utensilsRequested).toBeUndefined()
		expect(detail.order.pickupInstructions).toBeUndefined()
		expect(detail.order.largeOrderExtraMinutes).toBeUndefined()
	})

	it('reads a null utensils answer (not asked) and null pickup text', async () => {
		const detail = await read(
			answer({ utensilsRequested: null, pickupInstructions: null }),
		)
		expect(detail.order.utensilsRequested).toBeNull()
		expect(detail.order.pickupInstructions).toBeNull()
	})
})

describe('daily limits regional client (#409)', () => {
	const row = {
		key: 'item:i-lamb',
		kind: 'item',
		id: 'i-lamb',
		name: 'Lamb shank special',
		limit: 20,
		showRemaining: true,
		toppedUpUnits: 5,
		soldUnits: 14,
		heldUnits: 2,
		remaining: 9,
	}

	it('reads today from the controls route with the device and staff credentials', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ enabled: true, businessDate: '2026-03-10', rows: [row] }),
		)
		const status = await createOrdersApi(
			settings,
			session,
			fetchImpl,
		).dailyLimits()
		expect(status.rows).toEqual([row])
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://us.node.test/pos/online-orders/controls/daily-limits',
			expect.objectContaining({
				method: 'GET',
				cache: 'no-store',
				credentials: 'omit',
				headers: {
					Authorization: `Bearer ${settings.deviceToken}`,
					'Pos-Staff-Session': 'staff-token',
				},
			}),
		)
	})

	it('sends a top-up once, as the region expects it, and returns the updated row', async () => {
		const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
			Response.json({ row }),
		)
		const api = createOrdersApi(settings, session, fetchImpl)
		await expect(
			api.topUpDailyLimit({ key: 'item:i-lamb', addUnits: 5 }),
		).resolves.toEqual(row)
		await api.topUpDailyLimit({ key: 'item:i-lamb', amountLeft: 7 })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		const bodies = fetchImpl.mock.calls.map(
			(call) => JSON.parse(String(call[1]?.body)) as unknown,
		)
		expect(bodies).toEqual([
			{ key: 'item:i-lamb', addUnits: 5 },
			{ key: 'item:i-lamb', amountLeft: 7 },
		])
		expect(fetchImpl).toHaveBeenLastCalledWith(
			'https://us.node.test/pos/online-orders/controls/daily-limits/top-up',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'Content-Type': 'application/json',
				}),
			}),
		)
	})

	it('reads the refusal code, and an answer of the wrong shape is invalid', async () => {
		const refused = await createOrdersApi(settings, session, async () =>
			Response.json({ error: 'permission_required' }, { status: 403 }),
		)
			.topUpDailyLimit({ key: 'item:i-lamb', addUnits: 5 })
			.catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(OrdersError)
		expect(refused).toMatchObject({ code: 'permission_required', status: 403 })
		await expect(
			createOrdersApi(settings, session, async () =>
				Response.json({ enabled: true, rows: 'nope' }),
			).dailyLimits(),
		).rejects.toMatchObject({ code: 'invalid_response' })
		const { key: _key, ...withoutKey } = row
		await expect(
			createOrdersApi(settings, session, async () =>
				Response.json({ row: withoutKey }),
			).topUpDailyLimit({ key: 'item:i-lamb', addUnits: 5 }),
		).rejects.toMatchObject({ code: 'invalid_response' })
	})
})
