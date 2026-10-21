import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Skeleton } from '@repo/ui/skeleton'
import {
	type DragEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useLoaderData } from 'react-router'
import { toast } from 'sonner'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import {
	FLOOR_STATUS_ICONS,
	FloorTable,
} from '#app/components/reservations/floor-table.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import {
	StatusLabel,
	TABLE_STATE_STYLES,
	reservationStatusStyle,
} from '#app/components/reservations/status-style.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import {
	FloorWaitlistPanel,
	WAITLIST_DRAG_TYPE,
	WaitlistSeatPrompt,
} from '#app/components/reservations/waitlist/floor-waitlist-panel.tsx'
import { SeatDialog } from '#app/components/reservations/waitlist/seat-dialog.tsx'
import {
	useFloorWaitlist,
	type WaitlistSeatOutcome,
} from '#app/components/reservations/waitlist/use-floor-waitlist.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	assignReservationTable,
	type DayReservationView,
	resolveSectionColorHex,
	saveSectionServerAssignments,
	transitionReservationStatus,
	updateReservationCourseStage,
} from '#app/utils/reservations/book-api.ts'
import { guestsRangeLabel } from '#app/utils/reservations/count-labels.ts'
import {
	type ComputedTableFloorState,
	computeTableFloorState,
	type FloorClock,
	floorElementsForArea,
	floorPlacement,
	floorTablePlacement,
	floorFitScale,
	floorRoomBounds,
	floorTablesForArea,
	isReservationOnFloor,
	pickFloorAreaId,
	restOfServiceWindow,
	type FloorPlacement,
	type TableSectionInfo,
} from '#app/utils/reservations/floor-state.ts'
import {
	hostErrorMessage,
	hostLoadErrorMessage,
} from '#app/utils/reservations/host-errors.ts'
import {
	COURSE_STAGE_LABELS,
	ELEMENT_KIND_LABELS,
	enumLabel,
} from '#app/utils/reservations/labels.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { createBlock, deleteBlock } from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/floor.ts'
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
		waitlistEnabled: access.features.waitlist,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION],
	})
	return { ok: true }
}

type OccupiedDropPromptState = {
	draggedReservation: DayReservationView
	targetTable: ComputedTableFloorState['table']
	occupantReservation: DayReservationView
}

const COURSE_STAGES = [
	{ id: 'appetizer', label: msg`Appetizer` },
	{ id: 'main', label: msg`Main` },
	{ id: 'dessert', label: msg`Dessert` },
	{ id: 'check', label: msg`Check` },
	{ id: 'bussing', label: msg`Bussing` },
] as const

/** Floor states in the legend order: quiet first, attention last. */
const LEGEND_STATES = [
	'available',
	'reserved_soon',
	'arrived_waiting',
	'seated',
	'dessert_check',
	'finishing',
	'overtime',
	'blocked',
] as const

/**
 * Scales only the geometry of a placement into screen pixels. Text inside a
 * tile keeps its own readable size, so a small room never shrinks type.
 */
function scaleFloorPlacement(
	p: FloorPlacement,
	stage: { x: number; y: number },
	scale: number,
): FloorPlacement {
	return {
		...p,
		x: (p.x - stage.x) * scale,
		y: (p.y - stage.y) * scale,
		width: p.width * scale,
		height: p.height * scale,
	}
}

/** Fits the room's bounding box to the container width (see `floorFitScale`). */
function useFitScale(stageWidth: number) {
	const viewportRef = useRef<HTMLDivElement | null>(null)
	const [scale, setScale] = useState(1)
	useEffect(() => {
		const node = viewportRef.current
		if (!node || typeof ResizeObserver === 'undefined') return
		const update = () => {
			const available = node.clientWidth - 32
			if (available > 0) {
				setScale(floorFitScale(available, stageWidth))
			}
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(node)
		return () => observer.disconnect()
	}, [stageWidth])
	return { viewportRef, scale }
}

export default function ReservationsFloorRoute() {
	const { t, i18n } = useLingui()
	const enumText = (
		labels: Record<string, MessageDescriptor>,
		value: string | null | undefined,
	) => enumLabel((d) => i18n._(d), labels, value)
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { orgSlug, canManage, waitlistEnabled } = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]
	const locationId = activeLocation?.id ?? ''

	const [draggingRsvId, setDraggingRsvId] = useState<string | null>(null)
	const [dragOverTableId, setDragOverTableId] = useState<string | null>(null)
	const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
	const [walkInTableIds, setWalkInTableIds] = useState<string[] | undefined>(
		undefined,
	)
	const [occupiedDropPrompt, setOccupiedDropPrompt] =
		useState<OccupiedDropPromptState | null>(null)
	const [overbookReason, setOverbookReason] = useState('')
	const [sectionOverlay, setSectionOverlay] = useState(false)
	const [highContrast, setHighContrast] = useState(false)
	const [sideFilter, setSideFilter] = useState<
		'all' | 'unassigned' | 'arrived' | 'upcoming' | 'seated'
	>('all')
	const [actionError, setActionError] = useState<string | null>(null)
	const [busyAction, setBusyAction] = useState(false)
	const [serverDrafts, setServerDrafts] = useState<Record<string, string>>({})
	const [savingServers, setSavingServers] = useState(false)

	const showWaitlist = waitlistEnabled && canManage
	const bookClient = useReservationsScopeClient(
		orgSlug,
		'book',
		locationId ? [locationId] : undefined,
	)
	const floorWaitlist = useFloorWaitlist({
		client: bookClient,
		locationId,
		enabled: showWaitlist,
	})

	// 5s ETag polling paused during drag or modal activity (VAL-HOST-017)
	const host = useHostStand({
		orgSlug,
		locationId,
		defaultTimeZone: activeLocation?.timezone ?? 'UTC',
		pollIntervalMs: 5_000,
		pausePolling: Boolean(
			draggingRsvId || occupiedDropPrompt || floorWaitlist.busyUi,
		),
	})

	const setupClient = useReservationsScopeClient(
		orgSlug,
		'setup',
		locationId ? [locationId] : undefined,
	)

	const feed = host.feed
	const notify = (message: string) => {
		setActionError(null)
		toast.success(message)
	}
	const fail = (err: unknown, fallback: MessageDescriptor) =>
		setActionError(hostErrorMessage(err, tx, fallback))

	// Live clock: business-day minutes, and "live" only on the current business date.
	const clock = useMemo<FloorClock>(
		() => ({
			nowMs: host.liveNow.nowMs,
			nowLocalMin: host.liveNow.localStartMin,
			live: host.isToday,
		}),
		[host.liveNow.nowMs, host.liveNow.localStartMin, host.isToday],
	)
	const feedBusinessDate = feed?.businessDate ?? host.businessDate

	// One area at a time: each area has its own coordinate space.
	const floorAreaId = pickFloorAreaId(feed?.areas ?? [], host.selectedAreaId)

	const activeLayout = useMemo(() => {
		const layouts = feed?.sections ?? []
		if (layouts.length === 0) return null
		if (host.selectedServiceId) {
			const match = layouts.find((l) => l.serviceId === host.selectedServiceId)
			if (match) return match
		}
		return layouts.find((l) => l.isDefault) ?? layouts[0] ?? null
	}, [feed?.sections, host.selectedServiceId])

	const sectionServerMap = useMemo(() => {
		const map = new Map<string, string>()
		for (const a of activeLayout?.assignments ?? []) {
			if (a.sectionId && a.serverName) map.set(a.sectionId, a.serverName)
		}
		for (const row of feed?.sectionAssignments ?? []) {
			if (row.sectionId && row.serverLabel)
				map.set(row.sectionId, row.serverLabel)
		}
		return map
	}, [activeLayout, feed?.sectionAssignments])

	useEffect(() => {
		if (!activeLayout) return
		const nextDrafts: Record<string, string> = {}
		for (const sec of activeLayout.sections ?? []) {
			nextDrafts[sec.id] = sectionServerMap.get(sec.id) ?? ''
		}
		setServerDrafts(nextDrafts)
	}, [activeLayout, sectionServerMap])

	const tableSectionMap = useMemo(() => {
		const map = new Map<string, TableSectionInfo>()
		for (const sec of activeLayout?.sections ?? []) {
			const serverLabel =
				serverDrafts[sec.id]?.trim() || sectionServerMap.get(sec.id) || null
			for (const tid of sec.tableIds) {
				map.set(tid, {
					sectionId: sec.id,
					sectionName: sec.name,
					colorToken: sec.colorToken || '1',
					serverLabel,
				})
			}
		}
		return map
	}, [activeLayout, sectionServerMap, serverDrafts])

	const activeReservations = useMemo(
		() =>
			(feed?.reservations ?? []).filter((r) => {
				if (!isReservationOnFloor(r.status)) return false
				return !(
					host.selectedServiceId &&
					r.serviceId &&
					r.serviceId !== host.selectedServiceId
				)
			}),
		[feed?.reservations, host.selectedServiceId],
	)

	const areaTables = useMemo(
		() => floorTablesForArea(feed?.tables ?? [], floorAreaId),
		[feed?.tables, floorAreaId],
	)
	const areaElements = useMemo(
		() =>
			floorElementsForArea(
				feed?.elements ?? feed?.floorElements ?? [],
				floorAreaId,
			),
		[feed?.elements, feed?.floorElements, floorAreaId],
	)

	const tableStates = useMemo<ComputedTableFloorState[]>(
		() =>
			areaTables.map((table) =>
				computeTableFloorState({
					table,
					reservations: activeReservations,
					blocks: feed?.blocks ?? [],
					clock,
					businessDate: feedBusinessDate,
					section: tableSectionMap.get(table.id) ?? null,
				}),
			),
		[
			areaTables,
			activeReservations,
			feed?.blocks,
			clock,
			feedBusinessDate,
			tableSectionMap,
		],
	)
	const tableStateById = useMemo(
		() => new Map(tableStates.map((ts) => [ts.table.id, ts])),
		[tableStates],
	)

	const selectedTableState = selectedTableId
		? (tableStateById.get(selectedTableId) ?? null)
		: null

	const stage = useMemo(
		() => floorRoomBounds(areaTables, areaElements),
		[areaTables, areaElements],
	)
	const { viewportRef, scale } = useFitScale(stage.width)

	const areaTableIds = useMemo(
		() => new Set(areaTables.map((table) => table.id)),
		[areaTables],
	)

	const sideReservations = useMemo(
		() =>
			activeReservations
				.filter((r) => {
					// A party with a table belongs to the area of that table. One without a
					// table shows in every area: its area is only a preference, and the
					// host must be able to seat it on whichever floor has the space (an
					// area with no tables has no tab to switch to).
					if (floorAreaId && r.assignedTableIds.length > 0) {
						const onThisFloor = r.assignedTableIds.some((id) =>
							areaTableIds.has(id),
						)
						if (!onThisFloor) return false
					}
					if (sideFilter === 'unassigned')
						return r.assignedTableIds.length === 0
					if (sideFilter === 'arrived') return r.status === 'arrived'
					if (sideFilter === 'upcoming') {
						return r.status === 'booked' || r.status === 'confirmed'
					}
					if (sideFilter === 'seated') return r.status === 'seated'
					return true
				})
				.sort((a, b) => a.localStartMin - b.localStartMin),
		[activeReservations, floorAreaId, areaTableIds, sideFilter],
	)

	const handleDropReservationOnTable = async (
		rsv: DayReservationView,
		targetState: ComputedTableFloorState,
	) => {
		if (!canManage) return
		setActionError(null)
		const existingOccupant =
			targetState.currentReservation &&
			targetState.currentReservation.id !== rsv.id
				? targetState.currentReservation
				: (activeReservations.find(
						(other) =>
							other.id !== rsv.id &&
							other.assignedTableIds.includes(targetState.table.id) &&
							other.localStartMin < rsv.localEndMin &&
							other.localEndMin > rsv.localStartMin,
					) ?? null)

		if (existingOccupant) {
			setOverbookReason('')
			setOccupiedDropPrompt({
				draggedReservation: rsv,
				targetTable: targetState.table,
				occupantReservation: existingOccupant,
			})
			return
		}

		setBusyAction(true)
		const guest = rsv.guestName
		const tableLabel = targetState.table.label
		try {
			if (rsv.status === 'arrived') {
				const seated = await transitionReservationStatus(host.client, rsv.id, {
					to: 'seated',
					tableIds: [targetState.table.id],
					expectedVersion: rsv.version,
				})
				host.handleReservationMutated(seated.reservation, seated.moveNotices)
				notify(t`Seated ${guest} at ${tableLabel}.`)
			} else {
				const res = await assignReservationTable(host.client, rsv.id, {
					tableIds: [targetState.table.id],
					expectedVersion: rsv.version,
				})
				if (res.moveNotices.length > 0) host.appendMoveNotices(res.moveNotices)
				notify(t`Assigned ${guest} to ${tableLabel}.`)
			}
			await host.refresh()
		} catch (err) {
			fail(err, msg`Could not assign the table.`)
		} finally {
			setBusyAction(false)
		}
	}

	const handleResolveOccupiedDrop = async (
		choice: 'swap' | 'reflow' | 'overbook',
	) => {
		if (!occupiedDropPrompt || !canManage) return
		const { draggedReservation, targetTable, occupantReservation } =
			occupiedDropPrompt
		const guest = draggedReservation.guestName
		const other = occupantReservation.guestName
		const tableLabel = targetTable.label
		setBusyAction(true)
		setActionError(null)
		try {
			const base = {
				tableIds: [targetTable.id],
				expectedVersion: draggedReservation.version,
			}
			const res = await assignReservationTable(
				host.client,
				draggedReservation.id,
				choice === 'swap'
					? { ...base, swapWithReservationId: occupantReservation.id }
					: choice === 'reflow'
						? { ...base, reflowLaterParties: true }
						: {
								...base,
								forceOverbook: true,
								reason:
									overbookReason.trim() ||
									`Overbooked onto ${tableLabel} alongside ${other}`,
							},
			)
			if (res.moveNotices.length > 0) host.appendMoveNotices(res.moveNotices)
			notify(
				choice === 'swap'
					? t`Swapped ${guest} with ${other} on ${tableLabel}.`
					: choice === 'reflow'
						? t`Assigned ${guest} to ${tableLabel} and reflowed overlapping parties.`
						: t`Overbooked ${guest} onto ${tableLabel}.`,
			)
			setOccupiedDropPrompt(null)
			await host.refresh()
		} catch (err) {
			fail(err, msg`Could not resolve the table conflict.`)
		} finally {
			setBusyAction(false)
		}
	}

	const finishWaitlistSeat = async (outcome: WaitlistSeatOutcome | null) => {
		if (!outcome) return
		if (outcome.ok) {
			const guest = outcome.entry.displayName
			const tableLabel = outcome.table.label
			notify(t`Seated ${guest} at ${tableLabel} from the waitlist.`)
			await host.refresh()
		} else {
			setActionError(outcome.message)
		}
	}

	const handleDropWaitlistOnTable = async (
		entryId: string,
		targetState: ComputedTableFloorState,
	) => {
		if (!showWaitlist) return
		setActionError(null)
		await finishWaitlistSeat(
			await floorWaitlist.dropOnTable(entryId, {
				id: targetState.table.id,
				label: targetState.table.label,
			}),
		)
	}

	const handleSeatAssignedReservation = async (
		rsv: DayReservationView,
		tableId: string,
	) => {
		if (!canManage) return
		setBusyAction(true)
		setActionError(null)
		const guest = rsv.guestName
		try {
			const seated = await transitionReservationStatus(host.client, rsv.id, {
				to: 'seated',
				tableIds: [tableId],
				expectedVersion: rsv.version,
			})
			host.handleReservationMutated(seated.reservation, seated.moveNotices)
			notify(t`Seated ${guest}.`)
		} catch (err) {
			fail(err, msg`Could not seat the party.`)
		} finally {
			setBusyAction(false)
		}
	}

	const handleCourseUpdate = async (
		rsv: DayReservationView,
		courseStage: string,
	) => {
		if (!canManage) return
		setBusyAction(true)
		setActionError(null)
		try {
			await updateReservationCourseStage(
				host.client,
				rsv.id,
				courseStage,
				rsv.version,
			)
			const stageLabel = enumText(COURSE_STAGE_LABELS, courseStage)
			notify(t`Updated course stage to ${stageLabel}.`)
			await host.refresh()
		} catch (err) {
			fail(err, msg`Could not update the course stage.`)
		} finally {
			setBusyAction(false)
		}
	}

	const handleFinishSeatedReservation = async (rsv: DayReservationView) => {
		if (!canManage) return
		setBusyAction(true)
		setActionError(null)
		const guest = rsv.guestName
		try {
			await transitionReservationStatus(host.client, rsv.id, {
				to: 'finished',
				expectedVersion: rsv.version,
			})
			notify(t`Marked ${guest} as finished.`)
			await host.refresh()
		} catch (err) {
			fail(err, msg`Could not finish the reservation.`)
		} finally {
			setBusyAction(false)
		}
	}

	const handleBlockTableForService = async (
		tableState: ComputedTableFloorState,
	) => {
		if (!canManage || !locationId) return
		setBusyAction(true)
		setActionError(null)
		const tableLabel = tableState.table.label
		try {
			if (tableState.isBlocked && tableState.blockId) {
				await deleteBlock(setupClient, locationId, tableState.blockId)
				notify(t`Unblocked table ${tableLabel}.`)
			} else {
				const services = feed?.services ?? []
				const activeService =
					services.find((s) => s.id === host.selectedServiceId) ??
					services.find(
						(s) =>
							clock.live &&
							s.firstSeatingMin <= clock.nowLocalMin &&
							clock.nowLocalMin < s.endMin,
					) ??
					services[0] ??
					null
				const { startMin, endMin } = restOfServiceWindow({
					service: activeService,
					clock,
					dayStartMin: feed?.dayStartMin ?? 240,
				})
				await createBlock(setupClient, locationId, {
					businessDate: host.businessDate,
					tableId: tableState.table.id,
					startMin,
					endMin,
					reason: 'maintenance',
					note: 'Blocked from Live Floor Plan for rest of service',
				})
				notify(t`Blocked table ${tableLabel} for the rest of the service.`)
			}
			await host.refresh()
		} catch (err) {
			fail(err, msg`Could not update the table block.`)
		} finally {
			setBusyAction(false)
		}
	}

	const handleSaveSectionServers = async () => {
		if (!canManage || !locationId || !activeLayout) return
		const serviceId =
			host.selectedServiceId ??
			activeLayout.serviceId ??
			feed?.services?.[0]?.id ??
			''
		if (!serviceId) return
		setSavingServers(true)
		setActionError(null)
		try {
			await saveSectionServerAssignments(host.client, {
				locationId,
				date: host.businessDate,
				serviceId,
				assignments: activeLayout.sections.map((sec) => ({
					sectionId: sec.id,
					serverLabel: serverDrafts[sec.id]?.trim() || null,
				})),
			})
			notify(t`Saved section server assignments for this service.`)
			await host.refresh()
		} catch (err) {
			fail(err, msg`Could not save the section servers.`)
		} finally {
			setSavingServers(false)
		}
	}

	const getSectionColor = (token: string | null) =>
		token ? resolveSectionColorHex(token) : null

	// Stable handlers so memoized tiles only redraw when their own state changes.
	const feedReservations = feed?.reservations
	const { setFloorDragOver, clearFloorDragOver } = useMemo(
		() => ({
			setFloorDragOver: (tableId: string) => setDragOverTableId(tableId),
			clearFloorDragOver: (tableId: string) =>
				setDragOverTableId((prev) => (prev === tableId ? null : prev)),
		}),
		[],
	)
	const onSelectTable = useCallback(
		(tableId: string) =>
			setSelectedTableId((prev) => (prev === tableId ? null : tableId)),
		[],
	)
	const onDragOverTable = useCallback(
		(event: DragEvent<HTMLButtonElement>, tableId: string) => {
			event.preventDefault()
			setFloorDragOver(tableId)
		},
		[setFloorDragOver],
	)
	const dropHandlerRef = useRef<
		(event: DragEvent<HTMLButtonElement>, ts: ComputedTableFloorState) => void
	>(() => {})
	dropHandlerRef.current = (event, ts) => {
		event.preventDefault()
		setDragOverTableId(null)
		const waitlistId =
			event.dataTransfer.getData(WAITLIST_DRAG_TYPE) || floorWaitlist.draggingId
		if (waitlistId) {
			floorWaitlist.setDraggingId(null)
			void handleDropWaitlistOnTable(waitlistId, ts)
			return
		}
		const rsvId =
			event.dataTransfer.getData('text/reservation-id') || draggingRsvId
		setDraggingRsvId(null)
		if (!rsvId) return
		const rsv = feedReservations?.find((r) => r.id === rsvId)
		if (rsv) void handleDropReservationOnTable(rsv, ts)
	}
	const onDropOnTable = useCallback(
		(event: DragEvent<HTMLButtonElement>, ts: ComputedTableFloorState) =>
			dropHandlerRef.current(event, ts),
		[],
	)

	const pollPaused = Boolean(
		draggingRsvId || occupiedDropPrompt || floorWaitlist.busyUi,
	)
	const loadFailure =
		host.poll.error && !feed
			? hostLoadErrorMessage(
					{ status: host.poll.errorStatus, code: host.poll.errorCode },
					tx,
				)
			: null
	const areas = (feed?.areas ?? []).filter(
		(a) => a.isActive !== false && !a.archivedAt,
	)

	return (
		<div
			className="flex flex-col gap-4"
			data-testid="reservations-floor-page"
			data-high-contrast={highContrast ? 'true' : 'false'}
		>
			<HostSubnav
				orgSlug={orgSlug}
				activeView="floor"
				businessDate={host.businessDate}
				todayDate={host.todayDate}
				onDateChange={host.setDate}
				services={feed?.services ?? []}
				selectedServiceId={host.selectedServiceId}
				onServiceChange={host.setServiceId}
				areas={feed?.areas ?? []}
				selectedAreaId={host.selectedAreaId}
				onAreaChange={host.setAreaId}
				unassignedCount={feed?.unassigned.length ?? 0}
				conflictCount={feed?.conflicts.length ?? 0}
				moveNoticeCount={host.allMoveNotices.length}
				onOpenBookingSheet={() => host.openBookingSheet()}
				onOpenWalkIn={() => {
					setWalkInTableIds(undefined)
					host.openWalkIn()
				}}
				onOpenConflictPanel={() => host.setConflictPanelOpen(true)}
				canManage={canManage}
				refreshing={host.poll.refreshing}
				onRefresh={() => void host.poll.refresh({ force: true })}
				lastUpdatedAt={host.poll.lastUpdatedAt}
				serviceNotes={feed?.serviceNotes ?? []}
			/>

			{loadFailure ? (
				<Alert variant="destructive" data-testid="floor-load-error">
					<AlertDescription>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span>{loadFailure}</span>
							<Button
								type="button"
								size="sm"
								className="h-8 max-md:h-11 pointer-coarse:h-11"
								variant="outline"
								onClick={() => void host.poll.refresh({ force: true })}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{actionError ? (
				<Alert variant="destructive" data-testid="floor-action-error">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			) : null}

			{/* Occupied table drop resolution prompt (VAL-HOST-014) */}
			{occupiedDropPrompt ? (
				<Card
					className="border-warning/50 bg-warning/10 p-4"
					data-testid="floor-occupied-drop-dialog"
				>
					<div className="flex flex-col gap-3">
						<div className="flex items-start justify-between gap-2">
							<div>
								<h3 className="text-sm font-semibold">
									<Trans>
										Table {occupiedDropPrompt.targetTable.label} is occupied by{' '}
										{occupiedDropPrompt.occupantReservation.guestName} (
										{occupiedDropPrompt.occupantReservation.partySize}p)
									</Trans>
								</h3>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Choose how to place{' '}
										{occupiedDropPrompt.draggedReservation.guestName} (
										{occupiedDropPrompt.draggedReservation.partySize}p,{' '}
										{occupiedDropPrompt.draggedReservation.hhmm}) onto{' '}
										{occupiedDropPrompt.targetTable.label}:
									</Trans>
								</p>
							</div>
							<Button
								type="button"
								size="sm"
								className="h-8 max-md:h-11 pointer-coarse:h-11"
								variant="ghost"
								data-testid="floor-occupied-choice-cancel"
								onClick={() => setOccupiedDropPrompt(null)}
							>
								<Trans>Cancel</Trans>
							</Button>
						</div>

						<div className="flex flex-wrap items-end gap-2">
							<Button
								type="button"
								size="sm"
								className="h-8 max-md:h-11 pointer-coarse:h-11"
								variant="outline"
								disabled={busyAction}
								data-testid="floor-occupied-choice-swap"
								onClick={() => handleResolveOccupiedDrop('swap')}
							>
								<Icon name="refresh-cw" className="size-3.5" />
								<Trans>Swap tables</Trans>
							</Button>
							<Button
								type="button"
								size="sm"
								className="h-8 max-md:h-11 pointer-coarse:h-11"
								variant="outline"
								disabled={busyAction}
								data-testid="floor-occupied-choice-reflow"
								onClick={() => handleResolveOccupiedDrop('reflow')}
							>
								<Icon name="route" className="size-3.5" />
								<Trans>Reflow later parties</Trans>
							</Button>
							<div className="flex items-center gap-1.5">
								<Input
									value={overbookReason}
									onChange={(e) => setOverbookReason(e.target.value)}
									placeholder={t`Overbook reason (optional)`}
									aria-label={t`Overbook reason (optional)`}
									className="w-48"
									data-testid="floor-occupied-overbook-reason"
								/>
								<Button
									type="button"
									size="sm"
									className="h-8 max-md:h-11 pointer-coarse:h-11"
									variant="outline"
									disabled={busyAction}
									data-testid="floor-occupied-choice-overbook"
									onClick={() => handleResolveOccupiedDrop('overbook')}
								>
									<Icon name="alert-triangle" className="size-3.5" />
									<Trans>Overbook table</Trans>
								</Button>
							</div>
						</div>
					</div>
				</Card>
			) : null}

			{floorWaitlist.prompt ? (
				<WaitlistSeatPrompt
					prompt={floorWaitlist.prompt}
					busy={floorWaitlist.waitlist.busyId !== null}
					onChoose={(choice) =>
						void floorWaitlist.resolvePrompt(choice).then(finishWaitlistSeat)
					}
					onCancel={floorWaitlist.cancelPrompt}
				/>
			) : null}

			{/* Toolbar: one area at a time, overlays, live state */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-1.5">
					{areas.length > 1
						? areas.map((area) => (
								<Button
									key={area.id}
									type="button"
									size="sm"
									variant={floorAreaId === area.id ? 'secondary' : 'outline'}
									aria-pressed={floorAreaId === area.id}
									className="h-8 max-md:h-11 pointer-coarse:h-11"
									onClick={() => host.setAreaFilter(area.id)}
									data-testid={`floor-area-${area.id}`}
								>
									{area.name}
								</Button>
							))
						: null}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant={sectionOverlay ? 'secondary' : 'outline'}
						aria-pressed={sectionOverlay}
						className="h-8 max-md:h-11 pointer-coarse:h-11"
						onClick={() => setSectionOverlay((v) => !v)}
						data-testid="floor-section-overlay-toggle"
					>
						<Icon name="blocks" className="size-4" />
						<Trans>Section overlay</Trans>
					</Button>
					<Button
						type="button"
						size="sm"
						variant={highContrast ? 'secondary' : 'outline'}
						aria-pressed={highContrast}
						className="h-8 max-md:h-11 pointer-coarse:h-11"
						onClick={() => setHighContrast((v) => !v)}
						data-testid="floor-high-contrast-toggle"
					>
						<Icon name="sun" className="size-4" />
						<Trans>High contrast</Trans>
					</Button>
					<Badge variant="outline" data-testid="floor-poll-badge">
						<Icon name="refresh-cw" className="size-3" />
						{pollPaused ? <Trans>Updates paused</Trans> : <Trans>Live</Trans>}
					</Badge>
				</div>
			</div>

			{/* One-line key for the table states */}
			<div
				className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
				data-testid="floor-status-legend"
			>
				{LEGEND_STATES.map((state) => (
					<span key={state} className="inline-flex items-center gap-1.5">
						<span
							aria-hidden="true"
							className={cn(
								'size-2.5 rounded-sm border',
								TABLE_STATE_STYLES[state].surface,
							)}
						/>
						<Icon name={FLOOR_STATUS_ICONS[state]} className="size-3.5" />
						{i18n._(TABLE_STATE_STYLES[state].label)}
					</span>
				))}
			</div>

			{/* Section Overlay Legend & Server Assignment Bar (VAL-HOST-016) */}
			{sectionOverlay ? (
				<Card data-testid="floor-section-legend">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-sm font-semibold">
								<Trans>Section overlay & server assignments</Trans>
								{activeLayout ? ` — ${activeLayout.name}` : ''}
							</CardTitle>
							{canManage && activeLayout ? (
								<Button
									type="button"
									size="sm"
									className="h-8 max-md:h-11 pointer-coarse:h-11"
									disabled={savingServers}
									data-testid="floor-section-save-servers"
									onClick={handleSaveSectionServers}
								>
									<Icon name="check" className="size-3.5" />
									<Trans>Save section servers</Trans>
								</Button>
							) : null}
						</div>
					</CardHeader>
					<CardContent>
						{!activeLayout || activeLayout.sections.length === 0 ? (
							<p className="text-muted-foreground text-xs">
								<Trans>
									No section layout configured for this location yet. Configure
									sections under Settings → Sections.
								</Trans>
							</p>
						) : (
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
								{activeLayout.sections.map((sec) => {
									const secTables = tableStates.filter(
										(ts) => ts.sectionId === sec.id,
									)
									const seatedCovers = secTables.reduce(
										(sum, ts) =>
											sum +
											(ts.currentReservation?.status === 'seated'
												? ts.currentReservation.partySize
												: 0),
										0,
									)
									const tableCount = secTables.length
									return (
										<div
											key={sec.id}
											className="border-border flex flex-col gap-2 rounded-lg border p-2.5"
											data-testid={`floor-section-card-${sec.id}`}
										>
											<div className="flex items-center justify-between gap-2">
												<div className="flex min-w-0 items-center gap-2">
													<span
														aria-hidden="true"
														className="inline-block size-3.5 shrink-0 rounded-full border"
														style={{
															backgroundColor:
																getSectionColor(sec.colorToken) ??
																'var(--muted-foreground)',
														}}
													/>
													<span className="truncate text-sm font-medium">
														{sec.name}
													</span>
												</div>
												<Badge variant="secondary">
													<Trans>
														{tableCount} tables · {seatedCovers} covers
													</Trans>
												</Badge>
											</div>
											<div className="flex items-center gap-1.5">
												<Label
													htmlFor={`section-server-${sec.id}`}
													className="text-muted-foreground shrink-0 text-xs"
												>
													<Trans>Server:</Trans>
												</Label>
												<Input
													id={`section-server-${sec.id}`}
													value={serverDrafts[sec.id] ?? ''}
													disabled={!canManage}
													onChange={(e) =>
														setServerDrafts((prev) => ({
															...prev,
															[sec.id]: e.target.value,
														}))
													}
													placeholder={t`Unassigned`}
													data-testid={`floor-section-server-input-${sec.id}`}
												/>
											</div>
										</div>
									)
								})}
							</div>
						)}
					</CardContent>
				</Card>
			) : null}

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
				<div className="lg:col-span-8">
					<Card className="overflow-hidden">
						<div
							ref={viewportRef}
							className="bg-muted/20 relative min-h-96 w-full overflow-auto p-4"
							dir="ltr"
							data-testid="floor-plan-canvas"
						>
							{!feed && host.poll.loading ? (
								<Skeleton className="mx-auto h-96 w-full max-w-3xl" />
							) : feed && tableStates.length === 0 ? (
								<p className="text-muted-foreground py-16 text-center text-sm">
									<Trans>
										No tables in this area yet. Add tables under Settings →
										Floor plan.
									</Trans>
								</p>
							) : (
								<div
									className="mx-auto"
									dir="ltr"
									style={{
										width: stage.width * scale,
										height: stage.height * scale,
									}}
								>
									<div
										className="relative"
										style={{
											width: stage.width * scale,
											height: stage.height * scale,
										}}
										data-testid="floor-plan-stage"
									>
										{areaElements.map((el) => {
											const p = scaleFloorPlacement(
												floorPlacement(el),
												stage,
												scale,
											)
											return (
												<div
													key={el.id}
													data-testid={`floor-element-${el.id}`}
													data-element-kind={el.kind}
													className="border-border/70 bg-muted/60 text-muted-foreground pointer-events-none absolute flex items-center justify-center rounded border px-1.5 text-xs font-medium"
													style={{
														left: p.x,
														top: p.y,
														width: p.width,
														height: p.height,
														transform: p.rotation
															? `rotate(${p.rotation}deg)`
															: undefined,
													}}
												>
													<span className="truncate">
														{el.label || enumText(ELEMENT_KIND_LABELS, el.kind)}
													</span>
												</div>
											)
										})}

										{tableStates.map((ts, index) => (
											<FloorTable
												key={ts.table.id}
												state={ts}
												placement={scaleFloorPlacement(
													floorTablePlacement(ts.table, index),
													stage,
													scale,
												)}
												isRound={ts.table.shape === 'round'}
												selected={selectedTableId === ts.table.id}
												dragOver={dragOverTableId === ts.table.id}
												highContrast={highContrast}
												canManage={canManage}
												showSection={sectionOverlay}
												sectionColor={
													sectionOverlay
														? getSectionColor(ts.sectionColorToken)
														: null
												}
												onSelect={onSelectTable}
												onDragOverTable={onDragOverTable}
												onDragLeaveTable={clearFloorDragOver}
												onDropOnTable={onDropOnTable}
											/>
										))}
									</div>
								</div>
							)}
						</div>
					</Card>
				</div>

				<div className="flex flex-col gap-4 lg:col-span-4">
					{selectedTableState ? (
						<Card data-testid="floor-table-quick-actions">
							<CardHeader className="pb-2">
								<div className="flex items-center justify-between gap-2">
									<div className="min-w-0">
										<CardTitle className="text-sm font-semibold">
											{selectedTableState.table.label} ·{' '}
											{guestsRangeLabel(
												selectedTableState.table.minCovers,
												selectedTableState.table.maxCovers,
											)}
										</CardTitle>
										<p className="text-muted-foreground text-xs">
											{i18n._(
												TABLE_STATE_STYLES[selectedTableState.liveStatus].label,
											)}
											{selectedTableState.sectionName
												? ` · ${selectedTableState.sectionName}`
												: ''}
											{selectedTableState.serverLabel
												? ` (${selectedTableState.serverLabel})`
												: ''}
										</p>
									</div>
									<Button
										type="button"
										size="icon"
										variant="ghost"
										aria-label={t`Close table details`}
										className="size-8 max-md:size-11 pointer-coarse:size-11"
										onClick={() => setSelectedTableId(null)}
									>
										<Icon name="x" className="size-4" />
									</Button>
								</div>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{selectedTableState.currentReservation ? (
									<div className="border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-2.5">
										<div className="flex items-center justify-between gap-2">
											<div className="min-w-0">
												<p className="text-sm font-semibold wrap-anywhere">
													{selectedTableState.currentReservation.guestName} (
													{selectedTableState.currentReservation.partySize}p)
												</p>
												<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
													<span>
														{selectedTableState.currentReservation.hhmm} –{' '}
														{selectedTableState.currentReservation.endHhmm}
													</span>
													<StatusLabel
														status={
															selectedTableState.currentReservation.status
														}
													/>
												</p>
											</div>
											<Button
												type="button"
												size="sm"
												variant="outline"
												className="h-8 max-md:h-11 pointer-coarse:h-11"
												data-testid="floor-action-open-detail"
												onClick={() =>
													host.openReservationDetail(
														selectedTableState.currentReservation!.id,
													)
												}
											>
												<Trans>Details</Trans>
											</Button>
										</div>

										{canManage &&
										selectedTableState.currentReservation.status ===
											'arrived' ? (
											<Button
												type="button"
												size="sm"
												className="h-8 max-md:h-11 pointer-coarse:h-11"
												disabled={busyAction}
												data-testid="floor-action-seat-assigned"
												onClick={() =>
													handleSeatAssignedReservation(
														selectedTableState.currentReservation!,
														selectedTableState.table.id,
													)
												}
											>
												<Icon name="users" className="size-3.5" />
												<Trans>Seat arrived party now</Trans>
											</Button>
										) : null}

										{canManage &&
										selectedTableState.currentReservation.status ===
											'seated' ? (
											<div className="flex flex-col gap-1.5">
												<span className="text-muted-foreground text-xs font-medium">
													<Trans>Course stage:</Trans>
												</span>
												<div className="flex flex-wrap gap-1">
													{COURSE_STAGES.map((courseStage) => (
														<Button
															key={courseStage.id}
															type="button"
															size="sm"
															variant={
																selectedTableState.currentReservation
																	?.courseStage === courseStage.id
																	? 'secondary'
																	: 'outline'
															}
															aria-pressed={
																selectedTableState.currentReservation
																	?.courseStage === courseStage.id
															}
															disabled={busyAction}
															className="h-8 max-md:h-11 pointer-coarse:h-11"
															data-testid={`floor-action-course-${courseStage.id}`}
															onClick={() =>
																handleCourseUpdate(
																	selectedTableState.currentReservation!,
																	courseStage.id,
																)
															}
														>
															{i18n._(courseStage.label)}
														</Button>
													))}
												</div>
												<Button
													type="button"
													size="sm"
													variant="outline"
													className="h-8 max-md:h-11 pointer-coarse:h-11"
													disabled={busyAction}
													data-testid="floor-action-finish"
													onClick={() =>
														handleFinishSeatedReservation(
															selectedTableState.currentReservation!,
														)
													}
												>
													<Icon name="check" className="size-3.5" />
													<Trans>Finish & clear table</Trans>
												</Button>
											</div>
										) : null}
									</div>
								) : selectedTableState.nextReservation ? (
									<div className="border-border bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5">
										<p className="min-w-0 text-sm font-semibold wrap-anywhere">
											<Trans>Next:</Trans>{' '}
											{selectedTableState.nextReservation.guestName} (
											{selectedTableState.nextReservation.partySize}p ·{' '}
											{selectedTableState.nextReservation.hhmm})
										</p>
										<div className="flex items-center gap-1">
											{canManage ? (
												<Button
													type="button"
													size="sm"
													className="h-8 max-md:h-11 pointer-coarse:h-11"
													disabled={busyAction}
													data-testid="floor-action-seat-assigned"
													onClick={() =>
														handleSeatAssignedReservation(
															selectedTableState.nextReservation!,
															selectedTableState.table.id,
														)
													}
												>
													<Trans>Seat</Trans>
												</Button>
											) : null}
											<Button
												type="button"
												size="sm"
												variant="outline"
												className="h-8 max-md:h-11 pointer-coarse:h-11"
												data-testid="floor-action-open-detail"
												onClick={() =>
													host.openReservationDetail(
														selectedTableState.nextReservation!.id,
													)
												}
											>
												<Trans>Details</Trans>
											</Button>
										</div>
									</div>
								) : null}

								{canManage ? (
									<div className="flex flex-wrap gap-2">
										<Button
											type="button"
											size="sm"
											className="h-8 max-md:h-11 pointer-coarse:h-11"
											disabled={selectedTableState.isBlocked || busyAction}
											data-testid="floor-action-walk-in"
											onClick={() => {
												setWalkInTableIds([selectedTableState.table.id])
												host.setWalkInOpen(true)
											}}
										>
											<Icon name="user-plus" className="size-3.5" />
											<Trans>
												Seat walk-in at {selectedTableState.table.label}
											</Trans>
										</Button>
										<Button
											type="button"
											size="sm"
											variant="outline"
											className="h-8 max-md:h-11 pointer-coarse:h-11"
											disabled={busyAction}
											data-testid="floor-action-block-table"
											onClick={() =>
												handleBlockTableForService(selectedTableState)
											}
										>
											<Icon name="ban" className="size-3.5" />
											{selectedTableState.isBlocked ? (
												<Trans>Unblock table</Trans>
											) : (
												<Trans>Block table for service</Trans>
											)}
										</Button>
									</div>
								) : null}
							</CardContent>
						</Card>
					) : null}

					{showWaitlist ? (
						<FloorWaitlistPanel
							entries={floorWaitlist.waitlist.active}
							loading={floorWaitlist.waitlist.loading}
							error={floorWaitlist.waitlist.loadError}
							dragging={floorWaitlist.draggingId !== null}
							busyId={floorWaitlist.waitlist.busyId}
							selectedTable={
								selectedTableState
									? {
											id: selectedTableState.table.id,
											label: selectedTableState.table.label,
										}
									: null
							}
							clockOffsetMs={floorWaitlist.waitlist.clockOffsetMs}
							announcement={floorWaitlist.waitlist.announcement}
							onDragStart={(entry) => floorWaitlist.setDraggingId(entry.id)}
							onDragEnd={() => {
								floorWaitlist.setDraggingId(null)
								setDragOverTableId(null)
							}}
							onSeatAtSelected={(entry, table) => {
								setActionError(null)
								void floorWaitlist
									.dropOnTable(entry.id, table)
									.then(finishWaitlistSeat)
							}}
							onChooseTable={(entry) => floorWaitlist.setSeatDialogId(entry.id)}
						/>
					) : null}

					<Card
						className="flex flex-col"
						data-testid="floor-side-reservation-list"
					>
						<CardHeader className="pb-2">
							<div className="flex items-center justify-between gap-2">
								<CardTitle className="text-sm font-semibold">
									<Trans>Parties ({sideReservations.length})</Trans>
								</CardTitle>
								{canManage ? (
									<span className="text-muted-foreground text-xs">
										<Trans>Drag onto a table, or use Assign to table</Trans>
									</span>
								) : null}
							</div>
							<div className="flex flex-wrap gap-1 pt-1">
								{(
									[
										{ id: 'all', label: t`All` },
										{ id: 'unassigned', label: t`Unassigned` },
										{ id: 'arrived', label: t`Arrived` },
										{ id: 'upcoming', label: t`Upcoming` },
										{ id: 'seated', label: t`Seated` },
									] as const
								).map((tab) => (
									<Button
										key={tab.id}
										type="button"
										size="sm"
										variant={sideFilter === tab.id ? 'secondary' : 'outline'}
										aria-pressed={sideFilter === tab.id}
										className="h-8 max-md:h-11 pointer-coarse:h-11"
										data-testid={`floor-side-filter-${tab.id}`}
										onClick={() => setSideFilter(tab.id)}
									>
										{tab.label}
									</Button>
								))}
							</div>
						</CardHeader>
						<CardContent className="flex max-h-[460px] flex-col gap-2 overflow-y-auto">
							{!feed && host.poll.loading ? (
								<>
									<Skeleton className="h-14" />
									<Skeleton className="h-14" />
									<Skeleton className="h-14" />
								</>
							) : sideReservations.length === 0 ? (
								<p className="text-muted-foreground py-6 text-center text-sm">
									<Trans>No parties match this filter.</Trans>
								</p>
							) : (
								sideReservations.map((rsv) => {
									const tableLabels = rsv.assignedTableLabels.join(', ')
									return (
										<div
											key={rsv.id}
											draggable={canManage}
											onDragStart={(e) => {
												e.dataTransfer.setData('text/reservation-id', rsv.id)
												setDraggingRsvId(rsv.id)
											}}
											onDragEnd={() => {
												setDraggingRsvId(null)
												setDragOverTableId(null)
											}}
											data-testid={`floor-side-rsv-${rsv.id}`}
											className={cn(
												'border-border bg-card hover:border-primary/50 flex flex-col gap-1.5 rounded-lg border p-2.5 transition-colors',
												canManage && 'cursor-grab active:cursor-grabbing',
											)}
										>
											<div className="flex items-center justify-between gap-2">
												<Button
													type="button"
													variant="link"
													className="h-auto min-h-8 min-w-0 justify-start p-0 text-start text-sm font-semibold max-md:min-h-11 pointer-coarse:min-h-11"
													onClick={() => host.openReservationDetail(rsv.id)}
												>
													<span className="truncate">
														{rsv.hhmm} · {rsv.guestName} ({rsv.partySize}p)
													</span>
												</Button>
												<StatusLabel status={rsv.status} />
											</div>

											<div className="flex flex-wrap items-center justify-between gap-1 text-xs">
												<span
													className={cn(
														rsv.assignedTableLabels.length === 0
															? 'text-warning'
															: 'text-muted-foreground',
														reservationStatusStyle(rsv.status).strike &&
															'line-through',
													)}
												>
													{tableLabels || t`Unassigned`}
												</span>

												{canManage ? (
													<div className="flex items-center gap-1">
														{selectedTableState ? (
															<Button
																type="button"
																size="sm"
																variant="secondary"
																className="h-8 max-md:h-11 pointer-coarse:h-11"
																data-testid={`floor-assign-to-selected-${rsv.id}`}
																onClick={() =>
																	handleDropReservationOnTable(
																		rsv,
																		selectedTableState,
																	)
																}
															>
																{rsv.status === 'arrived'
																	? t`Seat at ${selectedTableState.table.label}`
																	: t`Assign to ${selectedTableState.table.label}`}
															</Button>
														) : null}
														<DropdownMenu>
															<DropdownMenuTrigger
																render={
																	<Button
																		type="button"
																		size="sm"
																		variant="outline"
																		className="h-8 max-md:h-11 pointer-coarse:h-11"
																		data-testid={`floor-assign-menu-${rsv.id}`}
																	>
																		<Icon
																			name="layout-grid"
																			className="size-3.5"
																		/>
																		<Trans>Assign to table</Trans>
																	</Button>
																}
															/>
															<DropdownMenuContent
																align="end"
																className="max-h-72 overflow-y-auto"
															>
																{tableStates.map((ts) => {
																	const tableName = ts.table.label
																	return (
																		<DropdownMenuItem
																			key={ts.table.id}
																			disabled={ts.isBlocked}
																			data-testid={`floor-assign-${rsv.id}-${ts.table.id}`}
																			onClick={() =>
																				handleDropReservationOnTable(rsv, ts)
																			}
																		>
																			<span className="font-medium">
																				{tableName}
																			</span>
																			<span className="text-muted-foreground ms-auto text-xs">
																				{ts.table.minCovers}-
																				{ts.table.maxCovers} ·{' '}
																				{i18n._(
																					TABLE_STATE_STYLES[ts.liveStatus]
																						.label,
																				)}
																			</span>
																		</DropdownMenuItem>
																	)
																})}
															</DropdownMenuContent>
														</DropdownMenu>
													</div>
												) : null}
											</div>
										</div>
									)
								})
							)}
						</CardContent>
					</Card>
				</div>
			</div>

			<BookingSheet
				open={host.bookingSheetOpen}
				onOpenChange={host.setBookingSheetOpen}
				client={host.client}
				locationId={locationId}
				defaultDate={host.businessDate}
				services={feed?.services ?? []}
				areas={feed?.areas ?? []}
				tables={feed?.tables ?? []}
				initialLocalStartMin={host.bookingDefaults.localStartMin}
				initialPartySize={host.bookingDefaults.partySize}
				initialTableId={host.bookingDefaults.tableId}
				initialAreaId={host.bookingDefaults.areaId ?? host.selectedAreaId}
				initialServiceId={
					host.bookingDefaults.serviceId ?? host.selectedServiceId
				}
				onCreated={(created, notices) => {
					host.handleReservationMutated(created, notices)
					host.openReservationDetail(created.id)
				}}
			/>

			<WalkInDialog
				open={host.walkInOpen}
				onOpenChange={host.setWalkInOpen}
				client={host.client}
				locationId={locationId}
				businessDate={host.businessDate}
				localStartMin={host.liveNow.localStartMin}
				tableStates={feed?.tableStates ?? []}
				initialTableId={walkInTableIds?.[0] ?? host.walkInDefaults.tableId}
				initialPartySize={host.walkInDefaults.partySize}
				onCreated={(created, notices) => {
					host.handleReservationMutated(created, notices)
				}}
			/>

			<DetailSheet
				reservationId={host.detailReservationId}
				fallbackReservation={host.selectedReservation}
				onClose={host.closeDetail}
				client={host.client}
				areas={host.dayFeed?.areas ?? []}
				timeZone={host.timeZone}
				tables={feed?.tables ?? []}
				canManage={canManage}
				onUpdated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
				}}
			/>

			{showWaitlist ? (
				<SeatDialog
					entry={
						floorWaitlist.waitlist.active.find(
							(entry) => entry.id === floorWaitlist.seatDialogId,
						) ?? null
					}
					onClose={() => floorWaitlist.setSeatDialogId(null)}
					tableStates={feed?.tableStates ?? []}
					initialTableId={selectedTableId}
					onSeat={async (entry, input) => {
						const result = await floorWaitlist.waitlist.seat(entry, input)
						if (result.ok) {
							const guest = result.value.entry.displayName
							notify(t`Seated ${guest} from the waitlist.`)
							void host.refresh()
						}
						return result
					}}
				/>
			) : null}

			<ConflictPanel
				open={host.conflictPanelOpen}
				onOpenChange={host.setConflictPanelOpen}
				client={host.client}
				conflicts={feed?.conflicts ?? []}
				unassigned={feed?.unassigned ?? []}
				moveNotices={host.allMoveNotices}
				tables={feed?.tables ?? []}
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
