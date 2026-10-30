import { describe, expect, it } from 'vitest'
import {
	canRefundPurchase,
	formatLoyaltyMoney,
	minorToMoneyInput,
	parsePercentToBp,
} from './loyalty-view.ts'

describe('formatLoyaltyMoney', () => {
	it('divides by the currency exponent, not always by 100', () => {
		expect(formatLoyaltyMoney(1550, 'USD', 'en-US')).toBe('$15.50')
		expect(formatLoyaltyMoney(1550, 'SAR', 'en-US')).toBe('SAR\u00a015.50')
		expect(formatLoyaltyMoney(1550, 'KWD', 'en-US')).toBe('KWD\u00a01.550')
		expect(formatLoyaltyMoney(1550, 'JPY', 'en-US')).toBe('¥1,550')
	})
})

describe('minorToMoneyInput', () => {
	it('writes the field value in the currency exponent', () => {
		expect(minorToMoneyInput(1550, 'USD')).toBe('15.50')
		expect(minorToMoneyInput(1550, 'SAR')).toBe('15.50')
		expect(minorToMoneyInput(1550, 'KWD')).toBe('1.550')
		expect(minorToMoneyInput(1550, 'JPY')).toBe('1550')
		expect(minorToMoneyInput(null, 'USD')).toBe('')
	})
})

describe('parsePercentToBp', () => {
	it('reads a percentage from 0.01 to 100 as basis points', () => {
		expect(parsePercentToBp('10')).toBe(1000)
		expect(parsePercentToBp(' 12.5 ')).toBe(1250)
		expect(parsePercentToBp('0.01')).toBe(1)
		expect(parsePercentToBp('100')).toBe(10_000)
		expect(parsePercentToBp('١٢٫٥')).toBe(1250)
		for (const input of ['0', '100.01', '', 'abc', '-5', '12.345']) {
			expect(parsePercentToBp(input)).toBeNull()
		}
	})

	it('ignores the direction marks a copied Arabic number carries', () => {
		expect(parsePercentToBp('\u200f١٢٫٥\u200e')).toBe(1250)
		expect(parsePercentToBp('\u061c10')).toBe(1000)
	})

	it('never reads a comma as a decimal mark', () => {
		// Stripping commas read "1,5" as 15%.
		expect(parsePercentToBp('1,5')).toBeNull()
		expect(parsePercentToBp('12,5')).toBeNull()
	})
})

describe('canRefundPurchase', () => {
	const tab = {
		sourceType: 'qr_tab',
		state: 'completed',
		excludedReason: null,
		refundedMinor: 0,
		totalPaidMinor: 2000,
	}

	it('offers a refund on a paid QR tab until everything has come back', () => {
		expect(canRefundPurchase(tab)).toBe(true)
		expect(canRefundPurchase({ ...tab, refundedMinor: 1999 })).toBe(true)
		expect(canRefundPurchase({ ...tab, refundedMinor: 2000 })).toBe(false)
	})

	it('offers one on a cancelled or parked tab, not an open one', () => {
		expect(
			canRefundPurchase({
				...tab,
				state: 'excluded',
				excludedReason: 'cancelled',
			}),
		).toBe(true)
		expect(
			canRefundPurchase({ ...tab, state: 'excluded', excludedReason: 'x' }),
		).toBe(false)
		expect(canRefundPurchase({ ...tab, state: 'review' })).toBe(true)
		expect(canRefundPurchase({ ...tab, state: 'open' })).toBe(false)
	})

	it('leaves online orders and till sales to their own screens', () => {
		expect(canRefundPurchase({ ...tab, sourceType: 'restaurant_order' })).toBe(
			false,
		)
		expect(canRefundPurchase({ ...tab, sourceType: 'pos_order' })).toBe(false)
	})
})
