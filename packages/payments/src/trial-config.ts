/**
 * Trial configuration utilities
 * Centralizes trial-related environment variable handling
 */

import { type TrialConfig } from './types'
import { ENV } from './package-env.ts'

export function getTrialConfig(): TrialConfig {
	const trialDays = parseInt(String(ENV.TRIAL_DAYS ?? '14'), 10)
	const creditCardRequired = (ENV.CREDIT_CARD_REQUIRED_FOR_TRIAL ||
		'manual') as 'stripe' | 'manual'

	// Validate configuration
	if (isNaN(trialDays) || trialDays < 0) {
		throw new Error('TRIAL_DAYS must be a valid positive number')
	}

	if (!['stripe', 'manual'].includes(creditCardRequired)) {
		throw new Error(
			'CREDIT_CARD_REQUIRED_FOR_TRIAL must be either "stripe" or "manual"',
		)
	}

	return {
		trialDays,
		creditCardRequired,
	}
}

/**
 * Calculate days remaining in trial for manual trial mode
 */
export function calculateManualTrialDaysRemaining(
	organizationCreatedAt: Date,
): number {
	const config = getTrialConfig()
	const daysSinceCreation = Math.floor(
		(new Date().getTime() - organizationCreatedAt.getTime()) /
			(1000 * 60 * 60 * 24),
	)
	return Math.max(0, config.trialDays - daysSinceCreation)
}
