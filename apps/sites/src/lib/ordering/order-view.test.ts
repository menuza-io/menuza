import { describe, expect, it } from 'vitest'
import { receiptLineNote, receiptRecipientText } from './order-view.ts'

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
