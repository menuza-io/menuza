import { describe, expect, it } from 'vitest'
import {
	audienceDefinitionSchema,
	namesSensitiveRule,
} from './marketing-audiences.ts'
import { restaurantOrderQuoteSchema } from './restaurant-orders.ts'

describe('marketing audiences loyalty_tier rule', () => {
	it('accepts loyalty_tier rules and does not flag them as sensitive', () => {
		const def = {
			match: 'all',
			rules: [{ field: 'loyalty_tier', tierId: 'gold' }],
		}
		expect(namesSensitiveRule(def)).toBe(false)
		expect(audienceDefinitionSchema.parse(def)).toEqual(def)
	})

	it('rejects empty tierId values', () => {
		expect(
			audienceDefinitionSchema.safeParse({
				match: 'all',
				rules: [{ field: 'loyalty_tier', tierId: '  ' }],
			}).success,
		).toBe(false)
	})
})

describe('restaurant order referralDeviceId', () => {
	it('accepts optional referralDeviceId on order quote payloads', () => {
		const parsed = restaurantOrderQuoteSchema.safeParse({
			locationId: 'loc_1',
			fulfillment: 'pickup',
			paymentMethod: 'handoff',
			tipPercent: 0,
			referralDeviceId: 'dev_abc123',
			lines: [{ itemId: 'item_1', quantity: 1, options: [] }],
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.referralDeviceId).toBe('dev_abc123')
		}
	})
})
