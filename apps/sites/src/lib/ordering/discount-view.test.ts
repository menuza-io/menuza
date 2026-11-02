import { describe, expect, it } from 'vitest'
import { discountLines, receiptDiscounts } from './discount-view.ts'

const labels = {
	discount: 'Discount',
	deliveryDiscount: '{name} (delivery)',
	deliveryDiscountPlain: 'Delivery discount',
}

describe('receiptDiscounts', () => {
	it('reads a named snapshot, including the code and a delivery line', () => {
		const receipt = receiptDiscounts(
			{
				paymentStatus: 'paid',
				discountCents: 300,
				deliveryDiscountCents: 200,
				loyaltyDiscountCents: 100,
				discounts: [
					{
						discountId: 'd1',
						name: 'Lunch',
						code: 'LUNCH',
						amountMinor: 300,
						deliveryAmountMinor: 200,
					},
				],
			},
			labels,
		)
		expect(receipt.lines).toEqual([
			{
				key: 'd1:items',
				label: 'Lunch',
				code: 'LUNCH',
				amountMinor: 300,
				delivery: false,
			},
			{
				key: 'd1:delivery',
				label: 'Lunch (delivery)',
				code: 'LUNCH',
				amountMinor: 200,
				delivery: true,
			},
		])
		expect(receipt.itemsCents).toBe(300)
		expect(receipt.deliveryCents).toBe(200)
		expect(receipt.loyaltyCents).toBe(100)
		expect(receipt.free).toBe(false)
	})

	it('falls back to the totals when an older order has no snapshot', () => {
		const receipt = receiptDiscounts(
			{
				paymentStatus: 'not_required',
				discountCents: 500,
				deliveryDiscountCents: 150,
			},
			labels,
		)
		expect(receipt.lines.map((line) => line.label)).toEqual([
			'Discount',
			'Delivery discount',
		])
		expect(receipt.free).toBe(true)
	})

	it('ignores a missing or empty discount payload', () => {
		expect(receiptDiscounts({}, labels)).toEqual({
			lines: [],
			itemsCents: 0,
			deliveryCents: 0,
			loyaltyCents: 0,
			free: false,
		})
	})
})

describe('discount names in the page language', () => {
	const discount = {
		discountId: 'd1',
		version: 1,
		name: 'Lunch',
		nameI18n: { en: 'Lunch', ar: 'غداء', fr: 'Déjeuner' },
		code: null,
		amountMinor: 300,
		deliveryAmountMinor: 200,
		lineIds: [],
	}

	it('labels the items and delivery lines in the guest language', () => {
		const lines = discountLines({ discounts: [discount] }, labels, {
			locale: 'ar-SA',
		})
		expect(lines.map((line) => line.label)).toEqual(['غداء', 'غداء (delivery)'])
	})

	it('falls back to the default language, then the canonical name', () => {
		expect(
			discountLines({ discounts: [discount] }, labels, {
				locale: 'de',
				defaultLocale: 'fr',
			})[0]?.label,
		).toBe('Déjeuner')
		expect(
			discountLines(
				{ discounts: [{ ...discount, nameI18n: undefined }] },
				labels,
				{ locale: 'ar' },
			)[0]?.label,
		).toBe('Lunch')
		expect(discountLines({ discounts: [discount] }, labels)[0]?.label).toBe(
			'Lunch',
		)
	})

	it('reads the receipt snapshot translations defensively', () => {
		const receipt = receiptDiscounts(
			{
				discounts: [
					{
						discountId: 'd1',
						name: 'Lunch',
						nameI18n: { ar: 'غداء', fr: 42 },
						code: null,
						amountMinor: 300,
					},
					{
						discountId: 'd2',
						name: 'Bad map',
						nameI18n: 'oops',
						amountMinor: 100,
					},
				],
			},
			labels,
			{ locale: 'ar', defaultLocale: 'en' },
		)
		expect(receipt.lines.map((line) => line.label)).toEqual(['غداء', 'Bad map'])
		const french = receiptDiscounts(
			{
				discounts: [
					{
						discountId: 'd1',
						name: 'Lunch',
						nameI18n: { ar: 'غداء', fr: 42 },
						amountMinor: 300,
					},
				],
			},
			labels,
			{ locale: 'fr', defaultLocale: 'en' },
		)
		expect(french.lines[0]?.label).toBe('Lunch')
	})
})
