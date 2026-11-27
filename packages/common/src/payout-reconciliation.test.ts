import { describe, expect, it } from 'vitest'
import {
	buildPayoutBridge,
	findUnmatchedTransactions,
	splitTipsByOrderType,
	UNMATCHED_ORDER_AGE_MS,
} from './payout-reconciliation.ts'

describe('payout reconciliation & bridge (#168)', () => {
	it('builds a bridge that adds up exactly to the deposited amount and hides zero dispute/reserve lines', () => {
		const res = buildPayoutBridge({
			depositedCents: 9410,
			periodSalesCents: 12000,
			otherPayoutSalesCents: 2000,
			otherPeriodRefundsCents: -200,
			providerFeesCents: 290,
			platformFeesCents: 100,
			disputesCents: 0,
			reservesCents: 0,
		})
		expect(res.status).toBe('matched')
		expect(res.bridge).not.toBeNull()
		const sum = res.bridge!.lines.reduce((acc, l) => acc + l.amountCents, 0)
		expect(sum).toBe(9410)
		expect(res.bridge!.lines.some((l) => l.kind === 'disputes')).toBe(false)
		expect(res.bridge!.lines.some((l) => l.kind === 'reserves')).toBe(false)
	})

	it('includes dispute and reserve lines only when non-zero', () => {
		const res = buildPayoutBridge({
			depositedCents: 7500,
			periodSalesCents: 10000,
			otherPayoutSalesCents: 0,
			otherPeriodRefundsCents: 0,
			providerFeesCents: 300,
			platformFeesCents: 200,
			disputesCents: -1500,
			reservesCents: -500,
		})
		expect(res.status).toBe('matched')
		expect(res.bridge!.lines.some((l) => l.kind === 'disputes')).toBe(true)
		expect(res.bridge!.lines.some((l) => l.kind === 'reserves')).toBe(true)
		const sum = res.bridge!.lines.reduce((acc, l) => acc + l.amountCents, 0)
		expect(sum).toBe(7500)
	})

	it('returns status "matching" with NO bridge when figures do not balance', () => {
		const res = buildPayoutBridge({
			depositedCents: 9999,
			periodSalesCents: 10000,
			otherPayoutSalesCents: 0,
			otherPeriodRefundsCents: 0,
			providerFeesCents: 300,
			platformFeesCents: 0,
			disputesCents: 0,
			reservesCents: 0,
		})
		expect(res.status).toBe('matching')
		expect(res.bridge).toBeNull()
	})

	it('lists unmatched provider transactions and Menuza paid orders older than 3 days', () => {
		const nowMs = Date.parse('2027-02-10T12:00:00Z')
		const { unmatchedProvider, unmatchedOrders } = findUnmatchedTransactions({
			nowMs,
			providerTransactions: [
				{
					id: 'txn_1',
					kind: 'payment',
					orderId: 'ord_matched',
					orderType: 'restaurant_order',
					grossCents: 4000,
					currency: 'USD',
					createdAt: '2027-02-09T10:00:00Z',
				},
				{
					id: 'txn_unmatched',
					kind: 'payment',
					orderId: null,
					orderType: null,
					grossCents: 2500,
					currency: 'USD',
					createdAt: '2027-02-09T11:00:00Z',
				},
			],
			regionalPaidOrders: [
				{
					id: 'ord_matched',
					number: '1001',
					totalCents: 4000,
					currency: 'USD',
					paidAt: new Date(nowMs - UNMATCHED_ORDER_AGE_MS - 1000).toISOString(),
				},
				{
					id: 'ord_old_missing',
					number: '1002',
					totalCents: 3200,
					currency: 'USD',
					paidAt: new Date(
						nowMs - UNMATCHED_ORDER_AGE_MS - 60_000,
					).toISOString(),
				},
				{
					id: 'ord_recent',
					number: '1003',
					totalCents: 1800,
					currency: 'USD',
					paidAt: new Date(nowMs - 60_000).toISOString(),
				},
			],
		})
		expect(unmatchedProvider.map((t) => t.id)).toEqual(['txn_unmatched'])
		expect(unmatchedOrders.map((o) => o.id)).toEqual(['ord_old_missing'])
	})

	it('splits tips by order type', () => {
		const split = splitTipsByOrderType([
			{ orderType: 'pickup', tipCents: 400 },
			{ orderType: 'pickup', tipCents: 250 },
			{ orderType: 'delivery', tipCents: 600 },
			{ orderType: 'dine_in', tipCents: 0 },
		])
		expect(split).toEqual([
			{ orderType: 'delivery', tipCents: 600, orderCount: 1 },
			{ orderType: 'pickup', tipCents: 650, orderCount: 2 },
		])
	})
})
