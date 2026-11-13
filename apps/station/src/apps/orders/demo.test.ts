import { describe, expect, it } from 'vitest'
import { OrdersError } from './api.ts'
import { createDemoOrders } from './demo.ts'

describe('demo online orders', () => {
	it('starts with a new order and silences it once opened', async () => {
		const demo = createDemoOrders()
		const feed = await demo.feed()
		const fresh = feed.orders.find((o) => o.number === 'W-1041')!
		expect(fresh.openedAt).toBeNull()
		expect(JSON.stringify(feed)).not.toContain('+1 555')
		await demo.command(fresh.id, { action: 'open' })
		const after = await demo.feed()
		expect(after.orders.find((o) => o.id === fresh.id)!.openedAt).not.toBeNull()
	})

	it('keeps the rules: payment at handoff first, stale versions refused, refunds capped', async () => {
		const demo = createDemoOrders()
		const { order } = await demo.detail('demo-1041')
		await expect(
			demo.command(order.id, {
				action: 'handed_over',
				expectedVersion: order.version,
				markPaid: false,
			}),
		).rejects.toMatchObject({ code: 'payment_required' })
		const handed = await demo.command(order.id, {
			action: 'handed_over',
			expectedVersion: order.version,
			markPaid: true,
		})
		expect(handed.order).toMatchObject({
			status: 'completed',
			paymentStatus: 'paid',
		})
		await expect(
			demo.command(order.id, {
				action: 'cancel',
				expectedVersion: order.version,
				reason: 'other',
			}),
		).rejects.toBeInstanceOf(OrdersError)

		const paid = (await demo.detail('demo-1030')).order
		await expect(
			demo.refund(
				paid.id,
				{
					expectedVersion: paid.version,
					amountCents: paid.refundableCents + 1,
					note: 'Too much',
				},
				'k1',
			),
		).rejects.toMatchObject({ code: 'refund_exceeds_payment' })
		const partial = await demo.refund(
			paid.id,
			{ expectedVersion: paid.version, amountCents: 500, note: 'Cold' },
			'k2',
		)
		expect(partial.order.refundedCents).toBe(500)
		expect(partial.order.history[0]).toMatchObject({
			action: 'refunded',
			amountCents: 500,
		})
	})

	it('brings in a new order for the alert', async () => {
		const demo = createDemoOrders()
		demo.arrive()
		const feed = await demo.feed()
		expect(
			feed.orders.filter((o) => o.status === 'accepted' && !o.openedAt),
		).toHaveLength(2)
	})

	it('searches past the inbox by number, name and phone digits, and keeps older orders read-only', async () => {
		const demo = createDemoOrders()
		const feed = await demo.feed()
		expect(feed.orders.some((o) => o.number === 'W-0988')).toBe(false)
		const byName = await demo.search({ q: 'maya' })
		expect(byName.results.map((o) => o.number)).toContain('W-0988')
		const byPhone = await demo.search({ phone: '0177' })
		expect(byPhone.results.map((o) => o.number)).toEqual(['W-0951'])
		expect(JSON.stringify(byPhone)).not.toContain('555')
		const delivery = await demo.search({
			q: 'W-',
			fulfillment: 'delivery',
			state: 'cancelled',
		})
		expect(delivery.results.every((o) => o.status === 'cancelled')).toBe(true)
		await expect(demo.contact('demo-0951')).rejects.toMatchObject({
			code: 'order_not_found',
		})
		const old = (await demo.detail('demo-0951')).order
		await expect(
			demo.command(old.id, { action: 'reprint', target: 'guest' } as never),
		).rejects.toMatchObject({ code: 'order_not_found' })
	})
})
