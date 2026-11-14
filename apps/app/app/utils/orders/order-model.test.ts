import { describe, expect, it } from 'vitest'
import {
	appliedDiscounts,
	formatMoney,
	isPaymentNotRequired,
	orderSchema,
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

describe('appliedDiscounts', () => {
	it('reads well-formed discounts and skips junk', () => {
		expect(
			appliedDiscounts({
				discounts: [
					{
						discountId: 'd1',
						version: 2,
						name: 'Lunch',
						code: 'LUNCH',
						amountMinor: 300,
						deliveryAmountMinor: 0,
						allocation: [{ lineId: 'a', amountMinor: 300, units: 1 }],
					},
					null,
					'x',
					[],
					{ name: 'Nothing', amountMinor: 0 },
					{
						discountId: 'd2',
						name: 'Ship',
						amountMinor: 'bad',
						deliveryAmountMinor: 200,
					},
				],
			}),
		).toEqual([
			{
				discountId: 'd1',
				name: 'Lunch',
				code: 'LUNCH',
				amountMinor: 300,
				deliveryAmountMinor: 0,
			},
			{
				discountId: 'd2',
				name: 'Ship',
				code: null,
				amountMinor: 0,
				deliveryAmountMinor: 200,
			},
		])
	})

	it('treats a missing or non-array value as none', () => {
		expect(appliedDiscounts({})).toEqual([])
		expect(appliedDiscounts({ discounts: 'nope' })).toEqual([])
		expect(appliedDiscounts({ discounts: { a: 1 } })).toEqual([])
	})

	it('detects a free order and keeps the status as stored', () => {
		expect(isPaymentNotRequired({ paymentStatus: 'not_required' })).toBe(true)
		expect(isPaymentNotRequired({ paymentStatus: 'paid' })).toBe(false)
		expect(
			paymentDisplayStatus({
				paymentStatus: 'not_required',
				totalCents: 0,
				refundedCents: 0,
			}),
		).toBe('not_required')
	})

	it('tolerates malformed discount fields on the order payload', () => {
		const shape = orderSchema.shape
		expect(shape.discountCents.parse(undefined)).toBeUndefined()
		expect(shape.discountCents.parse('x')).toBeUndefined()
		expect(shape.deliveryDiscountCents.parse(250)).toBe(250)
		expect(shape.discounts.parse('x')).toBeUndefined()
	})
})

describe('promised time fields', () => {
	it('default to none when an older region leaves them out', () => {
		const shape = orderSchema.shape
		expect(shape.promisedAt.parse(undefined)).toBeNull()
		expect(shape.promisedUntil.parse(undefined)).toBeNull()
		expect(shape.promisedVersion.parse(undefined)).toBe(0)
		expect(shape.promisedDelayMinutes.parse(undefined)).toBe(0)
		expect(shape.promisedDelayMinutes.parse(25)).toBe(25)
		expect(shape.promisedAt.parse('2026-10-19T18:40:00.000Z')).toBe(
			'2026-10-19T18:40:00.000Z',
		)
	})
})
