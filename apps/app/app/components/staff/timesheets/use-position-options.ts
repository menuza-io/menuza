import { useMemo } from 'react'
import { type Option } from '#app/components/staff/controls.tsx'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	staffDetailSchema,
	type StaffPositionRow,
} from '#app/utils/staffing/staff-types.ts'

/**
 * The positions a person currently holds at a scope, for the position
 * picker of a time card. Read from their roster profile (jobs are effective
 * dated; a job that has ended is not offered). `null` while it loads or when
 * the profile cannot be read, so the picker simply stays out of the way and the
 * server decides.
 */
export function usePositionOptions(
	staffId: string | null,
	scopeId: string,
	positions: readonly StaffPositionRow[],
	locale: string,
): { options: Option[] | null; loading: boolean } {
	const { client, ready } = useStaffClient('staff')
	const query = useStaffQuery(
		client,
		ready && staffId ? `/${encodeURIComponent(staffId)}` : null,
		staffDetailSchema,
	)
	const options = useMemo(() => {
		if (!query.data) return null
		const byId = new Map(positions.map((position) => [position.id, position]))
		const seen = new Set<string>()
		const out: Option[] = []
		for (const job of query.data.jobs) {
			if (job.scopeId !== scopeId || job.effectiveTo) continue
			if (seen.has(job.positionId)) continue
			seen.add(job.positionId)
			const position = byId.get(job.positionId)
			const name = position
				? locale.startsWith('ar')
					? (position.nameAr ?? position.name)
					: position.name
				: job.positionId
			out.push({ value: job.positionId, label: name })
		}
		return out
	}, [query.data, positions, scopeId, locale])
	return { options, loading: query.loading }
}
