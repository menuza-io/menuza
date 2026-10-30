import { describe, expect, it } from 'vitest'
import {
	formatMoney,
	paymentDisplayStatus,
	refundableCents,
} from './order-model.ts'

describe('formatMoney', () => {
	it('divides by the currency exponent, not always by 100', () => {
		expect(formatMoney(1550, 'USD', 'en-US')).toBe('$15.50')
		expect(formatMoney(1550, 'usd', 'en-US')).toBe('$15.50')
		expect(formatMoney(1550, 'SAR', 'en-US')).toBe('SAR\u00a015.50')
		expect(formatMoney(1550, 'KWD', 'en-US')).toBe('KWD\u00a01.550')
		expect(formatMoney(1550, 'JPY', 'en-US')).toBe('¥1,550')
	})
})

describe('paymentDisplayStatus', () => {
	it('keeps every status but paid as stored', () => {
		for (const paymentStatus of ['unpaid', 'pending', 'failed', 'review']) {
			expect(
				paymentDisplayStatus({
					paymentStatus,
					totalCents: 1000,
					refundedCents: 1000,
				}),
			).toBe(paymentStatus)
		}
	})

	it('reads a paid order by what came back', () => {
		const paid = { paymentStatus: 'paid', totalCents: 1000 }
		expect(paymentDisplayStatus({ ...paid, refundedCents: 0 })).toBe('paid')
		expect(paymentDisplayStatus({ ...paid, refundedCents: 1 })).toBe(
			'partly_refunded',
		)
		expect(paymentDisplayStatus({ ...paid, refundedCents: 1000 })).toBe(
			'refunded',
		)
	})
})

describe('refundableCents', () => {
	it('is what was paid less what came back, never below zero', () => {
		expect(refundableCents({ totalCents: 1000, refundedCents: 0 })).toBe(1000)
		expect(refundableCents({ totalCents: 1000, refundedCents: 250 })).toBe(750)
		expect(refundableCents({ totalCents: 1000, refundedCents: 1200 })).toBe(0)
	})
})
