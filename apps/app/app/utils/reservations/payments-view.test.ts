import { describe, expect, it } from 'vitest'
import {
	currencyFractionDigits,
	feeKindFor,
	formatMoney,
	hasInFlightPayment,
	paymentBadge,
	parseMoneyInput,
	refundableMinor,
} from '#app/utils/reservations/payments-view.ts'

describe('paymentBadge', () => {
	it('gives no badge to a booking without a payment', () => {
		expect(paymentBadge('none')).toBeNull()
		expect(paymentBadge(undefined)).toBeNull()
		expect(paymentBadge('something_new')).toBeNull()
	})

	it.each([
		['paid', 'success'],
		['guaranteed', 'secondary'],
		['fee_pending', 'warning'],
		['fee_charged', 'secondary'],
		['fee_failed', 'destructive'],
		['refund_pending', 'warning'],
		['disputed', 'destructive'],
		['pending', 'warning'],
		['review', 'warning'],
	])('%s -> %s', (status, variant) => {
		expect(paymentBadge(status)?.variant).toBe(variant)
	})

	it('calls a paid experience booking prepaid and any other paid booking a deposit', () => {
		expect(paymentBadge('paid', { experience: true })?.label.message).toBe(
			'Prepaid',
		)
		expect(paymentBadge('paid')?.label.message).toBe('Deposit paid')
	})
})

describe('money', () => {
	it('formats integer minor units in the location currency', () => {
		expect(formatMoney(2500, 'USD', 'en')).toBe('$25.00')
		expect(formatMoney(50000, 'SAR', 'en')).toMatch(/500\.00/)
		expect(formatMoney(50000, 'SAR', 'en')).toMatch(/SAR|ر\.س/)
		expect(formatMoney(1500, 'JPY', 'en')).toMatch(/1,500/)
	})

	it('knows the decimals of a currency', () => {
		expect(currencyFractionDigits('USD')).toBe(2)
		expect(currencyFractionDigits('JPY')).toBe(0)
		expect(currencyFractionDigits('KWD')).toBe(3)
	})

	it('parses typed amounts without floats and refuses bad input', () => {
		expect(parseMoneyInput('25', 'USD')).toBe(2500)
		expect(parseMoneyInput('25.5', 'USD')).toBe(2550)
		expect(parseMoneyInput('25,05', 'USD')).toBe(2505)
		expect(parseMoneyInput('0.07', 'USD')).toBe(7)
		expect(parseMoneyInput('1.005', 'USD')).toBeNull()
		expect(parseMoneyInput('0', 'USD')).toBeNull()
		expect(parseMoneyInput('-4', 'USD')).toBeNull()
		expect(parseMoneyInput('abc', 'USD')).toBeNull()
		expect(parseMoneyInput('', 'USD')).toBeNull()
		expect(parseMoneyInput('500', 'JPY')).toBe(500)
		expect(parseMoneyInput('500.5', 'JPY')).toBeNull()
	})
})

describe('refunds and fees', () => {
	const row = (over: Record<string, unknown>) => ({
		id: 'p',
		kind: 'deposit_charge',
		status: 'succeeded',
		amountMinor: 10000,
		refundedMinor: 0,
		parentPaymentId: null,
		...over,
	})

	it('counts what is left on succeeded deposits and prepayments only', () => {
		expect(
			refundableMinor([
				row({ refundedMinor: 4000 }),
				row({ kind: 'prepay_charge', amountMinor: 5000 }),
				row({ kind: 'no_show_fee_charge', amountMinor: 3000 }),
				row({ status: 'failed' }),
				row({ kind: 'refund', amountMinor: 4000 }),
			]),
		).toBe(11000)
	})

	it('knows which fee a host can charge', () => {
		expect(feeKindFor({ status: 'no_show', lateCancel: false })).toBe(
			'no_show_fee',
		)
		expect(feeKindFor({ status: 'cancelled', lateCancel: true })).toBe(
			'late_cancel_fee',
		)
		expect(feeKindFor({ status: 'cancelled', lateCancel: false })).toBeNull()
		expect(feeKindFor({ status: 'booked', lateCancel: false })).toBeNull()
	})

	it('keeps refreshing while a payment is moving', () => {
		expect(hasInFlightPayment([{ status: 'succeeded' }])).toBe(false)
		expect(hasInFlightPayment([{ status: 'refund_pending' }])).toBe(true)
		expect(hasInFlightPayment([{ status: 'requested' }])).toBe(true)
	})
})
