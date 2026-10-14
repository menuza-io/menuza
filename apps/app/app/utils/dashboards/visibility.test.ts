import { type OnboardingProgressData } from '@repo/common/onboarding'
import { describe, expect, it } from 'vitest'
import { defaultHomeConfig } from './config.ts'
import { removeBlock } from './layout.ts'
import { hiddenBlockIds, isOnboardingVisible } from './visibility.ts'

function onboarding(
	overrides: Partial<OnboardingProgressData> = {},
): OnboardingProgressData {
	return {
		totalSteps: 6,
		completedCount: 2,
		isCompleted: false,
		isVisible: true,
		steps: [],
		...overrides,
	}
}

describe('isOnboardingVisible', () => {
	it('is visible while onboarding is open', () => {
		expect(isOnboardingVisible(onboarding())).toBe(true)
	})

	it('is hidden once onboarding is completed or dismissed', () => {
		expect(isOnboardingVisible(onboarding({ isCompleted: true }))).toBe(false)
		expect(isOnboardingVisible(onboarding({ isVisible: false }))).toBe(false)
		expect(
			isOnboardingVisible(onboarding({ isCompleted: true, isVisible: true })),
		).toBe(false)
	})

	it('is hidden when there is no progress', () => {
		expect(isOnboardingVisible(null)).toBe(false)
		expect(isOnboardingVisible(undefined)).toBe(false)
	})
})

describe('hiddenBlockIds', () => {
	const { blocks } = defaultHomeConfig()

	it('hides nothing while onboarding is open', () => {
		expect(hiddenBlockIds(blocks, { onboarding: onboarding() })).toEqual([])
	})

	it('hides the onboarding block once onboarding is completed or dismissed', () => {
		expect(
			hiddenBlockIds(blocks, { onboarding: onboarding({ isCompleted: true }) }),
		).toEqual(['onboarding'])
		expect(
			hiddenBlockIds(blocks, { onboarding: onboarding({ isVisible: false }) }),
		).toEqual(['onboarding'])
	})

	it('hides nothing when the dashboard has no onboarding block', () => {
		const withoutOnboarding = removeBlock(defaultHomeConfig(), 'onboarding')
		expect(
			hiddenBlockIds(withoutOnboarding.blocks, { onboarding: null }),
		).toEqual([])
	})
})
