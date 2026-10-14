import { useContext, useMemo } from 'react'
import {
	StaffClientContext,
	useStaffQuery,
} from '#app/hooks/use-staff-client.ts'
import {
	summarySchema,
	type OnboardingSummaryRow,
} from '#app/utils/staffing/onboarding-types.ts'

/**
 * Onboarding progress for the roster: one small request for every person who
 * has a checklist (counts and an earliest due date, no task text). It runs only
 * when `staffing.hiring` is on and the member can read hiring, so an
 * organization without the feature never asks for a hiring token.
 */
export function useOnboardingSummary(enabled: boolean) {
	const pool = useContext(StaffClientContext)
	if (!pool) {
		throw new Error('useOnboardingSummary must be used inside the Staff layout')
	}
	const client = useMemo(() => pool.get('hiring'), [pool])
	const query = useStaffQuery(
		client,
		enabled ? '/onboarding/summary' : null,
		summarySchema,
	)
	const byStaff = useMemo(
		() =>
			new Map<string, OnboardingSummaryRow>(
				(query.data?.entries ?? []).map((entry) => [entry.staffId, entry]),
			),
		[query.data],
	)
	return { byStaff, reload: query.reload }
}
