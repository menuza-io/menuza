import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
	TRIAL_DAYS: 14 as number | string | undefined,
	CREDIT_CARD_REQUIRED_FOR_TRIAL: 'manual' as 'stripe' | 'manual' | string,
}))

vi.mock('../src/env.js', () => ({
	get ENV() {
		return mockEnv
	},
}))

import {
	calculateManualTrialDaysRemaining,
	getTrialConfig,
} from '../src/trial-config'

describe('Trial Configuration', () => {
	beforeEach(() => {
		mockEnv.TRIAL_DAYS = 14
		mockEnv.CREDIT_CARD_REQUIRED_FOR_TRIAL = 'manual'
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('getTrialConfig', () => {
		it('should return default values when env vars are not set', () => {
			mockEnv.TRIAL_DAYS = undefined
			mockEnv.CREDIT_CARD_REQUIRED_FOR_TRIAL = undefined as any

			const config = getTrialConfig()
			expect(config.trialDays).toBe(14)
			expect(config.creditCardRequired).toBe('manual')
		})

		it('should use environment variables when set', () => {
			mockEnv.TRIAL_DAYS = 30
			mockEnv.CREDIT_CARD_REQUIRED_FOR_TRIAL = 'stripe'

			const config = getTrialConfig()
			expect(config.trialDays).toBe(30)
			expect(config.creditCardRequired).toBe('stripe')
		})

		it('should throw error for invalid TRIAL_DAYS', () => {
			mockEnv.TRIAL_DAYS = 'invalid'

			expect(() => getTrialConfig()).toThrow(
				'TRIAL_DAYS must be a valid positive number',
			)
		})

		it('should throw error for invalid CREDIT_CARD_REQUIRED_FOR_TRIAL', () => {
			mockEnv.CREDIT_CARD_REQUIRED_FOR_TRIAL = 'invalid'

			expect(() => getTrialConfig()).toThrow(
				'CREDIT_CARD_REQUIRED_FOR_TRIAL must be either "stripe" or "manual"',
			)
		})
	})

	describe('calculateManualTrialDaysRemaining', () => {
		beforeEach(() => {
			mockEnv.TRIAL_DAYS = 14
			mockEnv.CREDIT_CARD_REQUIRED_FOR_TRIAL = 'manual'
		})

		it('should calculate correct days remaining for new organization', () => {
			const today = new Date()
			const daysRemaining = calculateManualTrialDaysRemaining(today)
			expect(daysRemaining).toBe(14)
		})

		it('should calculate correct days remaining for 5-day-old organization', () => {
			const fiveDaysAgo = new Date()
			fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5)

			const daysRemaining = calculateManualTrialDaysRemaining(fiveDaysAgo)
			expect(daysRemaining).toBe(9)
		})

		it('should return 0 for expired trial', () => {
			const twentyDaysAgo = new Date()
			twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20)

			const daysRemaining = calculateManualTrialDaysRemaining(twentyDaysAgo)
			expect(daysRemaining).toBe(0)
		})

		it('should adapt to different TRIAL_DAYS values', () => {
			mockEnv.TRIAL_DAYS = 30

			const tenDaysAgo = new Date()
			tenDaysAgo.setDate(tenDaysAgo.getDate() - 10)

			const daysRemaining = calculateManualTrialDaysRemaining(tenDaysAgo)
			expect(daysRemaining).toBe(20)
		})
	})
})
