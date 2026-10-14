/**
 * Org-level feature flag keys for the Staff module. Flags are read with
 * `getFeatureFlag` (organization level). An absent flag means off, and only the
 * literal boolean `true` turns a feature on.
 */
export const STAFFING_FLAG_KEYS = {
	enabled: 'staffing.enabled',
	timeclock: 'staffing.timeclock',
	scheduling: 'staffing.scheduling',
	labor: 'staffing.labor',
	hiring: 'staffing.hiring',
} as const

export type StaffingFeature = keyof typeof STAFFING_FLAG_KEYS
export type StaffingFlagKey =
	(typeof STAFFING_FLAG_KEYS)[keyof typeof STAFFING_FLAG_KEYS]

/** Every feature other than the master switch. */
export type StaffingChildFeature = Exclude<StaffingFeature, 'enabled'>

export const STAFFING_CHILD_FEATURES = [
	'timeclock',
	'scheduling',
	'labor',
	'hiring',
] as const satisfies readonly StaffingChildFeature[]

/**
 * A flag value only counts as on when it is exactly `true`. Flag values are
 * stored as JSON, so a stray string such as "false" or a number must never
 * enable a feature by being truthy.
 */
export function isFlagOn(value: unknown): boolean {
	return value === true
}
