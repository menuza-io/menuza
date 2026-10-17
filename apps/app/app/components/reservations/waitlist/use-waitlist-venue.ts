import { useCallback, useEffect, useState } from 'react'
import {
	fetchBookDayConditional,
	type LiveTableState,
} from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

export type WaitlistArea = { id: string; name: string }

/**
 * Areas and live table states for the waitlist screen. They are read once and
 * again on demand (when the Seat dialog opens), not polled: only the queue is
 * live there.
 */
export function useWaitlistVenue({
	client,
	locationId,
	enabled = true,
}: {
	client: ReservationsScopedClient
	locationId: string
	enabled?: boolean
}) {
	const [areas, setAreas] = useState<WaitlistArea[]>([])
	const [tableStates, setTableStates] = useState<LiveTableState[]>([])
	const [loading, setLoading] = useState(false)
	const [failed, setFailed] = useState(false)

	const reload = useCallback(async () => {
		if (!enabled || !locationId) return
		setLoading(true)
		try {
			const res = await fetchBookDayConditional(client, { locationId }, null)
			if (res.status === 200) {
				setAreas(
					res.data.areas.map((area) => ({ id: area.id, name: area.name })),
				)
				setTableStates(res.data.tableStates)
			}
			setFailed(false)
		} catch {
			setFailed(true)
		} finally {
			setLoading(false)
		}
	}, [client, enabled, locationId])

	useEffect(() => {
		void reload()
	}, [reload])

	return { areas, tableStates, loading, failed, reload }
}
