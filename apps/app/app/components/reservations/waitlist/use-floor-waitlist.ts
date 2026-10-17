import { useCallback, useState } from 'react'
import { useWaitlist } from '#app/components/reservations/waitlist/use-waitlist.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	type WaitlistEntry,
	type WaitlistSeatConflict,
	type WaitlistSeatResolution,
} from '#app/utils/reservations/waitlist-api.ts'

export type FloorTableRef = { id: string; label: string }

export type WaitlistSeatOutcome =
	| { ok: true; entry: WaitlistEntry; table: FloorTableRef }
	| {
			ok: false
			message: string
			code: string | null
			conflict?: WaitlistSeatConflict | null
	  }

export type OverbookPrompt = {
	entry: WaitlistEntry
	table: FloorTableRef
	/** What the server found on the table and which resolutions it accepts. */
	conflict: WaitlistSeatConflict | null
}

/** How the host settled a taken table: trade places, move the occupant, or seat on top. */
export type SeatChoice =
	| { resolution: Exclude<WaitlistSeatResolution, 'overbook'> }
	| { resolution: 'overbook'; reason: string }

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
			choice?: SeatChoice,
		): Promise<WaitlistSeatOutcome> => {
			const result = await seat(entry, {
				tableIds: [table.id],
				...(choice?.resolution === 'overbook'
					? { overbook: true, overbookReason: choice.reason }
					: choice
						? { resolution: choice.resolution }
						: {}),
			})
			return result.ok
				? { ok: true, entry: result.value.entry, table }
				: {
						ok: false,
						message: result.message,
						code: result.code,
						conflict: result.conflict ?? null,
					}
		},
		[seat],
	)

	/**
	 * Always asks the server first: it knows whether the table is really taken
	 * and which of swap, move and overbook it will accept. `null` means the
	 * prompt opened (or the party is gone) and nothing was seated.
	 */
	const dropOnTable = useCallback(
		async (
			entryId: string,
			table: FloorTableRef,
		): Promise<WaitlistSeatOutcome | null> => {
			const entry = active.find((candidate) => candidate.id === entryId)
			if (!entry) return null
			const outcome = await seatAt(entry, table)
			if (!outcome.ok && outcome.code === 'table_occupied') {
				clearActionError()
				setPrompt({ entry, table, conflict: outcome.conflict ?? null })
				return null
			}
			return outcome
		},
		[active, clearActionError, seatAt],
	)

	const resolvePrompt = useCallback(
		async (choice: SeatChoice): Promise<WaitlistSeatOutcome | null> => {
			if (!prompt) return null
			const outcome = await seatAt(prompt.entry, prompt.table, {
				...choice,
				...(choice.resolution === 'overbook'
					? { reason: choice.reason.trim() || 'Waitlist overbook' }
					: {}),
			} as SeatChoice)
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
		resolvePrompt,
	}
}

export type FloorWaitlistController = ReturnType<typeof useFloorWaitlist>
