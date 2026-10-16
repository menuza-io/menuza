import { createContext, type ReactNode, useEffect, useMemo } from 'react'
import {
	createReservationsClientPool,
	type ReservationsClientPool,
} from '#app/utils/reservations/reservations-client.ts'

export const ReservationsClientContext =
	createContext<ReservationsClientPool | null>(null)

export function ReservationsClientProvider({
	orgSlug,
	children,
}: {
	orgSlug: string
	children: ReactNode
}) {
	const pool = useMemo(
		() => createReservationsClientPool({ orgSlug }),
		[orgSlug],
	)

	useEffect(() => {
		return () => {
			pool.invalidateAll()
		}
	}, [pool])

	return (
		<ReservationsClientContext.Provider value={pool}>
			{children}
		</ReservationsClientContext.Provider>
	)
}
