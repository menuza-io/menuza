import { type AttentionItem } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	attentionTarget,
	daysSince,
	localDate,
	percentFromBp,
} from './today-view.ts'

const CTX = { orgSlug: 'acme', search: '', canEdit: true }

const KINDS: Record<AttentionItem['kind'], AttentionItem> = {
	low_stock: {
		kind: 'low_stock',
		itemId: 'i1',
		itemName: 'Chicken',
		onHand: 2000,
		countUnit: 'kg',
		baseUnit: 'g',
		status: 'low',
		supplierId: null,
		supplierName: null,
		more: 0,
	},
	count_due: { kind: 'count_due', date: '2026-11-09' },
	count_in_progress: {
		kind: 'count_in_progress',
		countId: 'c1',
		itemsCounted: 3,
		itemTotal: 10,
	},
	count_in_review: { kind: 'count_in_review', countId: 'c2' },
	price_rise: {
		kind: 'price_rise',
		itemId: 'i2',
		itemName: 'Tomatoes',
		changeBp: 1400,
		deliveryId: 'd1',
		supplierName: 'Fresh Farms',
	},
	unpaid_deliveries: { kind: 'unpaid_deliveries', count: 2 },
	order_cutoff: {
		kind: 'order_cutoff',
		supplierId: 's1',
		supplierName: 'Fresh Farms',
		cutoffDate: '2026-11-09',
		cutoffTime: '16:00',
		expectedDate: '2026-11-10',
		itemCount: 4,
		draftOrderId: null,
	},
	delivery_expected: {
		kind: 'delivery_expected',
		orderId: 'o1',
		supplierName: 'Fresh Farms',
		expectedDate: '2026-11-09',
		overdue: false,
	},
	prices_pending: {
		kind: 'prices_pending',
		deliveryId: 'd2',
		supplierName: null,
		lineCount: 3,
	},
}

describe('attentionTarget', () => {
	it('sends every kind to exactly one screen', () => {
		const targets = Object.fromEntries(
			Object.values(KINDS).map((item) => [
				item.kind,
				attentionTarget(item, CTX).to,
			]),
		)
		expect(targets).toEqual({
			low_stock: '/acme/inventory/stock?low=1',
			count_due: '/acme/inventory/counts?start=1',
			count_in_progress: '/acme/inventory/counts/c1',
			count_in_review: '/acme/inventory/counts/c2/review',
			price_rise: '/acme/inventory/purchasing/deliveries/d1',
			unpaid_deliveries: '/acme/inventory/purchasing',
			order_cutoff: '/acme/inventory/purchasing',
			delivery_expected: '/acme/inventory/purchasing',
			prices_pending: '/acme/inventory/purchasing/deliveries/d2',
		})
	})

	it('keeps the location on every link', () => {
		const search = '?locationId=olaya'
		expect(attentionTarget(KINDS.low_stock, { ...CTX, search }).to).toBe(
			'/acme/inventory/stock?locationId=olaya&low=1',
		)
		expect(attentionTarget(KINDS.count_in_review, { ...CTX, search }).to).toBe(
			'/acme/inventory/counts/c2/review?locationId=olaya',
		)
	})

	it('only offers to start a count to someone who can', () => {
		expect(
			attentionTarget(KINDS.count_due, { ...CTX, canEdit: false }).to,
		).toBe('/acme/inventory/counts')
	})
})

describe('small helpers', () => {
	it('counts whole days since a moment', () => {
		const now = Date.UTC(2026, 10, 9, 12)
		expect(daysSince(now - 3 * 86_400_000 - 1000, now)).toBe(3)
		expect(daysSince(now - 1000, now)).toBe(0)
		expect(daysSince(now + 5000, now)).toBe(0)
	})

	it('turns basis points into a whole percent', () => {
		expect(percentFromBp(1400)).toBe(14)
		expect(percentFromBp(1449)).toBe(14)
		expect(percentFromBp(1450)).toBe(15)
	})

	it('reads a business date as a local calendar day', () => {
		const date = localDate('2026-11-09')
		expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([
			2026, 10, 9,
		])
	})
})
