import { describe, expect, it } from 'vitest'
import { refundSubmitKey } from './submit-key.ts'

const KEY_SHAPE = /^[A-Za-z0-9._:-]{8,128}$/

describe('refundSubmitKey', () => {
	it('is stable for the same parts and fits the header rules', () => {
		const parts = {
			saleId: 'ord_1',
			refundedMinor: 0,
			body: { amountCents: 450, note: 'Cold fries' },
		}
		const first = refundSubmitKey('order-refund', parts)
		expect(refundSubmitKey('order-refund', parts)).toBe(first)
		expect(first).toMatch(KEY_SHAPE)
		expect(first.startsWith('order-refund-')).toBe(true)
	})

	it('changes with the sale, the refunded total, the content or the prefix', () => {
		const base = {
			saleId: 'ord_1',
			refundedMinor: 0,
			body: { full: true, note: 'Returned in the dashboard' },
		}
		const key = refundSubmitKey('order-refund', base)
		expect(
			refundSubmitKey('order-refund', { ...base, saleId: 'ord_2' }),
		).not.toBe(key)
		expect(
			refundSubmitKey('order-refund', { ...base, refundedMinor: 450 }),
		).not.toBe(key)
		expect(
			refundSubmitKey('order-refund', {
				...base,
				body: { amountCents: 450, note: 'Returned in the dashboard' },
			}),
		).not.toBe(key)
		expect(refundSubmitKey('lty-refund', base)).not.toBe(key)
	})
})
