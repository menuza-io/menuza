import { type ReactNode, useEffect, useMemo } from 'react'
import { StaffClientContext } from '#app/hooks/use-staff-client.ts'
import { createStaffClientPool } from '#app/utils/staffing/staff-client.ts'

/** Provides the cached staff token clients for one organization. */
export function StaffClientProvider({
	orgSlug,
	children,
}: {
	orgSlug: string
	children: ReactNode
}) {
	const pool = useMemo(() => createStaffClientPool(orgSlug), [orgSlug])
	// Drop tokens as soon as the Staff section unmounts.
	useEffect(() => () => pool.forgetAll(), [pool])
	return (
		<StaffClientContext.Provider value={pool}>
			{children}
		</StaffClientContext.Provider>
	)
}
