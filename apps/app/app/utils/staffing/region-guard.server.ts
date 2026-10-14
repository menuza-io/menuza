import {
	internalSummaryRequestSchema,
	staffSummarySchema,
	type StaffSummary,
} from '@repo/staffing'
import {
	requiresStaffConfirmation,
	staffConfirmationMatches,
} from './region-confirmation.ts'
import { postRegionalStaffInternal } from './regional-internal.server.ts'

/**
 * The region-switch guard. Changing an organization's data region wipes the old
 * regional database, which now holds staff records (names, pay, PINs, history).
 * Before the wipe the App asks the old region how much staff data it holds
 * (`/internal/staff/summary`, counts only), shows that to the admin, requires the
 * admin to type the organization's slug when there is anything to lose, and
 * offers a backup that goes from the old region straight to the admin's browser.
 * No staff record ever passes through the control plane.
 */

/** Counts for the organization's current region, or `null` when unknown. */
export async function fetchStaffSummary({
	organizationId,
	dataRegion,
}: {
	organizationId: string
	dataRegion: string
}): Promise<StaffSummary | null> {
	try {
		const response = await postRegionalStaffInternal({
			dataRegion,
			path: 'summary',
			body: internalSummaryRequestSchema.parse({ orgId: organizationId }),
			timeoutMs: 8_000,
		})
		if (!response.ok) return null
		const parsed = staffSummarySchema.safeParse(await response.json())
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export type RegionGuardDecision =
	| { allowed: true; summary: StaffSummary | null }
	| { allowed: false; summary: StaffSummary | null }

/** Decides whether a confirmed region switch may proceed. */
export function evaluateRegionGuard({
	summary,
	typedConfirmation,
	slug,
}: {
	summary: StaffSummary | null
	typedConfirmation: string | null | undefined
	slug: string
}): RegionGuardDecision {
	if (!requiresStaffConfirmation(summary)) return { allowed: true, summary }
	return {
		allowed: staffConfirmationMatches(typedConfirmation, slug),
		summary,
	}
}
