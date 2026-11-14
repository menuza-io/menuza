import { computePromisedTime } from '@repo/common/promised-time'
import { describe, expect, it } from 'vitest'
import { asapEstimate } from './asap-estimate.ts'

const NOW = new Date('2026-11-13T18:00:00.000Z')
const MIN = 60_000
const location = {
	timezone: 'America/New_York',
	prepTime: 20,
	deliveryConfig: {
		providers: ['in_house'],
		estimatedDeliveryTimeMin: 30,
		estimatedDeliveryTimeMax: 45,
	} as never,
}
const rule = {
	threshold: 50,
	thresholdType: 'amount' as const,
	extraPrepMinutes: 10,
}

describe('asapEstimate', () => {
	it('adds the extra only over the threshold', () => {
		const under = asapEstimate({
			location,
			now: NOW,
			largeOrder: rule,
			subtotal: 50,
			itemCount: 2,
		})
		expect(under.pickupMinutes).toBe(20)
		expect(under.delivery).toEqual({ min: 50, max: 65 })
		const over = asapEstimate({
			location,
			now: NOW,
			largeOrder: rule,
			subtotal: 50.01,
			itemCount: 2,
		})
		expect(over.pickupMinutes).toBe(30)
		expect(over.delivery).toEqual({ min: 60, max: 75 })
	})

	it('matches the stored promise for the same inputs', () => {
		const cart = { subtotal: 80, itemCount: 3 }
		const shown = asapEstimate({
			location,
			now: NOW,
			largeOrder: rule,
			...cart,
		})
		const stored = (fulfillment: 'pickup' | 'delivery') =>
			computePromisedTime({
				now: NOW,
				fulfillment,
				scheduledFor: null,
				location,
				largeOrder: rule,
				subtotalCents: cart.subtotal * 100,
				itemCount: cart.itemCount,
			})
		const pickup = stored('pickup')
		expect(pickup.promisedAt!.getTime() - NOW.getTime()).toBe(
			shown.pickupMinutes * MIN,
		)
		const delivery = stored('delivery')
		expect(delivery.promisedAt!.getTime() - NOW.getTime()).toBe(
			shown.delivery.min * MIN,
		)
		expect(delivery.promisedUntil!.getTime() - NOW.getTime()).toBe(
			shown.delivery.max * MIN,
		)
	})

	it('counts items when the rule is by item count and ignores a missing rule', () => {
		const items = {
			threshold: 3,
			thresholdType: 'items' as const,
			extraPrepMinutes: 15,
		}
		expect(
			asapEstimate({
				location,
				now: NOW,
				largeOrder: items,
				subtotal: 1,
				itemCount: 4,
			}).pickupMinutes,
		).toBe(35)
		expect(
			asapEstimate({
				location,
				now: NOW,
				largeOrder: null,
				subtotal: 1e6,
				itemCount: 99,
			}).pickupMinutes,
		).toBe(20)
	})
})
