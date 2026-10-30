import { describe, expect, it } from 'vitest'
import { checkoutOrderPayload } from './checkout-payload.ts'

const contact = { name: 'Ada', phone: '+15550100', email: 'a@x.test' }

describe('checkoutOrderPayload', () => {
	it('places exactly the order the reward was priced against', () => {
		const priced = {
			locale: 'en',
			fulfillment: 'pickup',
			tipPercent: 10,
			lines: [{ itemId: 'i1', quantity: 2 }],
		}
		const reward = { rewardId: 'rwd_coffee', lineId: 'l1' }
		expect(checkoutOrderPayload(priced, { contact, reward })).toEqual({
			...priced,
			contact,
			loyalty: reward,
		})
	})

	it('adds delivery notes to the priced address without touching the quote', () => {
		const priced = {
			fulfillment: 'delivery',
			delivery: { address: '1 Main Street', quoteToken: 'q1' },
		}
		const payload = checkoutOrderPayload(priced, {
			contact,
			deliveryNotes: '  Ring twice ',
			reward: null,
		})
		expect(payload.delivery).toEqual({
			address: '1 Main Street',
			quoteToken: 'q1',
			notes: 'Ring twice',
		})
		expect(priced.delivery).toEqual({
			address: '1 Main Street',
			quoteToken: 'q1',
		})
		expect(payload).not.toHaveProperty('loyalty')
	})

	it('sends no notes for a pickup', () => {
		const payload = checkoutOrderPayload(
			{ fulfillment: 'pickup' },
			{ contact, deliveryNotes: 'Ring twice', reward: null },
		)
		expect(payload).not.toHaveProperty('delivery')
	})
})
