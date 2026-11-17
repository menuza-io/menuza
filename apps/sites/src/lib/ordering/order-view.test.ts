import { describe, expect, it } from 'vitest'
import {
	receiptLineNote,
	receiptPackagingLine,
	receiptPickupInstructions,
	receiptRecipientText,
	receiptTaxIncluded,
	receiptUtensilsText,
} from './order-view.ts'

const DELIVER = 'Deliver to: {address}'

describe('receiptRecipientText', () => {
	it('prints contact and address for the receipt-token body', () => {
		expect(
			receiptRecipientText(
				{
					fulfillment: 'delivery',
					contact: { name: 'Sam', phone: '+15550100' },
					delivery: { address: '1 Main St', unit: '4B', city: 'Austin' },
				},
				DELIVER,
			),
		).toBe('Sam • +15550100 • Deliver to: 1 Main St, 4B, Austin')
	})

	it('is empty for the reduced link body of a delivery order', () => {
		const reduced = {
			fulfillment: 'delivery',
			delivery: { feeCents: 300, zoneId: 'z1' },
		}
		const text = receiptRecipientText(reduced, DELIVER)
		expect(text).toBe('')
		expect(text).not.toContain('undefined')
	})

	it('handles a null delivery and a missing contact on pickup', () => {
		expect(
			receiptRecipientText({ fulfillment: 'pickup', delivery: null }, DELIVER),
		).toBe('')
	})
})

describe('receiptLineNote', () => {
	it('hides null, missing and blank notes', () => {
		expect(receiptLineNote(null)).toBeNull()
		expect(receiptLineNote(undefined)).toBeNull()
		expect(receiptLineNote('  ')).toBeNull()
		expect(receiptLineNote('no onions')).toBe('no onions')
	})
})

describe('receiptPackagingLine (#408)', () => {
	it('shows the fee under the default name in the page language', () => {
		expect(
			receiptPackagingLine(
				{ packagingFeeCents: 100, packagingFeeLabel: 'Packaging fee' },
				"Frais d'emballage",
			),
		).toEqual({ label: "Frais d'emballage", cents: 100 })
	})

	it('shows the name the restaurant gave it, as the guest saw it', () => {
		expect(
			receiptPackagingLine(
				{ packagingFeeCents: 50, packagingFeeLabel: 'Bag fee' },
				'Packaging fee',
			),
		).toEqual({ label: 'Bag fee', cents: 50 })
	})

	it('falls back to the default name when none was saved', () => {
		expect(
			receiptPackagingLine(
				{ packagingFeeCents: 50, packagingFeeLabel: null },
				'Packaging fee',
			)?.label,
		).toBe('Packaging fee')
		expect(
			receiptPackagingLine(
				{ packagingFeeCents: 50, packagingFeeLabel: '  ' },
				'Packaging fee',
			)?.label,
		).toBe('Packaging fee')
	})

	it('is none for no fee, and for an order from before the fee existed', () => {
		expect(receiptPackagingLine({ packagingFeeCents: 0 }, 'x')).toBeNull()
		expect(receiptPackagingLine({}, 'x')).toBeNull()
		expect(receiptPackagingLine({ packagingFeeCents: null }, 'x')).toBeNull()
	})
})

describe('receiptUtensilsText (#257)', () => {
	const labels = { yes: 'Utensils: yes', no: 'No utensils' }

	it('says what the guest chose', () => {
		expect(receiptUtensilsText({ utensilsRequested: true }, labels)).toBe(
			'Utensils: yes',
		)
		expect(receiptUtensilsText({ utensilsRequested: false }, labels)).toBe(
			'No utensils',
		)
	})

	it('says nothing when it was not asked or the order predates it', () => {
		expect(receiptUtensilsText({ utensilsRequested: null }, labels)).toBeNull()
		expect(receiptUtensilsText({}, labels)).toBeNull()
	})
})

describe('receiptPickupInstructions (#251)', () => {
	it('keeps the text exactly, line breaks and markup included (the page escapes it)', () => {
		const text = 'Park in the side lot.\nAsk for <b>Sam</b>.'
		expect(
			receiptPickupInstructions({
				fulfillment: 'pickup',
				pickupInstructions: text,
			}),
		).toBe(text)
	})

	it('is none for empty text, a missing field, and orders that are not a pickup', () => {
		expect(
			receiptPickupInstructions({
				fulfillment: 'pickup',
				pickupInstructions: null,
			}),
		).toBeNull()
		expect(
			receiptPickupInstructions({
				fulfillment: 'pickup',
				pickupInstructions: ' \n ',
			}),
		).toBeNull()
		expect(receiptPickupInstructions({ fulfillment: 'pickup' })).toBeNull()
		expect(
			receiptPickupInstructions({
				fulfillment: 'delivery',
				pickupInstructions: 'Hi',
			}),
		).toBeNull()
		expect(
			receiptPickupInstructions({
				fulfillment: 'dine_in',
				pickupInstructions: 'Hi',
			}),
		).toBeNull()
	})
})

describe('receiptTaxIncluded', () => {
	const base = {
		taxCents: 182,
		subtotalCents: 2000,
		itemSavingCents: 0,
		loyaltyCents: 0,
		deliveryNetCents: 0,
		tipCents: 0,
	}

	it('reads an inclusive order: the total never added the tax', () => {
		expect(receiptTaxIncluded({ ...base, totalCents: 2000 })).toBe(true)
	})

	it('reads an exclusive order: the total is the subtotal plus tax', () => {
		expect(receiptTaxIncluded({ ...base, totalCents: 2182 })).toBe(false)
	})

	it('still reads an inclusive order correctly when a packaging or service fee is in the total', () => {
		expect(
			receiptTaxIncluded({ ...base, packagingFeeCents: 110, totalCents: 2110 }),
		).toBe(true)
		expect(
			receiptTaxIncluded({
				...base,
				packagingFeeCents: 110,
				serviceFeeCents: 60,
				totalCents: 2170,
			}),
		).toBe(true)
		// Without counting the fee, the same receipt would read as exclusive.
		expect(receiptTaxIncluded({ ...base, totalCents: 2110 })).toBe(false)
	})

	it('counts savings, a reward, a delivery fee and a tip', () => {
		expect(
			receiptTaxIncluded({
				...base,
				itemSavingCents: 200,
				loyaltyCents: 100,
				deliveryNetCents: 300,
				tipCents: 150,
				totalCents: 2000 - 200 - 100 + 300 + 150,
			}),
		).toBe(true)
	})

	it('is false without tax', () => {
		expect(receiptTaxIncluded({ ...base, taxCents: 0, totalCents: 2000 })).toBe(
			false,
		)
	})
})
