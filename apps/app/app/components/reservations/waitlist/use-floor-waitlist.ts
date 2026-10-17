import { useCallback, useState } from 'react'
import { useWaitlist } from '#app/components/reservations/waitlist/use-waitlist.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { type WaitlistEntry } from '#app/utils/reservations/waitlist-api.ts'

export type FloorTableRef = { id: string; label: string }

export type WaitlistSeatOutcome =
	| { ok: true; entry: WaitlistEntry; table: FloorTableRef }
	| { ok: false; message: string; code: string | null }

export type OverbookPrompt = {
	entry: WaitlistEntry
	table: FloorTableRef
}

/**
 * Waitlist state for the floor plan: the live queue plus the drag, the
 * "table is taken" prompt and the Seat dialog, so floor.tsx stays small.
 */
export function useFloorWaitlist({
	client,
	locationId,
	enabled,
}: {
	client: ReservationsScopedClient
	locationId: string
	enabled: boolean
}) {
	const [draggingId, setDraggingId] = useState<string | null>(null)
	const [prompt, setPrompt] = useState<OverbookPrompt | null>(null)
	const [seatDialogId, setSeatDialogId] = useState<string | null>(null)

	const busyUi = draggingId !== null || prompt !== null || seatDialogId !== null
	const waitlist = useWaitlist({
		client,
		locationId,
		enabled,
		paused: busyUi,
	})

	const { seat, active, clearActionError } = waitlist

	const seatAt = useCallback(
		async (
			entry: WaitlistEntry,
			table: FloorTableRef,
			overbook?: { reason: string },
		): Promise<WaitlistSeatOutcome> => {
			const result = await seat(entry, {
				tableIds: [table.id],
				...(overbook
					? { overbook: true, overbookReason: overbook.reason }
					: {}),
			})
			return result.ok
				? { ok: true, entry: result.value.entry, table }
				: { ok: false, message: result.message, code: result.code }
		},
		[seat],
	)

	/** `null` means the prompt opened (or the party is gone) and nothing was sent. */
	const dropOnTable = useCallback(
		async (
			entryId: string,
			table: FloorTableRef,
			occupied: boolean,
		): Promise<WaitlistSeatOutcome | null> => {
			const entry = active.find((candidate) => candidate.id === entryId)
			if (!entry) return null
			if (occupied) {
				setPrompt({ entry, table })
				return null
			}
			const outcome = await seatAt(entry, table)
			if (!outcome.ok && outcome.code === 'table_occupied') {
				clearActionError()
				setPrompt({ entry, table })
				return null
			}
			return outcome
		},
		[active, clearActionError, seatAt],
	)

	const resolveOverbook = useCallback(
		async (reason: string): Promise<WaitlistSeatOutcome | null> => {
			if (!prompt) return null
			const outcome = await seatAt(prompt.entry, prompt.table, {
				reason: reason.trim() || 'Waitlist overbook',
			})
			if (outcome.ok) setPrompt(null)
			return outcome
		},
		[prompt, seatAt],
	)

	return {
		waitlist,
		draggingId,
		setDraggingId,
		prompt,
		cancelPrompt: () => setPrompt(null),
		seatDialogId,
		setSeatDialogId,
		/** True while a drag, prompt or dialog needs the floor poll to hold still. */
		busyUi,
		seatAt,
		dropOnTable,
		resolveOverbook,
	}
}

export type FloorWaitlistController = ReturnType<typeof useFloorWaitlist>
