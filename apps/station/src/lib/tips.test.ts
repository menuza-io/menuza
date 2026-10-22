import { describe, expect, it } from 'vitest'
import { tipsAllowed } from './tips.ts'

describe('tipsAllowed', () => {
	it('follows the location setting per order type', () => {
		const off = { inHouseTips: { dineInTips: false, pickupTips: true } }
		expect(tipsAllowed(off, 'dine_in')).toBe(false)
		expect(tipsAllowed(off, 'takeaway')).toBe(true)
		const other = { inHouseTips: { dineInTips: true, pickupTips: false } }
		expect(tipsAllowed(other, 'dine_in')).toBe(true)
		expect(tipsAllowed(other, 'takeaway')).toBe(false)
	})

	it('allows tips when the setting is missing, so an old payload never removes tipping', () => {
		expect(tipsAllowed(null, 'dine_in')).toBe(true)
		expect(tipsAllowed({}, 'takeaway')).toBe(true)
		expect(tipsAllowed({ inHouseTips: {} }, 'dine_in')).toBe(true)
	})
})
