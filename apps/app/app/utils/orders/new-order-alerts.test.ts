import { describe, expect, it } from 'vitest'
import {
	activeItems,
	dismissOrder,
	EMPTY_TRACKER,
	isNewOnlineOrder,
	stepTracker,
	titleWithCount,
} from './new-order-alerts.ts'
import { type Order } from './order-model.ts'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)
const MIN = 60_000

function order(over: Partial<Order> = {}): Order {
	return {
		id: 'o1',
		number: 'W-0042',
		status: 'accepted',
		paymentStatus: 'unpaid',
		paymentMethod: 'handoff',
		loyaltyDiscountCents: 0,
		totalCents: 3850,
		refundedCents: 0,
		currency: 'SAR',
		createdAt: new Date(NOW).toISOString(),
		contact: {
			name: 'Layla Hassan',
			phone: '+966501234567',
			email: 'layla@example.com',
		},
		fulfillment: 'pickup',
		location: { id: 'loc', name: 'Downtown' },
		lines: [
			{
				itemName: 'Shawarma plate no onions',
				quantity: 2,
				unitPriceCents: 1000,
				totalCents: 2000,
				instructions: 'allergic to nuts',
				options: [],
			},
			{
				itemName: 'Tea',
				quantity: 1,
				unitPriceCents: 300,
				totalCents: 300,
				instructions: null,
				options: [],
			},
		],
		pickup: null,
		drop: null,
		delivery: null,
		timeZone: 'Asia/Riyadh',
		promisedAt: null,
		promisedUntil: null,
		promisedVersion: 0,
		promisedDelayMinutes: 0,
		attributionSource: 'direct',
		attribution: null,
		campaignName: null,
		...over,
	} as Order
}

describe('which orders are new', () => {
	it('is an online pickup or delivery order nobody has started', () => {
		expect(isNewOnlineOrder(order())).toBe(true)
		expect(isNewOnlineOrder(order({ status: 'pending_acceptance' }))).toBe(true)
		expect(isNewOnlineOrder(order({ status: 'preparing' }))).toBe(false)
		expect(isNewOnlineOrder(order({ status: 'cancelled' }))).toBe(false)
		expect(isNewOnlineOrder(order({ fulfillment: 'dine_in' }))).toBe(false)
	})
})

describe('stepTracker', () => {
	it('only primes on the first list: orders already there are not new', () => {
		const { next, created } = stepTracker(EMPTY_TRACKER, [order()], NOW)
		expect(created).toEqual([])
		expect(next.primed).toBe(true)
		expect(activeItems(next)).toEqual([])
	})

	it('starts exactly one alert when a new id appears, and none on the next refresh', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const first = stepTracker(primed, [order()], NOW + 15_000)
		expect(first.created).toHaveLength(1)
		expect(first.created[0]).toMatchObject({
			orderId: 'o1',
			kind: 'new',
			number: 'W-0042',
		})
		const second = stepTracker(first.next, [order()], NOW + 30_000)
		expect(second.created).toEqual([])
		expect(activeItems(second.next)).toHaveLength(1)
	})

	it('puts only the number, type, time, total, dish count and size in the alert, never the guest', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const { created } = stepTracker(primed, [order({ largeOrder: true })], NOW)
		expect(created[0]!.subject).toEqual({
			kind: 'orders_new',
			orderNumber: 'W-0042',
			fulfillment: 'pickup',
			scheduledForMs: null,
			totalCents: 3850,
			currency: 'SAR',
			dishCount: 3,
			large: true,
		})
		const text = JSON.stringify(created)
		for (const guest of [
			'Layla',
			'+9665',
			'example.com',
			'Shawarma',
			'nuts',
			'onions',
		]) {
			expect(text).not.toContain(guest)
		}
	})

	it('ignores table rounds and orders that already left New', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const { created } = stepTracker(
			primed,
			[
				order({ id: 'a', fulfillment: 'dine_in' }),
				order({ id: 'b', status: 'preparing' }),
			],
			NOW,
		)
		expect(created).toEqual([])
	})

	it('ends the alert when the order is accepted by a person, started, cancelled or gone', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const waiting = order({ status: 'pending_acceptance' })
		const started = stepTracker(primed, [waiting], NOW).next
		expect(started.items.size).toBe(1)
		// Accepted by a person: no longer waiting for one.
		expect(
			stepTracker(started, [order({ status: 'accepted' })], NOW + 1000).next
				.items.size,
		).toBe(0)

		const fresh = stepTracker(primed, [order()], NOW).next
		for (const next of [
			[order({ status: 'preparing' })],
			[order({ status: 'cancelled' })],
			[],
		]) {
			expect(stepTracker(fresh, next, NOW + 1000).next.items.size).toBe(0)
		}
		// Still New: it goes on.
		expect(stepTracker(fresh, [order()], NOW + 1000).next.items.size).toBe(1)
	})

	it('ends the alert when the order is opened', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const started = stepTracker(primed, [order()], NOW).next
		expect(activeItems(dismissOrder(started, 'o1'))).toEqual([])
		// A refresh with the same order does not bring it back.
		const after = stepTracker(
			dismissOrder(started, 'o1'),
			[order()],
			NOW + 15_000,
		)
		expect(after.created).toEqual([])
	})

	it('tells a scheduled order once when placed, then again at its start time', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const later = order({
			scheduledFor: new Date(NOW + 60 * MIN).toISOString(),
		})
		const placed = stepTracker(primed, [later], NOW)
		expect(placed.created[0]).toMatchObject({ kind: 'scheduled' })
		// Not counted as needing someone now.
		expect(activeItems(placed.next)).toEqual([])
		const early = stepTracker(placed.next, [later], NOW + 30 * MIN)
		expect(early.created).toEqual([])
		const atTime = stepTracker(early.next, [later], NOW + 60 * MIN)
		expect(atTime.created).toHaveLength(1)
		expect(atTime.created[0]).toMatchObject({ kind: 'started' })
		expect(activeItems(atTime.next)).toHaveLength(1)
		// Only once.
		expect(stepTracker(atTime.next, [later], NOW + 61 * MIN).created).toEqual(
			[],
		)
	})

	it('treats a time a minute or two ahead as now', () => {
		const primed = stepTracker(EMPTY_TRACKER, [], NOW).next
		const soon = order({ scheduledFor: new Date(NOW + MIN).toISOString() })
		expect(stepTracker(primed, [soon], NOW).created[0]).toMatchObject({
			kind: 'new',
		})
	})
})

describe('titleWithCount', () => {
	it('puts the count in front, once', () => {
		expect(titleWithCount('Orders', 2)).toBe('(2) Orders')
		expect(titleWithCount('(2) Orders', 3)).toBe('(3) Orders')
		expect(titleWithCount('(3) Orders', 0)).toBe('Orders')
	})
})
