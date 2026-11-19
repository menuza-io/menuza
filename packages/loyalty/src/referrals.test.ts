import { describe, expect, it } from 'vitest'
import {
	generateReferralCode,
	isReferralCodeFormat,
	loyaltyReferralConfigSchema,
	normalizeReferralCode,
} from './referrals.ts'

describe('loyaltyReferralConfigSchema', () => {
	it('requires at least one reward when referrals are enabled', () => {
		expect(loyaltyReferralConfigSchema.parse({}).enabled).toBe(false)
		expect(
			loyaltyReferralConfigSchema.safeParse({
				enabled: true,
				referrerPoints: 0,
				friendPoints: 0,
				friendDiscount: null,
			}).success,
		).toBe(false)
		expect(
			loyaltyReferralConfigSchema.safeParse({
				enabled: true,
				referrerPoints: 100,
				friendDiscount: { type: 'fixed', amountMinor: 500 },
				holdDays: 14,
			}).success,
		).toBe(true)
	})
})

describe('referral codes', () => {
	it('generates and normalizes Crockford-base32 referral codes', () => {
		const code = generateReferralCode()
		expect(code).toMatch(/^REF-[0-9A-HJKMNP-TV-Z]{8}$/)
		expect(isReferralCodeFormat(code)).toBe(true)
		expect(normalizeReferralCode(`  ${code.toLowerCase()} `)).toBe(code)
		expect(normalizeReferralCode(code.replace('REF-', ''))).toBe(code)
		expect(normalizeReferralCode('ref ooil 1122')).toBe('REF-00111122')
		expect(normalizeReferralCode('short')).toBeNull()
	})
})
