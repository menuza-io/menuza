import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrdersError } from './api.ts'
import { createDemoOrders, DEMO_REFUND_SETTLE_MS } from './demo.ts'

afterEach(() => vi.useRealTimers())

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
		// A provider refund is pending first: reserved, not yet refunded.
		expect(partial.order).toMatchObject({
			refundedCents: 0,
			refundPendingCents: 500,
			refundStatus: 'pending',
			refundableCents: paid.refundableCents - 500,
		})
		expect(partial.order.history[0]).toMatchObject({
			action: 'refunded',
			amountCents: 500,
		})
		await expect(
			demo.refund(
				paid.id,
				{
					expectedVersion: partial.order.version,
					amountCents: 100,
					note: 'Again',
				},
				'k3',
			),
		).rejects.toMatchObject({ code: 'refund_pending' })
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + DEMO_REFUND_SETTLE_MS + 1)
		const settled = (await demo.detail(paid.id)).order
		expect(settled).toMatchObject({
			refundedCents: 500,
			refundPendingCents: 0,
			refundStatus: 'partial',
		})
		expect(settled.refunds[0]).toMatchObject({
			kind: 'provider',
			status: 'succeeded',
		})
	})

	it('refuses to refund a disputed payment', async () => {
		const demo = createDemoOrders()
		const disputed = (await demo.detail('demo-1037')).order
		expect(disputed.disputed).toBe(true)
		await expect(
			demo.refund(
				disputed.id,
				{ expectedVersion: disputed.version, full: true, note: 'Cold' },
				'kd',
			),
		).rejects.toMatchObject({ code: 'payment_disputed' })
	})

	it('cancels with a full refund and reports the outcome', async () => {
		const demo = createDemoOrders()
		const order = (await demo.detail('demo-1039')).order
		const answer = await demo.command(order.id, {
			action: 'cancel',
			expectedVersion: order.version,
			reason: 'out_of_stock',
			refund: 'full',
		})
		expect(answer.refundOutcome).toEqual({ started: true, code: null })
		expect(answer.order).toMatchObject({
			status: 'cancelled',
			refundStatus: 'pending',
			refundPendingCents: order.totalCents,
			refundableCents: 0,
		})
		const handoff = (await demo.detail('demo-1041')).order
		await expect(
			demo.command(handoff.id, {
				action: 'cancel',
				expectedVersion: handoff.version,
				reason: 'other',
				refund: 'full',
			}),
		).rejects.toMatchObject({ code: 'order_not_refundable' })
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

	it('pauses, marks sold out and says when stock holds a dish off', async () => {
		const demo = createDemoOrders()
		expect((await demo.controls()).pause).toBeNull()
		const paused = await demo.pause({ action: 'pause', duration: '15m' })
		expect(paused.pause?.until).toBeGreaterThan(Date.now())
		expect((await demo.pause({ action: 'resume' })).pause).toBeNull()
		expect((await demo.controls()).heldByStock[0]).toMatchObject({
			entityId: 'i-ribs',
			causeItemName: 'Pork ribs',
		})
		await expect(
			demo.availability({
				entityType: 'item',
				entityId: 'i-ribs',
				available: true,
			}),
		).rejects.toMatchObject({ code: 'held_by_stock' })
		const back = await demo.availability({
			entityType: 'item',
			entityId: 'i-ribs',
			available: true,
			overrideStock: true,
		})
		expect(back.heldByStock).toEqual([])
	})

	describe('acceptance', () => {
		it('starts with an order that waits, and accepting moves it on', async () => {
			const demo = createDemoOrders()
			const feed = await demo.feed()
			const waiting = feed.orders.find(
				(o) => o.status === 'pending_acceptance',
			)!
			expect(waiting.acceptanceDeadlineAt).toBeGreaterThan(Date.now())
			const { order } = await demo.detail(waiting.id)
			await expect(
				demo.command(order.id, {
					action: 'accept',
					expectedVersion: 'f'.repeat(64),
				}),
			).rejects.toMatchObject({ code: 'stale_version' })
			const accepted = await demo.command(order.id, {
				action: 'accept',
				expectedVersion: order.version,
			})
			expect(accepted.order.status).toBe('accepted')
			expect(accepted.order.history[0]!.action).toBe('accepted')
			await expect(
				demo.command(order.id, {
					action: 'accept',
					expectedVersion: accepted.order.version,
				}),
			).rejects.toMatchObject({ code: 'order_not_pending' })
		})

		it('rejecting records the reason and refunds a paid online order in full', async () => {
			const demo = createDemoOrders()
			const { order } = await demo.detail('demo-1043')
			const rejected = await demo.command(order.id, {
				action: 'reject',
				expectedVersion: order.version,
				reason: 'out_of_stock',
			})
			expect(rejected.order).toMatchObject({
				status: 'cancelled',
				rejectedReason: 'out_of_stock',
			})
			expect(rejected.refundOutcome).toEqual({ started: true, code: null })
			expect(rejected.order.refunds[0]).toMatchObject({
				amountCents: order.totalCents,
				status: 'pending',
			})
			expect(rejected.order.history.map((h) => h.action)).toContain('rejected')
		})

		it('turns an order down once its deadline has passed', async () => {
			vi.useFakeTimers()
			const demo = createDemoOrders()
			vi.advanceTimersByTime(10 * 60_000)
			const { order } = await demo.detail('demo-1043')
			expect(order).toMatchObject({
				status: 'cancelled',
				rejectedReason: 'not_accepted_in_time',
			})
		})
	})
})

describe('demo daily limits (#409)', () => {
	it('lists the capped dishes with what is left', async () => {
		const demo = createDemoOrders()
		const status = await demo.dailyLimits()
		expect(status.enabled).toBe(true)
		const lamb = status.rows.find((row) => row.key === 'item:i-lamb-shank')!
		expect(lamb).toMatchObject({ limit: 20, soldUnits: 14, heldUnits: 2 })
		// The cap plus top-ups, less sold and held.
		expect(lamb.remaining).toBe(4)
		expect(status.rows.find((row) => row.kind === 'option')!.remaining).toBe(0)
	})

	it('adds units, and sets the amount left like the region does', async () => {
		const demo = createDemoOrders()
		const added = await demo.topUpDailyLimit({
			key: 'item:i-lamb-shank',
			addUnits: 5,
		})
		expect(added).toMatchObject({ toppedUpUnits: 5, remaining: 9 })
		const set = await demo.topUpDailyLimit({
			key: 'item:i-lamb-shank',
			amountLeft: 2,
		})
		expect(set.remaining).toBe(2)
		expect(set.limit).toBe(20)
		expect(
			(await demo.dailyLimits()).rows.find(
				(r) => r.key === 'item:i-lamb-shank',
			)!.remaining,
		).toBe(2)
		const gone = await demo.topUpDailyLimit({
			key: 'item:i-lamb-shank',
			amountLeft: 0,
		})
		expect(gone.remaining).toBe(0)
	})

	it('makes a sold-out option available again with a top-up', async () => {
		const demo = createDemoOrders()
		const back = await demo.topUpDailyLimit({
			key: 'option:o-baklava',
			addUnits: 3,
		})
		expect(back.remaining).toBe(3)
	})

	it('refuses a dish with no daily limit', async () => {
		const demo = createDemoOrders()
		await expect(
			demo.topUpDailyLimit({ key: 'item:nope', addUnits: 5 }),
		).rejects.toMatchObject({ code: 'daily_limit_not_found' })
	})

	it('shows the packaging fee, utensils answer and pickup text on a sample order, totals adding up', async () => {
		const demo = createDemoOrders()
		const { order } = await demo.detail('demo-1041')
		expect(order).toMatchObject({
			packagingFeeCents: 100,
			utensilsRequested: false,
		})
		expect(order.pickupInstructions).toContain('side lot')
		expect(
			order.subtotalCents +
				order.taxCents +
				order.deliveryFeeCents +
				order.tipCents +
				(order.packagingFeeCents ?? 0) -
				order.discountCents -
				order.loyaltyDiscountCents,
		).toBe(order.totalCents)
	})
})
