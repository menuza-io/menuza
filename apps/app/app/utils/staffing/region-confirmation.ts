import { summaryHasStaffData, type StaffSummary } from '@repo/staffing'

/**
 * Pure rules for the region-switch guard, shared by the server action and the
 * dialog so both agree on when a typed confirmation is needed and what counts
 * as typing it.
 */

/**
 * Whether the switch needs the typed confirmation. An unknown summary counts
 * as "might hold staff data": the guard fails closed.
 */
export function requiresStaffConfirmation(summary: StaffSummary | null) {
	return summary === null || summaryHasStaffData(summary)
}

/** The admin must type the organization's slug (case and outer spaces ignored). */
export function staffConfirmationMatches(
	typed: string | null | undefined,
	slug: string,
) {
	if (!typed || !slug) return false
	return typed.trim().toLowerCase() === slug.trim().toLowerCase()
}
