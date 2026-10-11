/**
 * Organization-level `ConfigFlag` keys for the staffing vertical. An absent flag
 * means off; `staffing.enabled` must be on before any area flag is honored.
 */
export const STAFFING_FLAGS = {
	enabled: 'staffing.enabled',
	scheduling: 'staffing.scheduling',
	timeclock: 'staffing.timeclock',
	pay: 'staffing.pay',
	hiring: 'staffing.hiring',
	onboarding: 'staffing.onboarding',
} as const

export type StaffingFlagName = keyof typeof STAFFING_FLAGS

/** Admin stores booleans, numbers, strings, or dates; only explicit truthy values count. */
export function isFlagOn(value: unknown): boolean {
	if (value === true || value === 1) return true
	if (typeof value === 'string') {
		return ['true', 'on', '1', 'yes'].includes(value.trim().toLowerCase())
	}
	return false
}

export type StaffingFlags = Record<StaffingFlagName, boolean>

/** Area flags never enable anything while the master switch is off. */
export function resolveStaffingFlags(
	raw: Partial<Record<StaffingFlagName, unknown>>,
): StaffingFlags {
	const enabled = isFlagOn(raw.enabled)
	return {
		enabled,
		scheduling: enabled && isFlagOn(raw.scheduling),
		timeclock: enabled && isFlagOn(raw.timeclock),
		pay: enabled && isFlagOn(raw.pay),
		hiring: enabled && isFlagOn(raw.hiring),
		onboarding: enabled && isFlagOn(raw.onboarding),
	}
}
