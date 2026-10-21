import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	type DayMoveNotice,
	type DayReservationView,
	transitionReservationStatus,
	undoReservationTransition,
} from '#app/utils/reservations/book-api.ts'
import { type HostAction } from '#app/utils/reservations/host-actions.ts'
import { hostErrorMessage } from '#app/utils/reservations/host-errors.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

export const UNDO_WINDOW_MS = 60_000

export type HostUndo = {
	reservationId: string
	guestName: string
	status: string
	undoToken: string | null
}

/**
 * Runs one-tap status changes from a host list and keeps the 60 second undo.
 * Versions are read from the latest feed at click time, errors become
 * translated copy, and the undo lapses with the day or location it belongs to.
 */
export function useHostTransitions({
	client,
	reservations,
	resetKey,
	onMutated,
	onFailed,
}: {
	client: ReservationsScopedClient
	reservations: readonly DayReservationView[]
	/** Changing this (date, location) drops the pending undo. */
	resetKey: string
	onMutated: (
		reservation?: DayReservationView,
		moveNotices?: DayMoveNotice[],
	) => void
	/** Called after a failure so the screen can reload the board. */
	onFailed?: () => void
}) {
	const { _ } = useLingui()
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [lastUndo, setLastUndo] = useState<HostUndo | null>(null)
	const reservationsRef = useRef(reservations)
	reservationsRef.current = reservations
	const tx = useCallback((d: MessageDescriptor) => _(d), [_])

	useEffect(() => {
		setLastUndo(null)
	}, [resetKey])
	useEffect(() => {
		if (!lastUndo) return
		const id = window.setTimeout(() => setLastUndo(null), UNDO_WINDOW_MS)
		return () => window.clearTimeout(id)
	}, [lastUndo])

	const versionOf = (id: string) =>
		reservationsRef.current.find((r) => r.id === id)?.version

	const run = useCallback(
		async (rsv: DayReservationView, action: HostAction, guestLabel: string) => {
			if (!action.to) return
			const to = action.to
			setBusyId(rsv.id)
			setError(null)
			try {
				const version = versionOf(rsv.id)
				const res = await transitionReservationStatus(client, rsv.id, {
					to,
					...(version ? { expectedVersion: version } : {}),
				})
				setLastUndo({
					reservationId: rsv.id,
					guestName: guestLabel,
					status: to,
					undoToken: res.undoToken,
				})
				onMutated(res.reservation, res.moveNotices)
			} catch (err) {
				setError(hostErrorMessage(err, tx, msg`Could not update the status.`))
				onFailed?.()
			} finally {
				setBusyId(null)
			}
		},
		[client, onFailed, onMutated, tx],
	)

	const undo = useCallback(async () => {
		if (!lastUndo) return
		setBusyId(lastUndo.reservationId)
		setError(null)
		try {
			const res = await undoReservationTransition(
				client,
				lastUndo.reservationId,
				lastUndo.undoToken,
				versionOf(lastUndo.reservationId),
			)
			setLastUndo(null)
			onMutated(res.reservation, [])
		} catch (err) {
			setError(hostErrorMessage(err, tx, msg`Could not undo.`))
			onFailed?.()
		} finally {
			setBusyId(null)
		}
	}, [client, lastUndo, onFailed, onMutated, tx])

	return {
		busyId,
		error,
		lastUndo,
		run,
		undo,
		clearError: () => setError(null),
	}
}
