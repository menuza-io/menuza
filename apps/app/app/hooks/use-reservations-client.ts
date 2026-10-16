import { type ReservationsScope } from '@repo/reservations'
import { useContext, useMemo } from 'react'
import { ReservationsClientContext } from '#app/components/reservations/reservations-client-provider.tsx'
import {
	type ReservationsClientPool,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

export function useReservationsClientPool(): ReservationsClientPool {
	const pool = useContext(ReservationsClientContext)
	if (!pool) {
		throw new Error(
			'useReservationsClientPool must be used inside <ReservationsClientProvider>',
		)
	}
	return pool
}

export function useReservationsClient(
	scope: ReservationsScope,
	locationIds?: readonly string[] | null,
): ReservationsScopedClient {
	const pool = useReservationsClientPool()
	const locationKey =
		locationIds && locationIds.length > 0
			? [...locationIds].sort().join(',')
			: '*'
	return useMemo(
		() =>
			pool.forScope(
				scope,
				locationKey === '*' ? undefined : locationKey.split(','),
			),
		[pool, scope, locationKey],
	)
}
