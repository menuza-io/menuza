import { describe, expect, it } from 'vitest'
import {
	VERIFICATION_EXPIRY_MS,
	VERIFICATION_FRESH_MS,
	VERIFICATION_LOCK_MS,
	VERIFICATION_MAX_ATTEMPTS,
	generateVerificationCode,
	normalizeVerificationCode,
} from './support-verification.ts'
import {
	classifyLineType,
	maskEmail,
	maskPhone,
	mergeDeliveryStatus,
	numberProblem,
	statusFromResendEvent,
	statusFromTwilioStatus,
} from './sign-in-delivery.ts'
import { pickSupportContact } from './support-assignments.ts'

describe('caller verification rules', () => {
	it('pin the decided numbers', () => {
		expect(VERIFICATION_EXPIRY_MS).toBe(10 * 60_000)
		expect(VERIFICATION_FRESH_MS).toBe(15 * 60_000)
		expect(VERIFICATION_MAX_ATTEMPTS).toBe(5)
		expect(VERIFICATION_LOCK_MS).toBe(60 * 60_000)
	})

	it('makes a 6-digit code, keeping leading zeros', () => {
		expect(generateVerificationCode(() => new Uint8Array([0, 0, 0, 7]))).toBe(
			'000007',
		)
		for (let i = 0; i < 50; i++) {
			expect(generateVerificationCode()).toMatch(/^\d{6}$/)
		}
	})

	it('reads what an agent types', () => {
		expect(normalizeVerificationCode('123 456')).toBe('123456')
		expect(normalizeVerificationCode('123-456')).toBe('123456')
		expect(normalizeVerificationCode('12345')).toBeNull()
		expect(normalizeVerificationCode('abcdef')).toBeNull()
		expect(normalizeVerificationCode(123456)).toBeNull()
	})
})

describe('delivery vocabulary', () => {
	it('maps provider events and keeps the later stage', () => {
		expect(statusFromResendEvent('email.delivered')).toBe('delivered')
		expect(statusFromResendEvent('email.bounced')).toBe('bounced')
		expect(statusFromResendEvent('email.opened')).toBeNull()
		expect(statusFromTwilioStatus('undelivered')).toBe('bounced')
		expect(mergeDeliveryStatus('delivered', 'sent')).toBe('delivered')
		expect(mergeDeliveryStatus('sent', 'delivered')).toBe('delivered')
	})

	it('masks an address or a number', () => {
		expect(maskEmail('Jane.Doe@Example.com')).toBe('j***@example.com')
		expect(maskPhone('+15551234567')).toBe('+1 ••• ••• 4567')
	})

	it('flags a landline, a virtual number and an invalid number', () => {
		expect(numberProblem({ valid: false, lineType: 'unknown' })).toBe('invalid')
		expect(
			numberProblem({ valid: true, lineType: classifyLineType('landline') }),
		).toBe('landline')
		expect(
			numberProblem({
				valid: true,
				lineType: classifyLineType('nonFixedVoip'),
			}),
		).toBe('voip')
		expect(
			numberProblem({ valid: true, lineType: classifyLineType('mobile') }),
		).toBeNull()
	})
})

describe('support contact', () => {
	const rows = [
		{ role: 'account_manager', scopeKey: 'all', adminUserId: 'am' },
		{ role: 'support', scopeKey: 'loc1', adminUserId: 'sup-loc1' },
		{ role: 'support', scopeKey: 'all', adminUserId: 'sup' },
	]
	it('prefers support for the location, then support for all, then the account manager', () => {
		expect(pickSupportContact(rows, 'loc1')?.adminUserId).toBe('sup-loc1')
		expect(pickSupportContact(rows, 'loc2')?.adminUserId).toBe('sup')
		expect(pickSupportContact(rows)?.adminUserId).toBe('sup')
		expect(pickSupportContact([rows[0]!])?.adminUserId).toBe('am')
		expect(pickSupportContact([])).toBeNull()
	})
})
