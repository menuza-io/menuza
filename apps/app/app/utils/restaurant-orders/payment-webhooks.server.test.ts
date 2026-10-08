import type * as DatabaseModule from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzleTable, mockDb, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { consoleError, consoleWarn } from '#tests/setup/setup-test-env.ts'
import {
	handleRestaurantOrderCheckoutWebhookEvent,
	handleRestaurantOrderStripeSessionEvent,
} from './payment-webhooks.server.ts'
import type * as RegionalOrderApiModule from './regional-order-api.server.ts'
import { RegionalOrderApiError } from './regional-order-api.server.ts'

const findOrg = vi.hoisted(() => vi.fn())
const notify = vi.hoisted(() => vi.fn())

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: {
			...mockDb,
			query: { Organization: { findFirst: findOrg } },
		},
		Organization: drizzleTable,
		and: (...args: unknown[]) => args,
		eq: (...args: unknown[]) => args,
	}
})

vi.mock(
	'#app/utils/restaurant-orders/regional-order-api.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof RegionalOrderApiModule>()
		return {
			...actual,
			notifyRestaurantOrderPaymentStatus: notify,
		}
	},
)

function stripeSession(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 'cs_1',
		status: 'complete',
		payment_status: 'paid',
		amount_total: 4250,
		currency: 'usd',
		metadata: {
			type: 'restaurant_order',
			orgId: 'org_1',
			orderId: 'ord_1',
		},
		...overrides,
	}
}

describe('restaurant order webhook dispatch', () => {
	beforeEach(() => {
		resetMockDb()
		consoleError.mockImplementation(() => {})
		findOrg.mockReset().mockResolvedValue({ dataRegion: 'us' })
		notify.mockReset().mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('forwards verified terminal Stripe session events to the regional service', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession() as never,
			'checkout.session.completed',
		)

		expect(findOrg).toHaveBeenCalledWith(expect.anything())
		expect(notify).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})
	})

	it('maps async failures as failed', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ status: 'open', payment_status: 'unpaid' }) as never,
			'checkout.session.async_payment_failed',
		)
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'failed' }),
		)
	})

	it('maps expired sessions as expired', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ status: 'expired', payment_status: 'unpaid' }) as never,
			'checkout.session.expired',
		)
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'expired' }),
		)
	})

	it('ignores non-restaurant and pending sessions', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({
				metadata: { type: 'shop_order', orgId: 'org_1' },
			}) as never,
			'checkout.session.completed',
		)
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ status: 'open', payment_status: 'unpaid' }) as never,
			'checkout.session.completed',
		)
		expect(notify).not.toHaveBeenCalled()
	})

	it('throws on transient regional failures so the webhook retries', async () => {
		notify.mockRejectedValue(
			new RegionalOrderApiError('regional_unreachable', 503),
		)
		await expect(
			handleRestaurantOrderStripeSessionEvent(
				stripeSession() as never,
				'checkout.session.completed',
			),
		).rejects.toMatchObject({ code: 'regional_unreachable' })
	})

	it('acknowledges permanent regional rejections without confirming', async () => {
		// e.g. session/amount mismatch: the regional service refuses to record.
		notify.mockRejectedValue(new RegionalOrderApiError('session_mismatch', 409))
		await expect(
			handleRestaurantOrderStripeSessionEvent(
				stripeSession() as never,
				'checkout.session.completed',
			),
		).resolves.toBeUndefined()
	})

	it('ignores events for unknown or inactive organizations', async () => {
		findOrg.mockResolvedValue(null)
		consoleWarn.mockImplementation(() => {})
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession() as never,
			'checkout.session.completed',
		)
		expect(notify).not.toHaveBeenCalled()
	})

	it('forwards verified Checkout.com terminal payments with session references', async () => {
		await handleRestaurantOrderCheckoutWebhookEvent({
			type: 'payment_approved',
			data: {
				id: 'pay_1',
				amount: 15000,
				currency: 'SAR',
				approved: true,
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_1',
					orderId: 'ord_1',
				},
				processing: { payment_session_id: 's_1' },
			},
		})

		expect(notify).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 's_1',
			processor: 'checkout',
			status: 'paid',
			amountCents: 15000,
			currency: 'sar',
		})
	})

	it('ignores Checkout.com events without a session reference (cannot verify binding)', async () => {
		await handleRestaurantOrderCheckoutWebhookEvent({
			type: 'payment_approved',
			data: {
				id: 'pay_1',
				amount: 15000,
				currency: 'SAR',
				approved: true,
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_1',
					orderId: 'ord_1',
				},
			},
		})
		expect(notify).not.toHaveBeenCalled()
	})

	it('routes KSA org events to the KSA region', async () => {
		findOrg.mockResolvedValue({ dataRegion: 'ksa' })
		await handleRestaurantOrderCheckoutWebhookEvent({
			type: 'payment_declined',
			data: {
				id: 'pay_1',
				amount: 15000,
				currency: 'SAR',
				status: 'Declined',
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_1',
					orderId: 'ord_1',
				},
				processing: { payment_session_id: 's_1' },
			},
		})
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				dataRegion: 'ksa',
				status: 'failed',
			}),
		)
	})
})
