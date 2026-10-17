import { useLingui } from '@lingui/react/macro'
import { useCallback, useMemo, useState } from 'react'
import {
	approveReservationRequest,
	type DayMoveNotice,
	type DayReservationView,
	declineReservationRequest,
} from '#app/utils/reservations/book-api.ts'
import {
	type DecidedRequest,
	selectPendingRequests,
} from '#app/utils/reservations/requests.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

export function useReservationRequests({
	client,
	locationId,
	reservations,
	onMutated,
}: {
	client: ReservationsScopedClient
	locationId: string
	reservations: readonly DayReservationView[]
	onMutated: (
		reservation?: DayReservationView,
		moveNotices?: DayMoveNotice[],
	) => void
}) {
	const { t } = useLingui()
	const [decided, setDecided] = useState<Map<string, DecidedRequest>>(
		() => new Map(),
	)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const pending = useMemo(
		() => selectPendingRequests(reservations, decided),
		[reservations, decided],
	)

	const decide = useCallback(
		async (
			request: DayReservationView,
			outcome: DecidedRequest['outcome'],
			reason?: string,
		) => {
			setBusyId(request.id)
			setError(null)
			try {
				const res =
					outcome === 'approved'
						? await approveReservationRequest(client, request.id, {
								locationId,
							})
						: await declineReservationRequest(client, request.id, {
								locationId,
								reason,
							})
				setDecided((prev) =>
					new Map(prev).set(request.id, {
						id: request.id,
						outcome,
						guestName: request.guestName,
						partySize: request.partySize,
						hhmm: request.hhmm,
					}),
				)
				onMutated(res.reservation, [])
				return true
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: outcome === 'approved'
							? t`Could not approve the request.`
							: t`Could not decline the request.`,
				)
				return false
			} finally {
				setBusyId(null)
			}
		},
		[client, locationId, onMutated, t],
	)

	const approve = useCallback(
		(request: DayReservationView) => decide(request, 'approved'),
		[decide],
	)
	const decline = useCallback(
		(request: DayReservationView, reason?: string) =>
			decide(request, 'declined', reason),
		[decide],
	)

	return {
		pending,
		decided: useMemo(() => [...decided.values()], [decided]),
		busyId,
		error,
		approve,
		decline,
	}
}
