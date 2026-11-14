import { describe, expect, it } from 'vitest'
import { receiptOrder } from './order-service.ts'

describe('receiptOrder', () => {
	const base = {
		id: 'ord_1',
		number: '1001',
		status: 'cancelled',
		paymentStatus: 'paid',
		currency: 'USD',
		subtotalCents: 1000,
		taxCents: 0,
		deliveryFeeCents: 0,
		tipCents: 0,
		loyaltyDiscountCents: 0,
		discountCents: 0,
		deliveryDiscountCents: 0,
		discounts: [],
		totalCents: 1000,
		holdExpiresAt: null,
		promisedAt: null,
		promisedUntil: null,
		tipPercent: 0,
		fulfillment: 'pickup',
		locale: 'en',
		createdAt: null,
		scheduledFor: null,
		locationId: 'loc-1',
		locationName: 'Main',
		lines: [],
		contactName: 'A',
		contactPhone: '+15551234567',
	}

	it('carries the refunded amount so the guest page can show it', () => {
		const receipt = receiptOrder({ ...base, refundedCents: 750 } as never)
		expect(receipt.refundedCents).toBe(750)
	})

	it('reports zero when nothing was refunded', () => {
		const receipt = receiptOrder({ ...base, refundedCents: 0 } as never)
		expect(receipt.refundedCents).toBe(0)
	})
})
