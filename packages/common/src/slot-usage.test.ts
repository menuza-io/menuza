import { describe, expect, it } from 'vitest'

import {
	type OrderLimitExempt,
	slotLimitForFulfillment,
	slotUsageUnits,
	wouldExceedSlotLimit,
} from './slot-usage.ts'
import type { SlotLimitSettings } from './location-types.ts'

const baseSettings = (): SlotLimitSettings => ({
	enabled: true,
	unit: 'orders',
	defaultLimit: 5,
	allowOneLargeOrderPerSlot: false,
})

const emptyExempt = (): OrderLimitExempt => ({
	itemIds: new Set(),
	categoryIds: new Set(),
})

describe('slotUsageUnits', () => {
	it('returns 0 when limits are off', () => {
		expect(
			slotUsageUnits({
				settings: { ...baseSettings(), enabled: false },
				lines: [{ itemId: 'a', quantity: 2, categoryIds: [] }],
				exempt: emptyExempt(),
			}),
		).toBe(0)
	})

	it('counts one order when any line is not exempt', () => {
		expect(
			slotUsageUnits({
				settings: baseSettings(),
				lines: [
					{ itemId: 'drink', quantity: 3, categoryIds: ['bev'] },
					{ itemId: 'burger', quantity: 1, categoryIds: ['food'] },
				],
				exempt: { itemIds: new Set(['drink']), categoryIds: new Set() },
			}),
		).toBe(1)
	})

	it('returns 0 for exempt-only orders', () => {
		const exempt = {
			itemIds: new Set<string>(),
			categoryIds: new Set(['bev']),
		}
		expect(
			slotUsageUnits({
				settings: baseSettings(),
				lines: [{ itemId: 'soda', quantity: 4, categoryIds: ['bev'] }],
				exempt,
			}),
		).toBe(0)
	})

	it('sums dish quantities when unit is dishes', () => {
		expect(
			slotUsageUnits({
				settings: { ...baseSettings(), unit: 'dishes' },
				lines: [
					{ itemId: 'a', quantity: 2, categoryIds: [] },
					{ itemId: 'b', quantity: 1, categoryIds: [] },
				],
				exempt: emptyExempt(),
			}),
		).toBe(3)
	})

	it('ignores exempt dish lines', () => {
		expect(
			slotUsageUnits({
				settings: { ...baseSettings(), unit: 'dishes' },
				lines: [
					{ itemId: 'a', quantity: 2, categoryIds: [] },
					{ itemId: 'b', quantity: 3, categoryIds: ['bev'] },
				],
				exempt: { itemIds: new Set(), categoryIds: new Set(['bev']) },
			}),
		).toBe(2)
	})
})

describe('slotLimitForFulfillment', () => {
	it('uses per-fulfillment overrides when set', () => {
		const settings: SlotLimitSettings = {
			...baseSettings(),
			pickupLimit: 3,
			deliveryLimit: 7,
		}
		expect(slotLimitForFulfillment(settings, 'pickup')).toBe(3)
		expect(slotLimitForFulfillment(settings, 'delivery')).toBe(7)
	})
})

describe('wouldExceedSlotLimit', () => {
	it('allows a single oversized order when the flag is on', () => {
		expect(
			wouldExceedSlotLimit({
				used: 0,
				incoming: 12,
				limit: 5,
				allowOneLargeOrderPerSlot: true,
			}),
		).toBe(false)
	})

	it('refuses a second oversized order in the same slot', () => {
		expect(
			wouldExceedSlotLimit({
				used: 12,
				incoming: 1,
				limit: 5,
				allowOneLargeOrderPerSlot: true,
			}),
		).toBe(true)
	})
})
