import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useReservationsPoll } from '#app/hooks/use-reservations-poll.ts'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	addWaitlistEntry,
	type AddWaitlistEntryInput,
	fetchWaitlist,
	notifyWaitlistEntry,
	reorderWaitlist,
	seatWaitlistEntry,
	type SeatWaitlistInput,
	setWaitlistEntryStatus,
	updateWaitlistEntry,
	type UpdateWaitlistEntryPatch,
	type WaitlistEntry,
	type WaitlistListing,
	type WaitlistSeatConflict,
	waitlistSeatConflictOf,
	type WaitlistStatusTarget,
	waitlistListingSignature,
} from '#app/utils/reservations/waitlist-api.ts'
import {
	waitlistErrorInfo,
	waitlistErrorMessage,
} from '#app/utils/reservations/waitlist-errors.ts'
import {
	applyOrder,
	sameOrder,
	splitWaitlist,
	WAITLIST_STATUS_LABELS,
} from '#app/utils/reservations/waitlist-view.ts'

export type WaitlistActionResult<T = undefined> =
	| { ok: true; value: T }
	| {
			ok: false
			message: string
			stale: boolean
			code: string | null
			conflict?: WaitlistSeatConflict | null
	  }

const FALLBACKS = {
	add: msg`Could not add this party to the waitlist.`,
	update: msg`Could not save the changes.`,
	notify: msg`Could not send the table-ready message.`,
	status: msg`Could not change the status.`,
	seat: msg`Could not seat this party.`,
	reorder: msg`Could not save the new order. The list has been reloaded.`,
}

export function useWaitlist({
	client,
	locationId,
	date,
	enabled = true,
	paused = false,
	intervalMs = 5_000,
}: {
	client: ReservationsScopedClient
	locationId: string
	date?: string
	enabled?: boolean
	/** True while a drag or a dialog is open, so a poll never swaps the list underneath it. */
	paused?: boolean
	intervalMs?: number
}) {
	const { t, i18n } = useLingui()
	const translate = useCallback(
		(descriptor: MessageDescriptor) => i18n._(descriptor),
		[i18n],
	)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [reordering, setReordering] = useState(false)
	const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [announcement, setAnnouncement] = useState('')
	const [clockOffsetMs, setClockOffsetMs] = useState(0)
	const signatureRef = useRef<{ key: string; signature: string } | null>(null)

	const pollKey = `${locationId}:${date ?? 'today'}`

	// The list route has no ETag, so an unchanged answer is turned into a 304
	// here. That keeps the data reference stable and open menus un-reset.
	const fetcher = useCallback(
		async (etag: string | null, signal: AbortSignal) => {
			const result = await fetchWaitlist(
				client,
				{ locationId, date },
				etag,
				signal,
			)
			if (result.status === 304) return result
			const offset = result.data.now - Date.now()
			setClockOffsetMs((prev) =>
				Math.abs(prev - offset) < 2_000 ? prev : offset,
			)
			const signature = waitlistListingSignature(result.data)
			if (
				signatureRef.current?.key === pollKey &&
				signatureRef.current.signature === signature
			) {
				return { status: 304 as const, etag: result.etag }
			}
			signatureRef.current = { key: pollKey, signature }
			return result
		},
		[client, date, locationId, pollKey],
	)

	const poll = useReservationsPoll<WaitlistListing>({
		key: pollKey,
		fetcher,
		intervalMs,
		paused: paused || reordering || busyId !== null,
		enabled: enabled && Boolean(locationId),
	})

	const listing = poll.data
	const { active, settled } = useMemo(
		() => splitWaitlist(listing?.entries ?? []),
		[listing?.entries],
	)
	const orderedActive = useMemo(
		() => applyOrder(active, pendingOrder),
		[active, pendingOrder],
	)

	const refresh = poll.refresh
	const setOptimisticData = poll.setOptimisticData
	const reload = useCallback(async () => {
		signatureRef.current = null
		await refresh({ force: true })
	}, [refresh])

	const run = useCallback(
		async <T>(
			id: string | null,
			fallback: (typeof FALLBACKS)[keyof typeof FALLBACKS],
			action: () => Promise<T>,
			announce: (value: T) => string | null,
		): Promise<WaitlistActionResult<T>> => {
			setBusyId(id)
			setActionError(null)
			try {
				const value = await action()
				await reload()
				const spoken = announce(value)
				if (spoken) setAnnouncement(spoken)
				return { ok: true, value }
			} catch (err) {
				const message = waitlistErrorMessage(err, translate, fallback)
				const info = waitlistErrorInfo(err)
				setActionError(message)
				setAnnouncement(message)
				if (info.status === 409 || info.status === 404) await reload()
				return {
					ok: false,
					message,
					stale: info.stale,
					code: info.code,
					conflict: waitlistSeatConflictOf(err),
				}
			} finally {
				setBusyId(null)
			}
		},
		[reload, translate],
	)

	const add = useCallback(
		(
			input: Omit<AddWaitlistEntryInput, 'locationId'>,
			idempotencyKey?: string,
		) =>
			run(
				null,
				FALLBACKS.add,
				() =>
					addWaitlistEntry(client, { ...input, locationId }, idempotencyKey),
				(entry) => t`${entry.displayName} was added to the waitlist.`,
			),
		[client, locationId, run, t],
	)

	const update = useCallback(
		(
			entry: WaitlistEntry,
			patch: Omit<UpdateWaitlistEntryPatch, 'expectedVersion'>,
		) =>
			run(
				entry.id,
				FALLBACKS.update,
				() =>
					updateWaitlistEntry(client, entry.id, {
						expectedVersion: entry.version,
						...patch,
					}),
				(saved) => t`Saved changes for ${saved.displayName}.`,
			),
		[client, run, t],
	)

	const notify = useCallback(
		(entry: WaitlistEntry) =>
			run(
				entry.id,
				FALLBACKS.notify,
				() => notifyWaitlistEntry(client, entry.id, entry.version),
				({ entry: saved, changed }) => {
					const minutes = listing?.waitlistResponseMin ?? 0
					return changed
						? t`Notified ${saved.displayName}. They have ${minutes} min to answer.`
						: t`${saved.displayName} was already notified.`
				},
			),
		[client, listing?.waitlistResponseMin, run, t],
	)

	const setStatus = useCallback(
		(entry: WaitlistEntry, status: WaitlistStatusTarget) =>
			run(
				entry.id,
				FALLBACKS.status,
				() => setWaitlistEntryStatus(client, entry.id, status, entry.version),
				({ entry: saved }) => {
					const label = translate(WAITLIST_STATUS_LABELS[saved.status]!)
					return t`${saved.displayName} is now ${label}.`
				},
			),
		[client, run, t, translate],
	)

	const seat = useCallback(
		(entry: WaitlistEntry, input: Omit<SeatWaitlistInput, 'expectedVersion'>) =>
			run<{ entry: WaitlistEntry; reservation: DayReservationView | null }>(
				entry.id,
				FALLBACKS.seat,
				() =>
					seatWaitlistEntry(client, entry.id, {
						...input,
						expectedVersion: entry.version,
					}),
				({ entry: saved }) => t`Seated ${saved.displayName}.`,
			),
		[client, run, t],
	)

	const reorder = useCallback(
		async (
			ids: string[],
			movedId: string,
		): Promise<WaitlistActionResult<undefined>> => {
			const current = orderedActive.map((entry) => entry.id)
			if (sameOrder(ids, current)) return { ok: true, value: undefined }
			setPendingOrder(ids)
			setReordering(true)
			setActionError(null)
			try {
				const next = await reorderWaitlist(client, { locationId, date, ids })
				signatureRef.current = {
					key: pollKey,
					signature: waitlistListingSignature(next),
				}
				setOptimisticData(next)
				const moved = next.entries.find((entry) => entry.id === movedId)
				const total = next.counts.active
				if (moved?.position) {
					const position = moved.position
					setAnnouncement(
						t`${moved.displayName} moved to position ${position} of ${total}.`,
					)
				}
				return { ok: true, value: undefined }
			} catch (err) {
				const message = waitlistErrorMessage(err, translate, FALLBACKS.reorder)
				setActionError(message)
				setAnnouncement(message)
				await reload()
				const info = waitlistErrorInfo(err)
				return { ok: false, message, stale: info.stale, code: info.code }
			} finally {
				setPendingOrder(null)
				setReordering(false)
			}
		},
		[
			client,
			date,
			locationId,
			orderedActive,
			pollKey,
			reload,
			setOptimisticData,
			t,
			translate,
		],
	)

	return {
		listing,
		active: orderedActive,
		settled,
		loading: poll.loading,
		refreshing: poll.refreshing,
		loadError: poll.error,
		actionError,
		clearActionError: () => setActionError(null),
		announcement,
		announce: setAnnouncement,
		busyId,
		reordering,
		/** Add to the server clock to get "now" as the server sees it. */
		clockOffsetMs,
		refresh: reload,
		add,
		update,
		notify,
		setStatus,
		seat,
		reorder,
	}
}

export type WaitlistController = ReturnType<typeof useWaitlist>
