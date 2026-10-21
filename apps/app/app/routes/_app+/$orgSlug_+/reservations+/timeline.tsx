import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { formatHhmm, RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import {
	ATTENTION_RING,
	reservationStatusStyle,
} from '#app/components/reservations/status-style.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	assignReservationTable,
	type DayReservationView,
	updateReservation,
} from '#app/utils/reservations/book-api.ts'
import { tablesCountLabel } from '#app/utils/reservations/count-labels.ts'
import {
	hostErrorMessage,
	hostLoadErrorMessage,
} from '#app/utils/reservations/host-errors.ts'
import { ReservationsApiError } from '#app/utils/reservations/reservations-client.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { trackPointerDrag } from '#app/utils/reservations/pointer-drag.ts'
import { barKeyAction } from '#app/utils/reservations/timeline-keys.ts'
import {
	pickTimelineFocusMin,
	pickTimelineScrollLeft,
} from '#app/utils/reservations/timeline-scroll.ts'
import { type Route } from './+types/timeline.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.book,
	)
	const impersonated = await isImpersonating(request)
	return {
		orgSlug: access.organizationSlug,
		canManage:
			!impersonated &&
			access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION),
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION],
	})
	return { ok: true }
}

/** Sent to the server when the host gives no reason; the server stores it as data. */
const OVERBOOK_REASON_FALLBACK = 'Host stand manual override'

const SLOT_STEP_MIN = 15
const SLOT_WIDTH_PX = 52

type KeyboardGrabState = {
	reservationId: string
	guestName: string
	partySize: number
	tableId: string | null
	localStartMin: number
	durationMin: number
}

export default function ReservationsTimelineRoute() {
	const { t, i18n } = useLingui()
	const tx = (d: MessageDescriptor) => i18n._(d)
	const { orgSlug, canManage } = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]
	const locationId = activeLocation?.id ?? ''

	const [draggingRsvId, setDraggingRsvId] = useState<string | null>(null)
	const [resizingState, setResizingState] = useState<{
		rsv: DayReservationView
		startX: number
		initialDurationMin: number
		previewDurationMin: number
	} | null>(null)
	const [kbGrab, setKbGrab] = useState<KeyboardGrabState | null>(null)
	const [ariaAnnouncement, setAriaAnnouncement] = useState<string>('')
	const [mutationError, setMutationError] = useState<string | null>(null)
	const [allowOverbookDrop, setAllowOverbookDrop] = useState<boolean>(false)
	const [overbookReasonInput, setOverbookReasonInput] = useState<string>('')

	// VAL-HOST-003: Assign vs Assign & Lock choice banner after dropping unassigned reservation
	const [assignLockChoice, setAssignLockChoice] = useState<{
		reservation: DayReservationView
		tableId: string
		tableLabel: string
		localStartMin: number
		durationMin: number
	} | null>(null)

	// VAL-HOST-004: Prompt "Unlock and move?" when dragging a locked reservation
	const [pendingLockedMove, setPendingLockedMove] = useState<{
		reservation: DayReservationView
		targetTableId: string | null
		targetStartMin: number
		targetDurationMin: number
	} | null>(null)

	// VAL-HOST-005: Conflict / Overbook confirmation prompt with reason
	const [pendingConflictMove, setPendingConflictMove] = useState<{
		reservation: DayReservationView
		targetTableId: string | null
		targetStartMin: number
		targetDurationMin: number
		message: string
	} | null>(null)

	const isInteractionActive = Boolean(draggingRsvId || resizingState || kbGrab)

	const host = useHostStand({
		orgSlug,
		locationId,
		defaultTimeZone: activeLocation?.timezone ?? 'UTC',
		pollIntervalMs: 10_000,
		paused: isInteractionActive,
	})

	const dayFeed = host.dayFeed
	const services = useMemo(() => dayFeed?.services ?? [], [dayFeed?.services])
	const areas = useMemo(
		() =>
			(dayFeed?.areas ?? []).filter(
				(a) =>
					a.isActive && (!host.selectedAreaId || a.id === host.selectedAreaId),
			),
		[dayFeed?.areas, host.selectedAreaId],
	)
	const tables = useMemo(
		() =>
			(dayFeed?.tables ?? []).filter(
				(tbl) =>
					tbl.isActive &&
					(!host.selectedAreaId || tbl.areaId === host.selectedAreaId),
			),
		[dayFeed?.tables, host.selectedAreaId],
	)

	const activeReservations = useMemo(
		() =>
			(dayFeed?.reservations ?? []).filter(
				(r) =>
					!['cancelled', 'no_show', 'declined', 'expired'].includes(r.status),
			),
		[dayFeed?.reservations],
	)

	// Compute visible time range [gridStartMin, gridEndMin) in 15-min steps
	const { gridStartMin, gridEndMin, slots } = useMemo(() => {
		let minStart = 17 * 60 // default 17:00
		let maxEnd = 23 * 60 // default 23:00
		const filteredServices = host.selectedServiceId
			? services.filter((s) => s.id === host.selectedServiceId)
			: services
		if (filteredServices.length > 0) {
			minStart = Math.min(
				...filteredServices.map((s) => s.startMin ?? s.firstSeatingMin ?? 0),
			)
			maxEnd = Math.max(
				...filteredServices.map((s) => {
					const st = s.startMin ?? s.firstSeatingMin ?? 0
					return s.endMin <= st ? s.endMin + 1440 : s.endMin
				}),
			)
		}
		for (const rsv of activeReservations) {
			if (rsv.localStartMin < minStart) minStart = rsv.localStartMin
			if (rsv.localEndMin > maxEnd) maxEnd = rsv.localEndMin
		}
		const snappedStart = Math.max(
			0,
			Math.floor(minStart / SLOT_STEP_MIN) * SLOT_STEP_MIN,
		)
		const snappedEnd = Math.min(
			2880,
			Math.max(
				snappedStart + 180,
				Math.ceil(maxEnd / SLOT_STEP_MIN) * SLOT_STEP_MIN,
			),
		)
		const slotList: number[] = []
		for (let m = snappedStart; m < snappedEnd; m += SLOT_STEP_MIN) {
			slotList.push(m)
		}
		return {
			gridStartMin: snappedStart,
			gridEndMin: snappedEnd,
			slots: slotList,
		}
	}, [activeReservations, host.selectedServiceId, services])

	const totalGridWidthPx = slots.length * SLOT_WIDTH_PX

	// Per-slot cover count and pacing cap for header bar (VAL-HOST-002)
	const slotCoversMap = useMemo(() => {
		const map = new Map<number, number>()
		for (const rsv of activeReservations) {
			const bucket =
				Math.floor(rsv.localStartMin / SLOT_STEP_MIN) * SLOT_STEP_MIN
			map.set(bucket, (map.get(bucket) ?? 0) + rsv.partySize)
		}
		return map
	}, [activeReservations])

	const slotPacingMap = useMemo(() => {
		const map = new Map<
			number,
			{ covers: number; maxCovers: number | null; isOverPaced: boolean }
		>()
		for (const p of dayFeed?.pacing ?? []) {
			map.set(p.localStartMin, {
				covers: p.covers,
				maxCovers: p.maxCovers,
				isOverPaced: p.isOverPaced,
			})
		}
		return map
	}, [dayFeed?.pacing])

	const commitMoveOrResize = useCallback(
		async ({
			reservation,
			targetTableId,
			targetStartMin,
			targetDurationMin,
			lockAssignment,
			unlockConfirmed = false,
			forceOverbook = allowOverbookDrop,
			overbookReason,
			fromUnassignedDrop = false,
		}: {
			reservation: DayReservationView
			targetTableId: string | null
			targetStartMin: number
			targetDurationMin: number
			lockAssignment?: boolean
			unlockConfirmed?: boolean
			forceOverbook?: boolean
			overbookReason?: string
			fromUnassignedDrop?: boolean
		}) => {
			setMutationError(null)
			const currentTableId = reservation.assignedTableIds[0] ?? null
			const tableChanged =
				targetTableId !== null && targetTableId !== currentTableId
			const timeChanged = targetStartMin !== reservation.localStartMin
			const durationChanged = targetDurationMin !== reservation.durationMin

			if (
				!tableChanged &&
				!timeChanged &&
				!durationChanged &&
				lockAssignment === undefined
			) {
				return
			}

			// VAL-HOST-004: Locked reservation bar prompts "Unlock and move?" before mutating
			if (
				reservation.locked &&
				!unlockConfirmed &&
				lockAssignment === undefined
			) {
				setPendingLockedMove({
					reservation,
					targetTableId,
					targetStartMin,
					targetDurationMin,
				})
				const lockedGuestName = reservation.guestName
				setAriaAnnouncement(
					t`${lockedGuestName} is locked to its table. Confirm Unlock and move to proceed.`,
				)
				return
			}

			try {
				if (
					(tableChanged || lockAssignment !== undefined) &&
					targetTableId &&
					!timeChanged &&
					!durationChanged
				) {
					const res = await assignReservationTable(
						host.client,
						reservation.id,
						{
							tableIds: [targetTableId],
							locked: lockAssignment ?? false,
							unlock: unlockConfirmed || reservation.locked,
							forceOverbook,
							overbookReason: forceOverbook
								? (overbookReason ??
									(overbookReasonInput.trim() || OVERBOOK_REASON_FALLBACK))
								: null,
							reflowLaterParties: true,
							expectedVersion: reservation.version,
						},
					)
					const tblLabel =
						tables.find((tbl) => tbl.id === targetTableId)?.label ??
						targetTableId
					const assignedGuestName = reservation.guestName
					const assignedPartySize = reservation.partySize
					const assignedTime = formatHhmm(targetStartMin)
					setAriaAnnouncement(
						t`Assigned ${assignedGuestName} (${assignedPartySize}) to ${tblLabel} at ${assignedTime} (${targetDurationMin}m)`,
					)
					host.handleReservationMutated(res.reservation, res.moveNotices)
					if (fromUnassignedDrop) {
						setAssignLockChoice({
							reservation: res.reservation,
							tableId: targetTableId,
							tableLabel: tblLabel,
							localStartMin: targetStartMin,
							durationMin: targetDurationMin,
						})
					}
				} else {
					const res = await updateReservation(host.client, reservation.id, {
						localStartMin: targetStartMin,
						durationMin: targetDurationMin,
						...(targetTableId ? { tableIds: [targetTableId] } : {}),
						...(lockAssignment !== undefined ? { locked: lockAssignment } : {}),
						unlock: unlockConfirmed || reservation.locked,
						forceOverbook,
						overbookReason: forceOverbook
							? (overbookReason ??
								(overbookReasonInput.trim() || OVERBOOK_REASON_FALLBACK))
							: null,
						reflowLaterParties: true,
						expectedVersion: reservation.version,
					})
					const tblLabel =
						tables.find((tbl) => tbl.id === (targetTableId ?? currentTableId))
							?.label ?? t`Unassigned`
					const updatedGuestName = reservation.guestName
					const updatedTime = formatHhmm(targetStartMin)
					setAriaAnnouncement(
						t`Updated ${updatedGuestName} on ${tblLabel} to ${updatedTime} (${targetDurationMin}m)`,
					)
					host.handleReservationMutated(res.reservation, res.moveNotices)
					if (fromUnassignedDrop && targetTableId) {
						setAssignLockChoice({
							reservation: res.reservation,
							tableId: targetTableId,
							tableLabel: tblLabel,
							localStartMin: targetStartMin,
							durationMin: targetDurationMin,
						})
					}
				}
			} catch (err) {
				if (err instanceof ReservationsApiError && err.status === 409) {
					const bodyObj =
						err.body && typeof err.body === 'object'
							? (err.body as Record<string, unknown>)
							: {}
					const errCode = typeof bodyObj.error === 'string' ? bodyObj.error : ''
					if (errCode === 'VERSION_CONFLICT') {
						// VAL-HOST-010: Version mismatch snaps back, shows banner, and refreshes day feed
						const staleMessage = t`Another host modified this reservation. The timeline has been refreshed.`
						setMutationError(staleMessage)
						setAriaAnnouncement(staleMessage)
						void host.poll.refresh({ force: true })
						return
					}
					// VAL-HOST-005: Offer overbook with reason or alternative table when slot conflicts
					setPendingConflictMove({
						reservation,
						targetTableId,
						targetStartMin,
						targetDurationMin,
						message: hostErrorMessage(
							err,
							tx,
							msg`That placement conflicts with another booking.`,
						),
					})
					const conflictMessage = hostErrorMessage(
						err,
						tx,
						msg`That placement conflicts with another booking.`,
					)
					setAriaAnnouncement(t`Conflict detected: ${conflictMessage}`)
					return
				}
				const failMessage = hostErrorMessage(
					err,
					tx,
					msg`Could not move the reservation.`,
				)
				setMutationError(failMessage)
				setAriaAnnouncement(t`Move failed: ${failMessage}`)
			}
		},
		[allowOverbookDrop, host, i18n, overbookReasonInput, t, tables],
	)

	const handleBarKeyDown = async (
		e: React.KeyboardEvent,
		rsv: DayReservationView,
	) => {
		const action = barKeyAction({
			key: e.key,
			grabbed: kbGrab?.reservationId === rsv.id,
			canManage,
			onBar: e.target === e.currentTarget,
		})
		if (action === 'ignore') return
		if (action === 'open') {
			e.preventDefault()
			e.stopPropagation()
			host.openDetail(rsv.id)
			return
		}
		if (!canManage) return

		// Pick up (Space or M) or drop (Enter or Space)
		if (action === 'grab' || action === 'drop') {
			e.preventDefault()
			e.stopPropagation()
			if (kbGrab && kbGrab.reservationId === rsv.id) {
				const grab = kbGrab
				setKbGrab(null)
				await commitMoveOrResize({
					reservation: rsv,
					targetTableId: grab.tableId,
					targetStartMin: grab.localStartMin,
					targetDurationMin: grab.durationMin,
				})
			} else {
				const initialGrab: KeyboardGrabState = {
					reservationId: rsv.id,
					guestName: rsv.guestName,
					partySize: rsv.partySize,
					tableId: rsv.assignedTableIds[0] ?? tables[0]?.id ?? null,
					localStartMin: rsv.localStartMin,
					durationMin: rsv.durationMin,
				}
				setKbGrab(initialGrab)
				const grabbedGuestName = rsv.guestName
				const grabbedPartySize = rsv.partySize
				const grabbedTime = rsv.hhmm
				setAriaAnnouncement(
					t`Grabbed ${grabbedGuestName} (${grabbedPartySize}) at ${grabbedTime}. Use arrow keys to change time or table, Shift+Left/Right to resize duration, Enter to drop, Escape to cancel.`,
				)
			}
			return
		}

		if (e.key === 'Escape' && kbGrab?.reservationId === rsv.id) {
			e.preventDefault()
			e.stopPropagation()
			setKbGrab(null)
			const cancelledGuestName = rsv.guestName
			setAriaAnnouncement(t`Cancelled moving ${cancelledGuestName}.`)
			return
		}

		if (!kbGrab || kbGrab.reservationId !== rsv.id) return

		if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
			e.preventDefault()
			e.stopPropagation()
			const delta = e.key === 'ArrowRight' ? SLOT_STEP_MIN : -SLOT_STEP_MIN
			const nextDuration = Math.max(
				15,
				Math.min(360, kbGrab.durationMin + delta),
			)
			setKbGrab({ ...kbGrab, durationMin: nextDuration })
			const resizedGuestName = rsv.guestName
			setAriaAnnouncement(
				t`Duration ${nextDuration} minutes for ${resizedGuestName}`,
			)
			return
		}

		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault()
			e.stopPropagation()
			const delta = e.key === 'ArrowRight' ? SLOT_STEP_MIN : -SLOT_STEP_MIN
			const nextStart = Math.max(
				gridStartMin,
				Math.min(gridEndMin - SLOT_STEP_MIN, kbGrab.localStartMin + delta),
			)
			setKbGrab({ ...kbGrab, localStartMin: nextStart })
			const shiftedTime = formatHhmm(nextStart)
			const shiftedGuestName = rsv.guestName
			setAriaAnnouncement(t`Time ${shiftedTime} for ${shiftedGuestName}`)
			return
		}

		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			e.stopPropagation()
			if (tables.length === 0) return
			const curIdx = tables.findIndex((tbl) => tbl.id === kbGrab.tableId)
			const nextIdx =
				e.key === 'ArrowDown'
					? Math.min(tables.length - 1, curIdx + 1)
					: Math.max(0, curIdx - 1)
			const nextTable = tables[nextIdx]
			if (nextTable) {
				setKbGrab({ ...kbGrab, tableId: nextTable.id })
				const nextTableLabel = nextTable.label
				const nextTableMin = nextTable.minCovers
				const nextTableMax = nextTable.maxCovers
				const movedGuestName = rsv.guestName
				setAriaAnnouncement(
					t`Table ${nextTableLabel} (${nextTableMin}-${nextTableMax}) for ${movedGuestName}`,
				)
			}
		}
	}

	const handleDropOnCell = async (
		e: React.DragEvent,
		targetTableId: string,
		targetSlotMin: number,
	) => {
		e.preventDefault()
		const rsvId =
			e.dataTransfer.getData('text/plain') ||
			e.dataTransfer.getData('application/x-reservation-id') ||
			draggingRsvId
		setDraggingRsvId(null)
		if (!rsvId) return
		const rsv = activeReservations.find((r) => r.id === rsvId)
		if (!rsv) return
		const wasUnassigned = rsv.assignedTableIds.length === 0
		await commitMoveOrResize({
			reservation: rsv,
			targetTableId,
			targetStartMin: targetSlotMin,
			targetDurationMin: rsv.durationMin,
			fromUnassignedDrop: wasUnassigned,
		})
	}

	const handleResizeDelta = async (
		rsv: DayReservationView,
		deltaMin: number,
	) => {
		const nextDuration = Math.max(15, Math.min(360, rsv.durationMin + deltaMin))
		await commitMoveOrResize({
			reservation: rsv,
			targetTableId: rsv.assignedTableIds[0] ?? null,
			targetStartMin: rsv.localStartMin,
			targetDurationMin: nextDuration,
		})
	}

	const handleToggleLock = async (rsv: DayReservationView) => {
		const tableId = rsv.assignedTableIds[0] ?? null
		if (!tableId) return
		await commitMoveOrResize({
			reservation: rsv,
			targetTableId: tableId,
			targetStartMin: rsv.localStartMin,
			targetDurationMin: rsv.durationMin,
			lockAssignment: !rsv.locked,
			unlockConfirmed: true,
		})
	}

	// Window listeners of a resize in progress, removed on release, cancel or
	// when this screen goes away mid-drag.
	const resizeCleanupRef = useRef<(() => void) | null>(null)
	useEffect(() => () => resizeCleanupRef.current?.(), [])

	const startPointerResize = (
		e: React.PointerEvent,
		rsv: DayReservationView,
	) => {
		if (!canManage) return
		e.preventDefault()
		e.stopPropagation()
		const startX = e.clientX
		const initialDurationMin = rsv.durationMin
		setResizingState({
			rsv,
			startX,
			initialDurationMin,
			previewDurationMin: initialDurationMin,
		})

		const onPointerMove = (moveEvent: PointerEvent) => {
			const dx = moveEvent.clientX - startX
			const slotDelta = Math.round(dx / SLOT_WIDTH_PX)
			const nextDuration = Math.max(
				15,
				Math.min(360, initialDurationMin + slotDelta * SLOT_STEP_MIN),
			)
			setResizingState((prev) =>
				prev ? { ...prev, previewDurationMin: nextDuration } : null,
			)
		}

		resizeCleanupRef.current?.()
		const up = (upEvent: PointerEvent) => {
			resizeCleanupRef.current = null
			const dx = upEvent.clientX - startX
			const slotDelta = Math.round(dx / SLOT_WIDTH_PX)
			const nextDuration = Math.max(
				15,
				Math.min(360, initialDurationMin + slotDelta * SLOT_STEP_MIN),
			)
			setResizingState(null)
			if (nextDuration !== initialDurationMin) {
				void commitMoveOrResize({
					reservation: rsv,
					targetTableId: rsv.assignedTableIds[0] ?? null,
					targetStartMin: rsv.localStartMin,
					targetDurationMin: nextDuration,
				})
			}
		}
		// The system took the pointer (a touch turned into a scroll, a context
		// menu): abandon the resize, commit nothing.
		const cancel = () => {
			resizeCleanupRef.current = null
			setResizingState(null)
		}
		resizeCleanupRef.current = trackPointerDrag(window, {
			move: onPointerMove,
			up,
			cancel,
		})
	}

	const showNowLine =
		host.businessDate === host.todayDate &&
		host.liveNow.localStartMin >= gridStartMin &&
		host.liveNow.localStartMin <= gridEndMin
	const nowOffsetPx = showNowLine
		? ((host.liveNow.localStartMin - gridStartMin) / SLOT_STEP_MIN) *
			SLOT_WIDTH_PX
		: 0

	const unassignedReservations = dayFeed?.unassigned ?? []

	// Bring "now" (today) or the earliest booking (other days) into view when
	// the date, service or first data arrives; never fight the user afterwards.
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const autoScrolledKey = useRef<string | null>(null)
	const isToday = host.businessDate === host.todayDate
	const nowLocalMin = host.liveNow.localStartMin
	const earliestBookingMin = useMemo(
		() =>
			activeReservations.length
				? Math.min(...activeReservations.map((r) => r.localStartMin))
				: null,
		[activeReservations],
	)
	const hasData = Boolean(dayFeed) && slots.length > 0
	useEffect(() => {
		const node = scrollRef.current
		if (!node || !hasData) return
		const key = `${host.businessDate}|${host.selectedServiceId ?? ''}|${
			isToday ? 'now' : earliestBookingMin === null ? 'none' : 'booking'
		}`
		if (autoScrolledKey.current === key) return
		autoScrolledKey.current = key
		const left = pickTimelineScrollLeft({
			focusMin: pickTimelineFocusMin({
				isToday,
				nowLocalMin,
				bookingStartMins:
					earliestBookingMin === null ? [] : [earliestBookingMin],
			}),
			gridStartMin,
			gridEndMin,
			stepMin: SLOT_STEP_MIN,
			slotWidthPx: SLOT_WIDTH_PX,
			viewportWidthPx: node.clientWidth,
			labelWidthPx: 192,
		})
		node.scrollLeft = left
	}, [
		hasData,
		host.businessDate,
		host.selectedServiceId,
		isToday,
		nowLocalMin,
		earliestBookingMin,
		gridStartMin,
		gridEndMin,
	])

	return (
		<div
			className="flex max-w-full min-w-0 flex-col gap-4"
			data-testid="reservations-timeline-view"
		>
			{/* Screen-reader live region for keyboard DnD announcements */}
			<div
				aria-live="assertive"
				aria-atomic="true"
				className="sr-only"
				data-testid="timeline-aria-live"
			>
				{ariaAnnouncement}
			</div>

			<HostSubnav
				orgSlug={orgSlug}
				activeView="timeline"
				businessDate={host.businessDate}
				todayDate={host.todayDate}
				onDateChange={host.setDate}
				services={dayFeed?.services ?? []}
				selectedServiceId={host.selectedServiceId}
				onServiceChange={host.setServiceId}
				areas={dayFeed?.areas ?? []}
				selectedAreaId={host.selectedAreaId}
				onAreaChange={host.setAreaId}
				unassignedCount={unassignedReservations.length}
				conflictCount={dayFeed?.conflicts.length ?? 0}
				moveNoticeCount={host.allMoveNotices.length}
				onOpenBookingSheet={() => host.openBookingSheet()}
				onOpenWalkIn={() => host.openWalkIn()}
				onOpenConflictPanel={() => host.setConflictPanelOpen(true)}
				canManage={canManage}
				refreshing={host.poll.refreshing}
				onRefresh={() => void host.poll.refresh({ force: true })}
				lastUpdatedAt={host.poll.lastUpdatedAt}
				serviceNotes={dayFeed?.serviceNotes ?? []}
			/>

			{(host.poll.error && !dayFeed) || mutationError ? (
				<Alert variant="destructive" data-testid="timeline-error-banner">
					<AlertDescription>
						{mutationError ??
							hostLoadErrorMessage(
								{
									status: host.poll.errorStatus,
									code: host.poll.errorCode,
								},
								tx,
							)}
					</AlertDescription>
				</Alert>
			) : null}

			{/* VAL-HOST-003: Assign vs Assign & Lock banner after dropping an unassigned reservation */}
			{assignLockChoice ? (
				<div
					className="border-primary/30 bg-primary/10 text-foreground flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
					data-testid="timeline-assign-choice-banner"
				>
					<span>
						<Trans>
							Assigned {assignLockChoice.reservation.guestName} to{' '}
							{assignLockChoice.tableLabel}. Choose assignment lock mode:
						</Trans>
					</span>
					<div className="flex items-center gap-1.5">
						<Button
							type="button"
							size="sm"
							className="h-8 max-md:h-11 pointer-coarse:h-11"
							variant="outline"
							onClick={() => setAssignLockChoice(null)}
							data-testid="timeline-assign-unlocked-btn"
						>
							<Trans>Assign</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							className="h-8 max-md:h-11 pointer-coarse:h-11"
							onClick={async () => {
								const choice = assignLockChoice
								setAssignLockChoice(null)
								await commitMoveOrResize({
									reservation: choice.reservation,
									targetTableId: choice.tableId,
									targetStartMin: choice.localStartMin,
									targetDurationMin: choice.durationMin,
									lockAssignment: true,
									unlockConfirmed: true,
								})
							}}
							data-testid="timeline-assign-locked-btn"
						>
							<Icon name="lock" className="size-3.5" />
							<span>
								<Trans>Assign & Lock</Trans>
							</span>
						</Button>
					</div>
				</div>
			) : null}

			{/* VAL-HOST-004: Locked reservation move confirmation ("Unlock and move?") */}
			{pendingLockedMove ? (
				<div
					className="border-warning/40 bg-warning/12 text-foreground flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm"
					data-testid="timeline-unlock-move-prompt"
				>
					<div className="flex items-center gap-2 font-medium">
						<Icon name="lock" className="size-4" />
						<span>
							<Trans>
								{pendingLockedMove.reservation.guestName} is locked to its
								current table. Unlock and move?
							</Trans>
						</span>
					</div>
					<div className="flex items-center gap-1.5">
						<Button
							type="button"
							size="sm"
							className="h-8 max-md:h-11 pointer-coarse:h-11"
							variant="outline"
							onClick={() => setPendingLockedMove(null)}
							data-testid="timeline-cancel-unlock-move"
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							className="h-8 max-md:h-11 pointer-coarse:h-11"
							onClick={async () => {
								const pending = pendingLockedMove
								setPendingLockedMove(null)
								await commitMoveOrResize({
									reservation: pending.reservation,
									targetTableId: pending.targetTableId,
									targetStartMin: pending.targetStartMin,
									targetDurationMin: pending.targetDurationMin,
									unlockConfirmed: true,
								})
							}}
							data-testid="timeline-confirm-unlock-move"
						>
							<Trans>Unlock and move</Trans>
						</Button>
					</div>
				</div>
			) : null}

			{/* VAL-HOST-005: Conflict / Overbook confirmation with reason */}
			{pendingConflictMove ? (
				<div
					className="border-destructive/40 bg-destructive/10 text-foreground flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm"
					data-testid="timeline-overbook-prompt"
				>
					<div className="flex flex-col gap-1">
						<span className="font-semibold">
							<Trans>Slot conflict: {pendingConflictMove.message}</Trans>
						</span>
						<span>
							<Trans>
								Enter an overbook reason to force this placement or cancel.
							</Trans>
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						<Input
							type="text"
							value={overbookReasonInput}
							onChange={(e) => setOverbookReasonInput(e.target.value)}
							placeholder={t`Overbook reason...`}
							aria-label={t`Overbook reason`}
							className="w-56"
							data-testid="timeline-overbook-reason-input"
						/>
						<Button
							type="button"
							size="sm"
							className="h-8 max-md:h-11 pointer-coarse:h-11"
							variant="outline"
							onClick={() => setPendingConflictMove(null)}
							data-testid="timeline-cancel-overbook-btn"
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							className="h-8 max-md:h-11 pointer-coarse:h-11"
							variant="destructive"
							onClick={async () => {
								const pending = pendingConflictMove
								setPendingConflictMove(null)
								await commitMoveOrResize({
									reservation: pending.reservation,
									targetTableId: pending.targetTableId,
									targetStartMin: pending.targetStartMin,
									targetDurationMin: pending.targetDurationMin,
									unlockConfirmed: true,
									forceOverbook: true,
									overbookReason:
										overbookReasonInput.trim() || OVERBOOK_REASON_FALLBACK,
								})
							}}
							data-testid="timeline-confirm-overbook-btn"
						>
							<Trans>Confirm Overbook</Trans>
						</Button>
					</div>
				</div>
			) : null}

			{/* Timeline Toolbar & Keyboard / Overbook Controls */}
			<div className="bg-card flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
				<div className="flex flex-wrap items-center gap-3">
					<span className="text-muted-foreground">
						<Trans>Drag a bar to move it. Keyboard: Space or Enter.</Trans>
					</span>
					{isInteractionActive ? (
						<Badge variant="secondary" data-testid="timeline-poll-paused-badge">
							<Trans>Live polling paused while moving</Trans>
						</Badge>
					) : null}
				</div>

				{canManage ? (
					<label className="flex min-h-8 items-center gap-2 font-medium max-md:min-h-11 pointer-coarse:min-h-11">
						<Checkbox
							checked={allowOverbookDrop}
							onCheckedChange={(checked) =>
								setAllowOverbookDrop(Boolean(checked))
							}
							data-testid="timeline-allow-overbook"
						/>
						<span>
							<Trans>Allow overbook / tight table drop</Trans>
						</span>
					</label>
				) : null}
			</div>

			{/* Unassigned drag lane: shown only while something is unassigned */}
			{unassignedReservations.length > 0 ? (
				<Card
					className="flex flex-col gap-2 p-3"
					data-testid="timeline-unassigned-lane"
				>
					<div className="flex items-center justify-between text-sm font-semibold">
						<span>
							<Trans>Unassigned: drag onto a table row below</Trans>
						</span>
						<Badge
							variant={
								unassignedReservations.length > 0 ? 'destructive' : 'secondary'
							}
						>
							{unassignedReservations.length}
						</Badge>
					</div>
					{unassignedReservations.length === 0 ? (
						<div className="text-muted-foreground text-xs">
							<Trans>All active reservations are assigned to tables.</Trans>
						</div>
					) : (
						<div className="flex flex-wrap gap-2">
							{unassignedReservations.map((rsv) => (
								<div
									key={rsv.id}
									draggable={canManage}
									tabIndex={0}
									role="button"
									onDragStart={(e) => {
										setDraggingRsvId(rsv.id)
										e.dataTransfer.setData('text/plain', rsv.id)
										e.dataTransfer.setData(
											'application/x-reservation-id',
											rsv.id,
										)
									}}
									onDragEnd={() => setDraggingRsvId(null)}
									onKeyDown={(e) => void handleBarKeyDown(e, rsv)}
									onClick={() => host.openDetail(rsv.id)}
									className="bg-background hover:bg-muted border-warning/50 flex cursor-grab items-center gap-2 rounded-md border px-2.5 py-2 text-sm shadow-xs"
									data-testid={`timeline-unassigned-chip-${rsv.id}`}
								>
									<span className="font-mono font-semibold">{rsv.hhmm}</span>
									<span className="font-medium">{rsv.guestName}</span>
									<Badge variant="secondary">{rsv.partySize}</Badge>
								</div>
							))}
						</div>
					)}
				</Card>
			) : null}

			{!dayFeed && host.poll.loading ? (
				<Skeleton className="h-96 w-full" data-testid="timeline-skeleton" />
			) : null}

			{/* Main Horizontal Gantt / Timeline Grid */}
			<Card
				className="max-w-full min-w-0 overflow-hidden"
				data-testid="timeline-grid-container"
			>
				<div
					className="max-w-full min-w-0 overflow-x-auto"
					ref={scrollRef}
					data-testid="timeline-scroll"
				>
					<div
						className="relative min-w-max"
						dir="ltr"
						style={{ width: `${192 + totalGridWidthPx}px` }}
					>
						{/* Header Row: Time Slots & Covers Pacing */}
						<div className="bg-muted sticky top-0 z-40 flex border-b">
							<div className="bg-muted sticky start-0 z-30 flex w-48 shrink-0 items-center justify-between border-e px-3 py-2 text-xs font-semibold">
								<span>
									<Trans>Table</Trans>
								</span>
								<span className="text-muted-foreground">
									<Trans>Seats</Trans>
								</span>
							</div>

							<div
								className="relative flex"
								style={{ width: `${totalGridWidthPx}px` }}
								data-testid="timeline-pacing-strip"
							>
								{showNowLine ? (
									<div
										className="bg-primary pointer-events-none absolute top-0 bottom-0 z-10 w-0.5"
										style={{ left: `${nowOffsetPx}px` }}
										data-testid="timeline-now-label"
									>
										<span className="bg-primary text-primary-foreground rounded-b px-1 py-0.5 text-xs font-semibold">
											{host.liveNow.hhmm}
										</span>
									</div>
								) : null}
								{slots.map((slotMin) => {
									const isHour = slotMin % 60 === 0
									const pacingSlot = slotPacingMap.get(slotMin)
									const coversInSlot =
										pacingSlot?.covers ?? slotCoversMap.get(slotMin) ?? 0
									const maxCovers = pacingSlot?.maxCovers ?? null
									const isOverPaced =
										Boolean(pacingSlot?.isOverPaced) ||
										(maxCovers !== null && coversInSlot >= maxCovers)
									return (
										<div
											key={slotMin}
											style={{ width: `${SLOT_WIDTH_PX}px` }}
											className={`${
												isHour
													? 'flex shrink-0 flex-col justify-between border-e px-1 py-1.5 text-xs font-semibold'
													: 'text-muted-foreground flex shrink-0 flex-col justify-between border-e px-1 py-1.5 text-xs'
											} ${
												isOverPaced ? 'bg-destructive/10 text-destructive' : ''
											}`}
											data-testid={`timeline-header-slot-${slotMin}`}
											data-over-paced={isOverPaced ? 'true' : 'false'}
										>
											<span>{formatHhmm(slotMin)}</span>
											<span
												className={
													isOverPaced
														? 'text-destructive text-xs font-semibold tabular-nums'
														: coversInSlot > 0
															? 'text-foreground text-xs font-medium tabular-nums'
															: 'text-muted-foreground/60 text-xs tabular-nums'
												}
												data-testid={`timeline-pacing-slot-${slotMin}`}
												title={
													maxCovers !== null
														? t`Seats used / capacity: ${coversInSlot} / ${maxCovers}`
														: undefined
												}
												aria-label={
													maxCovers !== null
														? t`${coversInSlot} of ${maxCovers} seats used`
														: undefined
												}
											>
												{maxCovers !== null
													? `${coversInSlot}/${maxCovers}`
													: `${coversInSlot}p`}
											</span>
										</div>
									)
								})}
							</div>
						</div>

						{/* Live "Now" Cursor Line */}
						{showNowLine ? (
							<div
								className="bg-primary pointer-events-none absolute top-0 bottom-0 z-20 w-0.5"
								style={{ left: `${192 + nowOffsetPx}px` }}
								data-testid="timeline-now-line"
							/>
						) : null}

						{/* Area Groups & Table Rows */}
						{areas.map((area) => {
							const areaTables = tables.filter((tbl) => tbl.areaId === area.id)
							if (areaTables.length === 0) return null
							return (
								<div key={area.id} data-testid={`timeline-area-${area.id}`}>
									<div className="bg-muted/30 flex items-center border-b px-3 py-1 text-xs font-semibold">
										<span>{area.name}</span>
										<Badge variant="outline" className="ms-2">
											{tablesCountLabel(areaTables.length)}
										</Badge>
									</div>

									{areaTables.map((table) => {
										const rowReservations = activeReservations.filter((rsv) => {
											if (kbGrab && kbGrab.reservationId === rsv.id) {
												return kbGrab.tableId === table.id
											}
											return rsv.assignedTableIds.includes(table.id)
										})

										return (
											<div
												key={table.id}
												className="hover:bg-muted/10 flex border-b"
												data-testid={`timeline-row-${table.id}`}
												data-table-label={table.label}
											>
												{/* Sticky Left Table Cell */}
												<div className="bg-card sticky start-0 z-30 flex w-48 shrink-0 items-center justify-between border-e px-3 py-2 text-xs">
													<div className="flex items-center gap-1.5">
														<span className="font-semibold">{table.label}</span>
														<span className="text-muted-foreground text-xs">
															({table.minCovers}-{table.maxCovers})
														</span>
													</div>
													<Button
														type="button"
														size="icon"
														className="size-8 max-md:size-11 pointer-coarse:size-11"
														variant="ghost"
														aria-label={t`Book on ${table.label}`}
														onClick={() =>
															host.openBookingSheet({
																tableId: table.id,
																areaId: table.areaId,
															})
														}
														data-testid={`timeline-book-table-${table.id}`}
													>
														<Icon name="plus" className="size-3.5" />
													</Button>
												</div>

												{/* 15-Minute Slot Cells + Reservation Bars */}
												<div
													className="relative flex h-14"
													style={{ width: `${totalGridWidthPx}px` }}
												>
													{slots.map((slotMin) => (
														<div
															key={slotMin}
															style={{ width: `${SLOT_WIDTH_PX}px` }}
															onDragOver={(e) => {
																if (canManage) e.preventDefault()
															}}
															onDrop={(e) =>
																void handleDropOnCell(e, table.id, slotMin)
															}
															onClick={() => {
																if (canManage) {
																	host.openBookingSheet({
																		tableId: table.id,
																		areaId: table.areaId,
																		localStartMin: slotMin,
																	})
																}
															}}
															className="hover:bg-muted/30 h-full shrink-0 cursor-pointer border-e"
															data-testid={`timeline-cell-${table.id}-${slotMin}`}
														/>
													))}

													{/* Reservation Bars */}
													{rowReservations.map((rsv) => {
														const isGrabbed = kbGrab?.reservationId === rsv.id
														const isResizing = resizingState?.rsv.id === rsv.id
														const startMin = isGrabbed
															? kbGrab.localStartMin
															: rsv.localStartMin
														const durationMin = isResizing
															? resizingState.previewDurationMin
															: isGrabbed
																? kbGrab.durationMin
																: rsv.durationMin

														const clampedStart = Math.max(
															gridStartMin,
															startMin,
														)
														const clampedEnd = Math.min(
															gridEndMin,
															startMin + durationMin,
														)
														const leftPx =
															((clampedStart - gridStartMin) / SLOT_STEP_MIN) *
															SLOT_WIDTH_PX
														const widthPx = Math.max(
															SLOT_WIDTH_PX,
															((clampedEnd - clampedStart) / SLOT_STEP_MIN) *
																SLOT_WIDTH_PX -
																2,
														)

														const statusStyle = reservationStatusStyle(
															rsv.status,
														)
														const barTone = rsv.hasConflict
															? 'border-destructive/50 bg-destructive/10 text-foreground'
															: `${statusStyle.surface} ${statusStyle.surfaceText} ${
																	rsv.lateRisk || rsv.runningLateMin
																		? ATTENTION_RING
																		: ''
																}`

														const guestName = rsv.guestName
														const partySize = rsv.partySize
														const startTime = formatHhmm(startMin)
														const tableLabel = table.label
														const statusLabel = i18n._(statusStyle.label)
														const baseAriaLabel = rsv.locked
															? t`${guestName}, party of ${partySize}, ${startTime}, ${durationMin} minutes, table ${tableLabel}, locked`
															: t`${guestName}, party of ${partySize}, ${startTime}, ${durationMin} minutes, table ${tableLabel}`
														// State is never colour alone: status, late risk and a
														// conflict are in the name a screen reader reads.
														const attention = rsv.hasConflict
															? t`conflict`
															: rsv.lateRisk || rsv.runningLateMin
																? t`running late`
																: null
														const barAriaLabel = attention
															? t`${baseAriaLabel}, ${statusLabel}, ${attention}`
															: t`${baseAriaLabel}, ${statusLabel}`

														return (
															<div
																key={rsv.id}
																draggable={canManage}
																tabIndex={0}
																// A group, not a button: it holds real buttons (lock,
																// +-15 min), which a button role would hide from
																// assistive technology.
																role="group"
																aria-label={barAriaLabel}
																title={statusLabel}
																style={{
																	left: `${leftPx}px`,
																	width: `${widthPx}px`,
																}}
																onDragStart={(e) => {
																	setDraggingRsvId(rsv.id)
																	e.dataTransfer.setData('text/plain', rsv.id)
																	e.dataTransfer.setData(
																		'application/x-reservation-id',
																		rsv.id,
																	)
																}}
																onDragEnd={() => setDraggingRsvId(null)}
																onKeyDown={(e) => void handleBarKeyDown(e, rsv)}
																onClick={(e) => {
																	e.stopPropagation()
																	host.openDetail(rsv.id)
																}}
																className={`absolute top-1.5 bottom-1.5 z-10 flex cursor-grab items-center justify-between gap-1 overflow-hidden rounded-md border px-2 text-xs shadow-xs transition select-none focus:ring-2 focus:outline-none ${barTone} ${
																	isGrabbed ? 'ring-primary ring-2' : ''
																}`}
																data-testid={`timeline-bar-${rsv.id}`}
																data-table-id={table.id}
																data-start-min={startMin}
																data-duration-min={durationMin}
																data-locked={rsv.locked ? 'true' : 'false'}
															>
																<div className="flex min-w-0 items-center gap-1 truncate">
																	{rsv.locked ? (
																		<span
																			title={t`Locked to table`}
																			data-testid={`timeline-bar-lock-${rsv.id}`}
																		>
																			<Icon
																				name="lock"
																				className="size-3 shrink-0"
																			/>
																		</span>
																	) : null}
																	<span
																		className="truncate font-semibold"
																		dir="auto"
																	>
																		{rsv.guestName}
																	</span>
																	<span className="opacity-80">
																		({rsv.partySize})
																	</span>
																	{rsv.guest?.vipTier &&
																	rsv.guest.vipTier !== 'none' ? (
																		<span className="font-bold">★</span>
																	) : null}
																</div>

																{/* Lock Toggle & Duration Resize Controls (+15m / -15m + Right-Edge Drag Handle) */}
																{canManage ? (
																	<div
																		className="flex shrink-0 items-center gap-0.5"
																		onClick={(e) => e.stopPropagation()}
																		onKeyDown={(e) => e.stopPropagation()}
																	>
																		<button
																			type="button"
																			title={
																				rsv.locked
																					? t`Unlock table assignment`
																					: t`Lock table assignment`
																			}
																			aria-label={
																				rsv.locked
																					? t`Unlock table assignment`
																					: t`Lock table assignment`
																			}
																			aria-pressed={rsv.locked}
																			onClick={() => void handleToggleLock(rsv)}
																			className="hover:bg-foreground/10 inline-flex h-8 min-w-8 items-center justify-center rounded px-1 text-xs"
																			data-testid={`timeline-toggle-lock-${rsv.id}`}
																		>
																			<Icon
																				name="lock"
																				className={`size-3.5 ${rsv.locked ? 'opacity-100' : 'opacity-40'}`}
																			/>
																		</button>
																		{durationMin > 30 ? (
																			<button
																				type="button"
																				title={t`Shorten turn by 15m`}
																				aria-label={t`Shorten turn by 15m`}
																				onClick={() =>
																					void handleResizeDelta(rsv, -15)
																				}
																				className="hover:bg-foreground/10 inline-flex h-8 min-w-8 items-center justify-center rounded px-1 text-xs tabular-nums"
																				data-testid={`timeline-shrink-${rsv.id}`}
																			>
																				{t`-15m`}
																			</button>
																		) : null}
																		<button
																			type="button"
																			title={t`Extend turn by 15m`}
																			aria-label={t`Extend turn by 15m`}
																			onClick={() =>
																				void handleResizeDelta(rsv, 15)
																			}
																			className="hover:bg-foreground/10 inline-flex h-8 min-w-8 items-center justify-center rounded px-1 text-xs tabular-nums"
																			data-testid={`timeline-extend-${rsv.id}`}
																		>
																			{t`+15m`}
																		</button>
																		<div
																			role="separator"
																			aria-orientation="vertical"
																			title={t`Drag right edge to resize duration`}
																			onPointerDown={(e) =>
																				startPointerResize(e, rsv)
																			}
																			className="bg-foreground/20 hover:bg-foreground/40 h-8 w-2 cursor-ew-resize rounded-e"
																			data-testid={`timeline-resize-handle-${rsv.id}`}
																		/>
																	</div>
																) : null}
															</div>
														)
													})}
												</div>
											</div>
										)
									})}
								</div>
							)
						})}
					</div>
				</div>
			</Card>

			{/* Shared Host Sheets & Dialogs */}
			<BookingSheet
				open={host.bookingSheetOpen}
				onOpenChange={host.setBookingSheetOpen}
				client={host.client}
				locationId={locationId}
				defaultDate={host.businessDate}
				services={dayFeed?.services ?? []}
				areas={dayFeed?.areas ?? []}
				tables={dayFeed?.tables ?? []}
				initialLocalStartMin={host.bookingDefaults.localStartMin}
				initialPartySize={host.bookingDefaults.partySize}
				initialTableId={host.bookingDefaults.tableId}
				initialAreaId={host.bookingDefaults.areaId ?? host.selectedAreaId}
				initialServiceId={
					host.bookingDefaults.serviceId ?? host.selectedServiceId
				}
				onCreated={(rsv, notices) =>
					host.handleReservationMutated(rsv, notices)
				}
			/>

			<WalkInDialog
				open={host.walkInOpen}
				onOpenChange={host.setWalkInOpen}
				client={host.client}
				locationId={locationId}
				businessDate={host.businessDate}
				localStartMin={host.liveNow.localStartMin}
				tableStates={dayFeed?.tableStates ?? []}
				initialTableId={host.walkInDefaults.tableId}
				initialPartySize={host.walkInDefaults.partySize}
				onCreated={(rsv, notices) =>
					host.handleReservationMutated(rsv, notices)
				}
			/>

			<DetailSheet
				reservationId={host.detailReservationId}
				fallbackReservation={host.selectedReservation}
				onClose={host.closeDetail}
				client={host.client}
				areas={host.dayFeed?.areas ?? []}
				timeZone={host.timeZone}
				tables={dayFeed?.tables ?? []}
				canManage={canManage}
				onUpdated={(rsv, notices) =>
					host.handleReservationMutated(rsv, notices)
				}
			/>

			<ConflictPanel
				open={host.conflictPanelOpen}
				onOpenChange={host.setConflictPanelOpen}
				client={host.client}
				conflicts={dayFeed?.conflicts ?? []}
				unassigned={dayFeed?.unassigned ?? []}
				moveNotices={host.allMoveNotices}
				tables={dayFeed?.tables ?? []}
				canManage={canManage}
				onSelectReservation={host.openDetail}
				onResolved={(rsv, notices) =>
					host.handleReservationMutated(rsv, notices)
				}
				onClearMoveNotices={host.clearMoveNotices}
			/>
		</div>
	)
}
