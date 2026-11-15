import { type OnboardingProgressData } from '@repo/common/onboarding'
import { type DashboardBlock } from './config.ts'

/** Onboarding is shown until the viewer completes or dismisses it. */
export function isOnboardingVisible(
	progress: OnboardingProgressData | null | undefined,
) {
	return Boolean(progress && progress.isVisible && !progress.isCompleted)
}

/**
 * Blocks that stay in the saved config but are not shown to the viewer, such
 * as onboarding after it was completed or dismissed.
 */
export function hiddenBlockIds(
	blocks: readonly DashboardBlock[],
	data: { onboarding: OnboardingProgressData | null; launch?: unknown },
): string[] {
	return blocks
		.filter(
			(block) =>
				block.type === 'onboarding' &&
				!data.launch &&
				!isOnboardingVisible(data.onboarding),
		)
		.map((block) => block.id)
}

/**
 * Built-in blocks this viewer may not see: Bookings today without
 * reservation access, Today without any of its tiles. They stay saved.
 */
export function inaccessibleBuiltInBlockIds(
	blocks: readonly DashboardBlock[],
	access: { bookingsToday: boolean; today: boolean },
): string[] {
	return blocks
		.filter(
			(block) =>
				(block.type === 'bookings-today' && !access.bookingsToday) ||
				(block.type === 'today' && !access.today),
		)
		.map((block) => block.id)
}
