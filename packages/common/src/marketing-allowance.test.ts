import { describe, expect, test } from 'vitest'
import {
	billingPeriod,
	DEFAULT_SMS_SENDS_PER_MONTH,
	isPeriodKey,
	smsAllowanceFrom,
	smsSendsForPlan,
} from './marketing-allowance.ts'

describe('plans', () => {
	test('a plan includes its own number, the default otherwise', () => {
		expect(smsSendsForPlan('Growth')).toBe(12)
		expect(smsSendsForPlan('  PRO ')).toBe(20)
		expect(smsSendsForPlan('Mystery plan')).toBe(DEFAULT_SMS_SENDS_PER_MONTH)
		expect(smsSendsForPlan(null)).toBe(DEFAULT_SMS_SENDS_PER_MONTH)
	})
})

describe('billing month', () => {
	test('the month an instant is in, and when it resets', () => {
		const period = billingPeriod(Date.UTC(2026, 10, 21, 13))
		expect(period.key).toBe('2026-11')
		expect(period.startsAt).toBe(Date.UTC(2026, 10, 1))
		expect(period.resetsAt).toBe(Date.UTC(2026, 11, 1))
	})

	test('rolls over a year end', () => {
		const period = billingPeriod(Date.UTC(2026, 11, 31, 23, 59, 59))
		expect(period.key).toBe('2026-12')
		expect(period.resetsAt).toBe(Date.UTC(2027, 0, 1))
		expect(billingPeriod(Date.UTC(2027, 0, 1)).key).toBe('2027-01')
	})

	test('keys are validated', () => {
		expect(isPeriodKey('2026-11')).toBe(true)
		for (const bad of ['2026-13', '2026-1', '26-11', '', null]) {
			expect(isPeriodKey(bad)).toBe(false)
		}
	})
})

describe('allowance', () => {
	const period = billingPeriod(Date.UTC(2026, 10, 21))
	test('remaining is the limit plus the grant, less what was used', () => {
		expect(
			smsAllowanceFrom({
				planName: 'starter',
				period,
				sends: 1,
				extraSends: 0,
			}),
		).toMatchObject({ limit: 4, used: 1, remaining: 3 })
		expect(
			smsAllowanceFrom({
				planName: 'starter',
				period,
				sends: 4,
				extraSends: 3,
			}),
		).toMatchObject({ limit: 7, extra: 3, remaining: 3 })
	})

	test('never below zero', () => {
		expect(
			smsAllowanceFrom({ planName: 'starter', period, sends: 9, extraSends: 0 })
				.remaining,
		).toBe(0)
	})
})
