import { type PosOnlineOrderSummary } from '@repo/common/pos-online-orders'
import { describe, expect, it } from 'vitest'
import {
	inboxOrders,
	inboxSection,
	onlineOrderLate,
	refundCents,
	sectionCounts,
	unopenedOrders,
} from './model.ts'

const NOW = 10_000_000
const order = (
	id: string,
	values: Partial<PosOnlineOrderSummary> = {},
): PosOnlineOrderSummary => ({
	id,
	number: id.toUpperCase(),
	version: 'a'.repeat(64),
	status: 'accepted',
	fulfillment: 'pickup',
	channel: 'web',
	tableLabel: null,
	guestName: `Guest ${id}`,
	createdAt: NOW - 60_000,
	dueAt: null,
	paymentMethod: 'online',
	paymentStatus: 'paid',
	onTab: false,
	currency: 'USD',
	totalCents: 1000,
	refundedCents: 0,
	itemCount: 1,
	openedAt: null,
	completedAt: null,
	cancelledAt: null,
	...values,
})
const ALL = { section: 'all', fulfillment: 'all', query: '' } as const

describe('online orders inbox', () => {
	it('sorts a new order nobody opened into New, and an opened one into In progress', () => {
		expect(inboxSection(order('a'))).toBe('new')
		expect(inboxSection(order('b', { openedAt: NOW }))).toBe('in_progress')
		expect(inboxSection(order('c', { status: 'preparing' }))).toBe(
			'in_progress',
		)
		expect(inboxSection(order('d', { status: 'ready' }))).toBe('ready')
		expect(inboxSection(order('e', { status: 'cancelled' }))).toBe('done')
		expect(
			sectionCounts([order('a'), order('d', { status: 'ready' })]),
		).toEqual({ new: 1, in_progress: 0, ready: 1, done: 0 })
	})

	it('is late after its promised time, or 20 minutes after an ASAP order came in', () => {
		expect(onlineOrderLate(order('a', { dueAt: NOW - 1 }), NOW)).toBe(true)
		expect(onlineOrderLate(order('a', { dueAt: NOW + 1 }), NOW)).toBe(false)
		expect(
			onlineOrderLate(order('a', { createdAt: NOW - 21 * 60_000 }), NOW),
		).toBe(true)
		expect(
			onlineOrderLate(
				order('a', { createdAt: NOW - 21 * 60_000, status: 'completed' }),
				NOW,
			),
		).toBe(false)
	})

	it('puts late orders first, then by promised time, and hides finished ones from Open', () => {
		const list = inboxOrders(
			[
				order('soon', { dueAt: NOW + 5 * 60_000 }),
				order('late', { dueAt: NOW - 60_000 }),
				order('later', { dueAt: NOW + 30 * 60_000 }),
				order('done', { status: 'completed', completedAt: NOW }),
			],
			ALL,
			NOW,
		)
		expect(list.map((entry) => entry.id)).toEqual(['late', 'soon', 'later'])
	})

	it('finds an order by number or guest name and filters by type', () => {
		const orders = [
			order('w-1', { guestName: 'Maya' }),
			order('w-2', { fulfillment: 'delivery' }),
		]
		expect(
			inboxOrders(orders, { ...ALL, query: 'W-2' }, NOW).map((o) => o.id),
		).toEqual(['w-2'])
		expect(
			inboxOrders(orders, { ...ALL, query: 'maya' }, NOW).map((o) => o.id),
		).toEqual(['w-1'])
		expect(
			inboxOrders(orders, { ...ALL, fulfillment: 'delivery' }, NOW).map(
				(o) => o.id,
			),
		).toEqual(['w-2'])
	})

	it('alerts for new orders until opened here or anywhere at the location', () => {
		const orders = [order('a'), order('b'), order('c', { openedAt: NOW })]
		expect(unopenedOrders(orders, new Set()).map((o) => o.id)).toEqual([
			'a',
			'b',
		])
		expect(unopenedOrders(orders, new Set(['a'])).map((o) => o.id)).toEqual([
			'b',
		])
	})

	it('reads a refund amount and never allows more than is left', () => {
		expect(refundCents('5', 1000)).toBe(500)
		expect(refundCents('5,25', 1000)).toBe(525)
		expect(refundCents('10.01', 1000)).toBeNull()
		expect(refundCents('0', 1000)).toBeNull()
		expect(refundCents('abc', 1000)).toBeNull()
	})
})
