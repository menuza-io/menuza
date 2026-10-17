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
import { Icon, type IconName } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import {
	FloorWaitlistPanel,
	WAITLIST_DRAG_TYPE,
	WaitlistOverbookPrompt,
} from '#app/components/reservations/waitlist/floor-waitlist-panel.tsx'
import { SeatDialog } from '#app/components/reservations/waitlist/seat-dialog.tsx'
import {
	useFloorWaitlist,
	type WaitlistSeatOutcome,
} from '#app/components/reservations/waitlist/use-floor-waitlist.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { useLiveNow } from '#app/hooks/use-live-now.ts'
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
import {
	COURSE_STAGE_LABELS,
	ELEMENT_KIND_LABELS,
	enumLabel,
	RESERVATION_STATUS_LABELS,
} from '#app/utils/reservations/labels.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	createBlock,
	deleteBlock,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'
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

type FloorLiveStatus =
	| 'available'
	| 'reserved_soon'
	| 'arrived_waiting'
	| 'seated'
	| 'dessert_check'
	| 'finishing'
	| 'overtime'
	| 'blocked'

type ComputedTableFloorState = {
	table: RsvTableRecord
	liveStatus: FloorLiveStatus
	statusLabel: string
	statusIcon: IconName
	currentReservation: DayReservationView | null
	nextReservation: DayReservationView | null
	elapsedMin: number | null
	remainingMin: number | null
	timerText: string | null
	isBlocked: boolean
	blockId: string | null
	blockReason: string | null
	sectionId: string | null
	sectionName: string | null
	sectionColorToken: string | null
	serverLabel: string | null
}

type OccupiedDropPromptState = {
	draggedReservation: DayReservationView
	targetTable: RsvTableRecord
	occupantReservation: DayReservationView
}

const COURSE_STAGES = [
	{ id: 'appetizer', label: msg`Appetizer` },
	{ id: 'main', label: msg`Main` },
	{ id: 'dessert', label: msg`Dessert` },
	{ id: 'check', label: msg`Check` },
	{ id: 'bussing', label: msg`Bussing` },
] as const

const HIGH_CONTRAST_SECTION_HEX: Record<string, string> = {
	'1': '#0072B2',
	'2': '#009E73',
	'3': '#E69F00',
	'4': '#CC79A7',
	'5': '#56B4E9',
	'6': '#D55E00',
	'7': '#F0E442',
	'8': '#332288',
}

export default function ReservationsFloorRoute() {
	const { t, i18n } = useLingui()
	const enumText = (
		labels: Record<string, MessageDescriptor>,
		value: string | null | undefined,
	) => enumLabel((d) => i18n._(d), labels, value)
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
	const [actionBanner, setActionBanner] = useState<string | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [busyAction, setBusyAction] = useState(false)
	const [serverDrafts, setServerDrafts] = useState<Record<string, string>>({})
	const [savingServers, setSavingServers] = useState(false)

	// Live clock ticking every 15s without network requests (VAL-HOST-013)
	const liveClock = useLiveNow({
		timeZone: activeLocation?.timezone ?? 'UTC',
		intervalMs: 15_000,
	})
	const nowMs = liveClock.nowMs

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

	// Active section layout for current service (or default layout)
	const activeLayout = useMemo(() => {
		const layouts = feed?.sections ?? []
		if (layouts.length === 0) return null
		if (host.selectedServiceId) {
			const match = layouts.find((l) => l.serviceId === host.selectedServiceId)
			if (match) return match
		}
		return layouts.find((l) => l.isDefault) ?? layouts[0] ?? null
	}, [feed?.sections, host.selectedServiceId])

	// Map sectionId -> serverLabel from day feed sectionAssignments + layout defaults
	const sectionServerMap = useMemo(() => {
		const map = new Map<string, string>()
		if (activeLayout) {
			for (const a of activeLayout.assignments ?? []) {
				if (a.sectionId && a.serverName) {
					map.set(a.sectionId, a.serverName)
				}
			}
		}
		for (const row of feed?.sectionAssignments ?? []) {
			if (row.sectionId && row.serverLabel) {
				map.set(row.sectionId, row.serverLabel)
			}
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

	// Compute current minute of day in location timezone
	const nowLocalMin = useMemo(() => {
		const tz = feed?.timezone ?? activeLocation?.timezone ?? 'UTC'
		try {
			const parts = new Intl.DateTimeFormat('en-GB', {
				timeZone: tz,
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
			}).formatToParts(new Date(nowMs))
			const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
			const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
			return hh * 60 + mm
		} catch {
			const d = new Date(nowMs)
			return d.getUTCHours() * 60 + d.getUTCMinutes()
		}
	}, [nowMs, feed?.timezone, activeLocation?.timezone])

	// Map tableId -> section details
	const tableSectionMap = useMemo(() => {
		const map = new Map<
			string,
			{
				sectionId: string
				sectionName: string
				colorToken: string
				serverLabel: string | null
			}
		>()
		if (!activeLayout) return map
		for (const sec of activeLayout.sections ?? []) {
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

	// Active reservations filtered by service
	const activeReservations = useMemo(() => {
		const list = feed?.reservations ?? []
		return list.filter((r) => {
			if (
				r.status === 'cancelled' ||
				r.status === 'no_show' ||
				r.status === 'completed' ||
				r.status === 'finished'
			) {
				return false
			}
			if (
				host.selectedServiceId &&
				r.serviceId &&
				r.serviceId !== host.selectedServiceId
			) {
				return false
			}
			return true
		})
	}, [feed?.reservations, host.selectedServiceId])

	// Compute live state per table (VAL-HOST-012, VAL-HOST-013)
	const tableStates = useMemo<ComputedTableFloorState[]>(() => {
		const tables = (feed?.tables ?? []).filter(
			(tbl) =>
				tbl.isActive !== false &&
				(!host.areaFilter || tbl.areaId === host.areaFilter),
		)
		const blocks = feed?.blocks ?? []

		return tables.map((table) => {
			const assignedRes = activeReservations
				.filter((r) => r.assignedTableIds.includes(table.id))
				.sort((a, b) => a.localStartMin - b.localStartMin)

			const seatedRes = assignedRes.find((r) => r.status === 'seated') ?? null
			const arrivedRes = assignedRes.find((r) => r.status === 'arrived') ?? null
			const upcomingRes =
				assignedRes.find(
					(r) =>
						r.status === 'booked' ||
						r.status === 'confirmed' ||
						r.status === 'pending_payment' ||
						r.status === 'pending_approval',
				) ?? null

			const currentReservation = seatedRes ?? arrivedRes ?? null
			const nextReservation = seatedRes
				? (arrivedRes ?? upcomingRes)
				: upcomingRes

			const activeBlock = blocks.find((b) => b.tableId === table.id) ?? null
			const isBlocked = Boolean(activeBlock)

			let liveStatus: FloorLiveStatus = 'available'
			let statusLabel = t`Available`
			let statusIcon: IconName = 'check'
			let elapsedMin: number | null = null
			let remainingMin: number | null = null
			let timerText: string | null = null

			if (isBlocked) {
				liveStatus = 'blocked'
				statusLabel = t`Blocked`
				statusIcon = 'ban'
			} else if (seatedRes) {
				const startEpoch =
					seatedRes.seatedAt ??
					(seatedRes.slotStartAt > 0 ? seatedRes.slotStartAt : null)
				if (startEpoch && startEpoch <= nowMs) {
					elapsedMin = Math.max(0, Math.round((nowMs - startEpoch) / 60_000))
				} else {
					elapsedMin = Math.max(0, nowLocalMin - seatedRes.localStartMin)
				}
				const endEpoch =
					seatedRes.slotEndAt > 0
						? seatedRes.slotEndAt
						: startEpoch
							? startEpoch + seatedRes.durationMin * 60_000
							: null
				if (endEpoch) {
					remainingMin = Math.round((endEpoch - nowMs) / 60_000)
				} else {
					remainingMin = seatedRes.durationMin - elapsedMin
				}

				timerText =
					remainingMin < 0
						? `${elapsedMin}m · +${Math.abs(remainingMin)}m over`
						: `${elapsedMin}m · ${remainingMin}m left`

				const stage = seatedRes.courseStage?.toLowerCase() ?? ''
				if (remainingMin < 0) {
					liveStatus = 'overtime'
					statusLabel = t`Overtime`
					statusIcon = 'alert-triangle'
				} else if (remainingMin <= 15) {
					liveStatus = 'finishing'
					statusLabel = t`Finishing (<15m)`
					statusIcon = 'clock'
				} else if (
					stage === 'dessert' ||
					stage === 'check' ||
					stage === 'bussing'
				) {
					liveStatus = 'dessert_check'
					statusLabel =
						stage === 'check'
							? t`Check dropped`
							: stage === 'bussing'
								? t`Bussing`
								: t`Dessert`
					statusIcon = 'tag'
				} else {
					liveStatus = 'seated'
					statusLabel = t`Seated`
					statusIcon = 'users'
				}
			} else if (arrivedRes) {
				liveStatus = 'arrived_waiting'
				statusLabel = t`Arrived / Waiting`
				statusIcon = 'circle-check'
			} else if (upcomingRes) {
				const minsUntil = upcomingRes.localStartMin - nowLocalMin
				if (minsUntil >= -15 && minsUntil <= 30) {
					liveStatus = 'reserved_soon'
					statusLabel = t`Reserved ≤30m`
					statusIcon = 'calendar'
				} else {
					liveStatus = 'available'
					statusLabel = t`Reserved ${upcomingRes.hhmm}`
					statusIcon = 'calendar'
				}
			}

			const secInfo = tableSectionMap.get(table.id)

			return {
				table,
				liveStatus,
				statusLabel,
				statusIcon,
				currentReservation,
				nextReservation,
				elapsedMin,
				remainingMin,
				timerText,
				isBlocked,
				blockId: activeBlock?.id ?? null,
				blockReason: activeBlock?.reason ?? activeBlock?.note ?? null,
				sectionId: secInfo?.sectionId ?? null,
				sectionName: secInfo?.sectionName ?? null,
				sectionColorToken: secInfo?.colorToken ?? null,
				serverLabel:
					secInfo?.serverLabel ??
					currentReservation?.serverLabel ??
					nextReservation?.serverLabel ??
					null,
			}
		})
	}, [
		feed?.tables,
		feed?.blocks,
		host.areaFilter,
		activeReservations,
		nowMs,
		nowLocalMin,
		tableSectionMap,
		t,
	])

	const selectedTableState = useMemo(
		() => tableStates.find((ts) => ts.table.id === selectedTableId) ?? null,
		[tableStates, selectedTableId],
	)

	// Side reservation list
	const sideReservations = useMemo(() => {
		return activeReservations
			.filter((r) => {
				if (host.areaFilter && r.areaId && r.areaId !== host.areaFilter) {
					return false
				}
				if (sideFilter === 'unassigned') {
					return r.assignedTableIds.length === 0
				}
				if (sideFilter === 'arrived') {
					return r.status === 'arrived'
				}
				if (sideFilter === 'upcoming') {
					return r.status === 'booked' || r.status === 'confirmed'
				}
				if (sideFilter === 'seated') {
					return r.status === 'seated'
				}
				return true
			})
			.sort((a, b) => a.localStartMin - b.localStartMin)
	}, [activeReservations, host.areaFilter, sideFilter])

	const handleDropReservationOnTable = async (
		rsv: DayReservationView,
		targetState: ComputedTableFloorState,
	) => {
		if (!canManage) return
		setActionError(null)
		setActionBanner(null)

		// Check if target table is occupied by another reservation right now or overlapping
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
		try {
			if (rsv.status === 'arrived') {
				const seated = await transitionReservationStatus(host.client, rsv.id, {
					to: 'seated',
					tableIds: [targetState.table.id],
					expectedVersion: rsv.version,
				})
				host.handleReservationMutated(seated.reservation, seated.moveNotices)
				setActionBanner(
					t`Seated ${rsv.guestName} at ${targetState.table.label}.`,
				)
			} else {
				const res = await assignReservationTable(host.client, rsv.id, {
					tableIds: [targetState.table.id],
					expectedVersion: rsv.version,
				})
				if (res.moveNotices.length > 0) {
					host.appendMoveNotices(res.moveNotices)
				}
				setActionBanner(
					t`Assigned ${rsv.guestName} to ${targetState.table.label}.`,
				)
			}
			await host.refresh()
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Failed to assign table.`,
			)
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
		setBusyAction(true)
		setActionError(null)
		try {
			if (choice === 'swap') {
				const res = await assignReservationTable(
					host.client,
					draggedReservation.id,
					{
						tableIds: [targetTable.id],
						swapWithReservationId: occupantReservation.id,
						expectedVersion: draggedReservation.version,
					},
				)
				if (res.moveNotices.length > 0) {
					host.appendMoveNotices(res.moveNotices)
				}
				setActionBanner(
					t`Swapped ${draggedReservation.guestName} with ${occupantReservation.guestName} on ${targetTable.label}.`,
				)
			} else if (choice === 'reflow') {
				const res = await assignReservationTable(
					host.client,
					draggedReservation.id,
					{
						tableIds: [targetTable.id],
						reflowLaterParties: true,
						expectedVersion: draggedReservation.version,
					},
				)
				if (res.moveNotices.length > 0) {
					host.appendMoveNotices(res.moveNotices)
				}
				setActionBanner(
					t`Assigned ${draggedReservation.guestName} to ${targetTable.label} and reflowed overlapping parties.`,
				)
			} else {
				const res = await assignReservationTable(
					host.client,
					draggedReservation.id,
					{
						tableIds: [targetTable.id],
						forceOverbook: true,
						reason:
							overbookReason.trim() ||
							`Overbooked onto ${targetTable.label} alongside ${occupantReservation.guestName}`,
						expectedVersion: draggedReservation.version,
					},
				)
				if (res.moveNotices.length > 0) {
					host.appendMoveNotices(res.moveNotices)
				}
				setActionBanner(
					t`Overbooked ${draggedReservation.guestName} onto ${targetTable.label}.`,
				)
			}
			setOccupiedDropPrompt(null)
			await host.refresh()
		} catch (err) {
			setActionError(
				err instanceof Error
					? err.message
					: t`Failed to resolve table conflict.`,
			)
		} finally {
			setBusyAction(false)
		}
	}

	const finishWaitlistSeat = async (outcome: WaitlistSeatOutcome | null) => {
		if (!outcome) return
		if (outcome.ok) {
			const guest = outcome.entry.displayName
			const tableLabel = outcome.table.label
			setActionError(null)
			setActionBanner(t`Seated ${guest} at ${tableLabel} from the waitlist.`)
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
		setActionBanner(null)
		const occupied = Boolean(
			targetState.currentReservation || targetState.isBlocked,
		)
		await finishWaitlistSeat(
			await floorWaitlist.dropOnTable(
				entryId,
				{ id: targetState.table.id, label: targetState.table.label },
				occupied,
			),
		)
	}

	const handleSeatAssignedReservation = async (
		rsv: DayReservationView,
		tableId: string,
	) => {
		if (!canManage) return
		setBusyAction(true)
		setActionError(null)
		try {
			const seated = await transitionReservationStatus(host.client, rsv.id, {
				to: 'seated',
				tableIds: [tableId],
				expectedVersion: rsv.version,
			})
			host.handleReservationMutated(seated.reservation, seated.moveNotices)
			setActionBanner(t`Seated ${rsv.guestName}.`)
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Failed to seat party.`,
			)
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
			setActionBanner(t`Updated course stage to ${stageLabel}.`)
			await host.refresh()
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Failed to update course stage.`,
			)
		} finally {
			setBusyAction(false)
		}
	}

	const handleFinishSeatedReservation = async (rsv: DayReservationView) => {
		if (!canManage) return
		setBusyAction(true)
		setActionError(null)
		try {
			await transitionReservationStatus(host.client, rsv.id, {
				to: 'completed',
				expectedVersion: rsv.version,
			})
			setActionBanner(t`Marked ${rsv.guestName} as finished.`)
			await host.refresh()
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Failed to finish reservation.`,
			)
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
		try {
			if (tableState.isBlocked && tableState.blockId) {
				await deleteBlock(setupClient, locationId, tableState.blockId)
				setActionBanner(t`Unblocked table ${tableState.table.label}.`)
			} else {
				const activeService =
					(feed?.services ?? []).find((s) => s.id === host.selectedServiceId) ??
					(feed?.services ?? [])[0]
				const startMin = Math.max(
					0,
					Math.min(1380, activeService?.startMin ?? nowLocalMin),
				)
				const endMin = Math.max(
					startMin + 30,
					Math.min(1440, activeService?.endMin ?? 1410),
				)
				await createBlock(setupClient, locationId, {
					businessDate: host.selectedDate,
					tableId: tableState.table.id,
					startMin,
					endMin,
					reason: 'maintenance',
					note: `Blocked from Live Floor Plan for rest of service`,
				})
				setActionBanner(
					t`Blocked table ${tableState.table.label} for the rest of the service.`,
				)
			}
			await host.refresh()
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Failed to update table block.`,
			)
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
			const assignments = activeLayout.sections.map((sec) => ({
				sectionId: sec.id,
				serverLabel: serverDrafts[sec.id]?.trim() || null,
			}))
			await saveSectionServerAssignments(host.client, {
				locationId,
				date: host.selectedDate,
				serviceId,
				assignments,
			})
			setActionBanner(t`Saved section server assignments for this service.`)
			await host.refresh()
		} catch (err) {
			setActionError(
				err instanceof Error
					? err.message
					: t`Failed to save section server assignments.`,
			)
		} finally {
			setSavingServers(false)
		}
	}

	const getStatusStyle = (liveStatus: FloorLiveStatus) => {
		if (highContrast) {
			switch (liveStatus) {
				case 'available':
					return 'border-slate-700 bg-slate-900/5 text-foreground dark:border-slate-300 dark:bg-slate-100/10'
				case 'reserved_soon':
					return 'border-[#0072B2] bg-[#0072B2]/15 text-foreground ring-2 ring-[#0072B2]/40'
				case 'arrived_waiting':
					return 'border-[#E69F00] bg-[#E69F00]/20 text-foreground ring-2 ring-[#E69F00]/50'
				case 'seated':
					return 'border-[#009E73] bg-[#009E73]/20 text-foreground'
				case 'dessert_check':
					return 'border-[#CC79A7] bg-[#CC79A7]/20 text-foreground'
				case 'finishing':
					return 'border-[#56B4E9] bg-[#56B4E9]/25 text-foreground ring-2 ring-[#56B4E9]/50'
				case 'overtime':
					return 'border-[#D55E00] bg-[#D55E00]/25 text-foreground ring-2 ring-[#D55E00]/60'
				case 'blocked':
					return 'border-dashed border-slate-600 bg-slate-500/25 text-muted-foreground'
			}
		}

		switch (liveStatus) {
			case 'available':
				return 'border-emerald-500/40 bg-emerald-500/10 text-foreground'
			case 'reserved_soon':
				return 'border-sky-500/50 bg-sky-500/15 text-foreground'
			case 'arrived_waiting':
				return 'border-amber-500/60 bg-amber-500/20 text-foreground ring-2 ring-amber-500/30'
			case 'seated':
				return 'border-indigo-500/60 bg-indigo-500/15 text-foreground'
			case 'dessert_check':
				return 'border-purple-500/60 bg-purple-500/15 text-foreground'
			case 'finishing':
				return 'border-teal-500/60 bg-teal-500/20 text-foreground'
			case 'overtime':
				return 'border-destructive bg-destructive/15 text-foreground ring-2 ring-destructive/40'
			case 'blocked':
				return 'border-dashed border-muted-foreground/50 bg-muted/60 text-muted-foreground'
		}
	}

	const getSectionColor = (token: string | null) => {
		if (!token) return '#64748b'
		if (highContrast && HIGH_CONTRAST_SECTION_HEX[token]) {
			return HIGH_CONTRAST_SECTION_HEX[token]!
		}
		return resolveSectionColorHex(token)
	}

	const formatShortGuestName = (fullName: string) => {
		const parts = fullName.trim().split(/\s+/)
		if (parts.length <= 1) return fullName
		return `${parts[0]} ${parts[parts.length - 1]?.[0] ?? ''}.`
	}

	const elements = feed?.elements ?? feed?.floorElements ?? []

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
				serviceNotes={feed?.serviceNotes ?? []}
			/>

			{actionBanner ? (
				<Alert data-testid="floor-action-banner">
					<AlertDescription>
						<div className="flex items-center justify-between gap-2">
							<span>{actionBanner}</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setActionBanner(null)}
							>
								<Trans>Dismiss</Trans>
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
					className="border-amber-500 bg-amber-500/10 p-4"
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
								variant="outline"
								disabled={busyAction}
								data-testid="floor-occupied-choice-swap"
								onClick={() => handleResolveOccupiedDrop('swap')}
							>
								<Icon name="refresh-cw" className="mr-1.5 size-3.5" />
								<Trans>Swap tables</Trans>
							</Button>

							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busyAction}
								data-testid="floor-occupied-choice-reflow"
								onClick={() => handleResolveOccupiedDrop('reflow')}
							>
								<Icon name="route" className="mr-1.5 size-3.5" />
								<Trans>Reflow later parties</Trans>
							</Button>

							<div className="flex items-center gap-1.5">
								<Input
									value={overbookReason}
									onChange={(e) => setOverbookReason(e.target.value)}
									placeholder={t`Overbook reason (optional)`}
									className="h-8 w-48 text-xs"
									data-testid="floor-occupied-overbook-reason"
								/>
								<Button
									type="button"
									size="sm"
									variant="default"
									disabled={busyAction}
									data-testid="floor-occupied-choice-overbook"
									onClick={() => handleResolveOccupiedDrop('overbook')}
								>
									<Icon name="alert-triangle" className="mr-1.5 size-3.5" />
									<Trans>Overbook table</Trans>
								</Button>
							</div>
						</div>
					</div>
				</Card>
			) : null}

			{floorWaitlist.prompt ? (
				<WaitlistOverbookPrompt
					prompt={floorWaitlist.prompt}
					busy={floorWaitlist.waitlist.busyId !== null}
					onOverbook={(reason) =>
						void floorWaitlist.resolveOverbook(reason).then(finishWaitlistSeat)
					}
					onCancel={floorWaitlist.cancelPrompt}
				/>
			) : null}

			{/* Toolbar: Area tabs, Section overlay toggle, High-contrast toggle, Status legend */}
			<div className="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
				<div className="flex flex-wrap items-center gap-1.5">
					<Button
						type="button"
						size="sm"
						variant={host.areaFilter === null ? 'default' : 'outline'}
						onClick={() => host.setAreaFilter(null)}
						data-testid="floor-area-all"
					>
						<Trans>All areas</Trans>
					</Button>
					{(feed?.areas ?? []).map((area) => (
						<Button
							key={area.id}
							type="button"
							size="sm"
							variant={host.areaFilter === area.id ? 'default' : 'outline'}
							onClick={() => host.setAreaFilter(area.id)}
							data-testid={`floor-area-${area.id}`}
						>
							{area.name}
						</Button>
					))}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant={sectionOverlay ? 'default' : 'outline'}
						onClick={() => setSectionOverlay((v) => !v)}
						data-testid="floor-section-overlay-toggle"
					>
						<Icon name="blocks" className="mr-1.5 size-4" />
						<Trans>Section overlay</Trans>
					</Button>

					<Button
						type="button"
						size="sm"
						variant={highContrast ? 'default' : 'outline'}
						onClick={() => setHighContrast((v) => !v)}
						data-testid="floor-high-contrast-toggle"
					>
						<Icon name="sun" className="mr-1.5 size-4" />
						<Trans>High contrast</Trans>
					</Button>

					<Badge
						variant="outline"
						className="text-xs"
						data-testid="floor-poll-badge"
					>
						<Icon name="refresh-cw" className="mr-1 size-3" />
						{draggingRsvId || occupiedDropPrompt || floorWaitlist.busyUi ? (
							<Trans>Polling paused</Trans>
						) : (
							<Trans>Live 5s ETag</Trans>
						)}
					</Badge>
				</div>
			</div>

			{/* Status color & icon legend (VAL-HOST-012, VAL-HOST-020) */}
			<div
				className="flex flex-wrap items-center gap-2 text-xs"
				data-testid="floor-status-legend"
			>
				<span className="text-muted-foreground font-medium">
					<Trans>Status legend:</Trans>
				</span>
				<Badge variant="outline" className="gap-1">
					<Icon name="check" className="size-3 text-emerald-600" />
					<Trans>Available</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="calendar" className="text-chart-5 size-3" />
					<Trans>Reserved ≤30m</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="circle-check" className="size-3 text-amber-600" />
					<Trans>Arrived</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="users" className="text-chart-2 size-3" />
					<Trans>Seated</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="tag" className="text-chart-4 size-3" />
					<Trans>Dessert / Check</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="clock" className="text-chart-3 size-3" />
					<Trans>Finishing (&lt;15m)</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="alert-triangle" className="text-destructive size-3" />
					<Trans>Overtime</Trans>
				</Badge>
				<Badge variant="outline" className="gap-1">
					<Icon name="ban" className="text-muted-foreground size-3" />
					<Trans>Blocked</Trans>
				</Badge>
			</div>

			{/* Section Overlay Legend & Server Assignment Bar (VAL-HOST-016) */}
			{sectionOverlay ? (
				<Card data-testid="floor-section-legend">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-sm font-semibold">
								<Trans>Section Overlay & Server Assignments</Trans>
								{activeLayout ? ` — ${activeLayout.name}` : ''}
							</CardTitle>
							{canManage && activeLayout ? (
								<Button
									type="button"
									size="sm"
									disabled={savingServers}
									data-testid="floor-section-save-servers"
									onClick={handleSaveSectionServers}
								>
									<Icon name="check" className="mr-1.5 size-3.5" />
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
									const colorHex = getSectionColor(sec.colorToken)
									return (
										<div
											key={sec.id}
											className="border-border flex flex-col gap-2 rounded-lg border p-2.5"
											data-testid={`floor-section-card-${sec.id}`}
										>
											<div className="flex items-center justify-between gap-2">
												<div className="flex items-center gap-2">
													<span
														className="inline-block size-3.5 rounded-full border"
														style={{ backgroundColor: colorHex }}
													/>
													<span className="text-sm font-medium">
														{sec.name}
													</span>
												</div>
												<Badge variant="secondary" className="text-xs">
													{secTables.length} {t`tables`} · {seatedCovers}{' '}
													{t`covers`}
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
													className="h-7 text-xs"
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

			{/* Main 2-column layout: Floor Plan Canvas + Side Reservation List & Quick Actions */}
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
				{/* Floor Plan Canvas (8 cols on lg / 1024px iPad landscape) */}
				<div className="lg:col-span-8">
					<Card className="overflow-hidden">
						<div
							className="bg-muted/20 relative min-h-[540px] w-full overflow-auto p-4"
							dir="ltr"
							data-testid="floor-plan-canvas"
						>
							<div
								className="relative mx-auto"
								style={{ width: 920, height: 600 }}
								data-testid="floor-plan-stage"
							>
								{/* Architectural floor elements (VAL-HOST-012) */}
								{elements.map((el) => {
									const x = Number(el.x ?? el.posX ?? 0)
									const y = Number(el.y ?? el.posY ?? 0)
									const width = Math.max(24, Number(el.width ?? el.w ?? 100))
									const height = Math.max(16, Number(el.height ?? el.h ?? 32))
									const rotation = Number(el.rotation ?? el.rotDeg ?? 0)
									return (
										<div
											key={el.id}
											data-testid={`floor-element-${el.id}`}
											data-element-kind={el.kind}
											className="border-border/70 bg-muted/60 text-muted-foreground pointer-events-none absolute flex items-center justify-center rounded border px-1.5 text-[10px] font-medium tracking-wider uppercase"
											style={{
												left: x,
												top: y,
												width,
												height,
												transform: rotation
													? `rotate(${rotation}deg)`
													: undefined,
											}}
										>
											{el.label || enumText(ELEMENT_KIND_LABELS, el.kind)}
										</div>
									)
								})}

								{/* Tables on the floor canvas */}
								{tableStates.map((ts, index) => {
									const {
										table,
										liveStatus,
										currentReservation,
										nextReservation,
									} = ts
									const rawX = Number(table.x ?? table.posX ?? 0)
									const rawY = Number(table.y ?? table.posY ?? 0)
									// Fallback grid position if coordinates are 0,0 for multiple tables
									const fallbackCol = index % 4
									const fallbackRow = Math.floor(index / 4)
									const x =
										rawX > 0 || index === 0 ? rawX : 40 + fallbackCol * 210
									const y =
										rawY > 0 || index === 0 ? rawY : 40 + fallbackRow * 145
									const width = Math.max(
										96,
										Number(table.width ?? table.w ?? 120),
									)
									const height = Math.max(
										84,
										Number(table.height ?? table.h ?? 96),
									)
									const rotation = Number(table.rotation ?? table.rotDeg ?? 0)
									const isRound = table.shape === 'round'
									const isSelected = selectedTableId === table.id
									const isDragOver = dragOverTableId === table.id
									const sectionColor = sectionOverlay
										? getSectionColor(ts.sectionColorToken)
										: null
									const activeParty = currentReservation ?? nextReservation

									return (
										<button
											key={table.id}
											type="button"
											data-testid={`floor-table-${table.id}`}
											data-table-label={table.label}
											data-live-status={liveStatus}
											data-section-id={ts.sectionId ?? ''}
											onClick={() =>
												setSelectedTableId((prev) =>
													prev === table.id ? null : table.id,
												)
											}
											onDragOver={(e) => {
												if (!canManage) return
												e.preventDefault()
												setDragOverTableId(table.id)
											}}
											onDragLeave={() => {
												if (dragOverTableId === table.id) {
													setDragOverTableId(null)
												}
											}}
											onDrop={(e) => {
												e.preventDefault()
												setDragOverTableId(null)
												const waitlistId =
													e.dataTransfer.getData(WAITLIST_DRAG_TYPE) ||
													floorWaitlist.draggingId
												if (waitlistId) {
													floorWaitlist.setDraggingId(null)
													void handleDropWaitlistOnTable(waitlistId, ts)
													return
												}
												const rsvId =
													e.dataTransfer.getData('text/reservation-id') ||
													draggingRsvId
												setDraggingRsvId(null)
												if (!rsvId) return
												const rsv = feed?.reservations.find(
													(r) => r.id === rsvId,
												)
												if (rsv) {
													void handleDropReservationOnTable(rsv, ts)
												}
											}}
											className={cn(
												'absolute flex flex-col justify-between border-2 p-2 text-left shadow-xs transition-all focus-visible:ring-2 focus-visible:outline-none',
												isRound ? 'rounded-full px-3 py-2.5' : 'rounded-xl',
												getStatusStyle(liveStatus),
												isSelected && 'ring-primary ring-2 ring-offset-2',
												sectionColor && !isSelected && 'ring-primary/40 ring-1',
												isDragOver &&
													'border-primary bg-primary/15 scale-105 ring-2',
											)}
											style={{
												left: x,
												top: y,
												width,
												height,
												transform: rotation
													? `rotate(${rotation}deg)`
													: undefined,
											}}
										>
											{/* Top row: Table label, capacity, status icon */}
											<div className="flex w-full items-center justify-between gap-1">
												<span className="truncate text-xs font-bold">
													{table.label}
												</span>
												<span className="text-muted-foreground flex items-center gap-0.5 text-[10px] font-medium">
													<Icon name={ts.statusIcon} className="size-3" />
													{table.minCovers}-{table.maxCovers}p
												</span>
											</div>

											{/* Middle row: Guest short name + party size + course badge (VAL-HOST-013) */}
											{activeParty ? (
												<div className="my-0.5 flex flex-col gap-0.5 overflow-hidden">
													<div className="flex items-center justify-between gap-1">
														<span
															className="truncate text-xs font-semibold"
															data-testid={`floor-table-guest-${table.id}`}
														>
															{formatShortGuestName(activeParty.guestName)}
														</span>
														<Badge
															variant="secondary"
															className="h-4 px-1 text-[10px]"
															data-testid={`floor-table-party-size-${table.id}`}
														>
															{activeParty.partySize}p
														</Badge>
													</div>
													{activeParty.courseStage ? (
														<span
															className="bg-background/80 inline-flex w-fit items-center rounded px-1 py-0.5 text-[10px] font-medium capitalize"
															data-testid={`floor-table-course-${table.id}`}
														>
															{enumText(
																COURSE_STAGE_LABELS,
																activeParty.courseStage,
															)}
														</span>
													) : null}
												</div>
											) : (
												<div className="text-muted-foreground my-0.5 truncate text-[11px]">
													{ts.statusLabel}
												</div>
											)}

											{/* Bottom row: Elapsed/remaining timer or section badge (VAL-HOST-013, VAL-HOST-016) */}
											<div className="flex w-full items-center justify-between gap-1">
												{ts.timerText ? (
													<span
														className={cn(
															'truncate rounded px-1 py-0.5 font-mono text-[10px] font-semibold',
															liveStatus === 'overtime'
																? 'bg-destructive/20 text-destructive'
																: liveStatus === 'finishing'
																	? 'bg-chart-3/20 text-foreground'
																	: 'bg-background/70 text-foreground',
														)}
														data-testid={`floor-table-timer-${table.id}`}
													>
														{ts.timerText}
													</span>
												) : (
													<span
														className="truncate text-[10px] font-medium"
														data-testid={`floor-table-status-text-${table.id}`}
													>
														{ts.statusLabel}
													</span>
												)}

												{sectionOverlay && ts.sectionName ? (
													<span
														className="truncate rounded px-1 py-0.5 text-[9px] font-semibold text-white"
														style={{
															backgroundColor: sectionColor ?? '#3b82f6',
														}}
														data-testid={`floor-table-section-badge-${table.id}`}
													>
														{ts.sectionName}
													</span>
												) : null}
											</div>
										</button>
									)
								})}
							</div>
						</div>
					</Card>
				</div>

				{/* Right column: Selected Table Quick Actions + Draggable Side Reservation List (4 cols) */}
				<div className="flex flex-col gap-4 lg:col-span-4">
					{/* Selected Table Quick Actions (VAL-HOST-015) */}
					{selectedTableState ? (
						<Card data-testid="floor-table-quick-actions">
							<CardHeader className="pb-2">
								<div className="flex items-center justify-between gap-2">
									<div>
										<CardTitle className="text-sm font-semibold">
											{selectedTableState.table.label} ·{' '}
											{selectedTableState.table.minCovers}-
											{selectedTableState.table.maxCovers} <Trans>covers</Trans>
										</CardTitle>
										<p className="text-muted-foreground text-xs">
											{selectedTableState.statusLabel}
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
										size="sm"
										variant="ghost"
										onClick={() => setSelectedTableId(null)}
									>
										<Icon name="x" className="size-4" />
									</Button>
								</div>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{/* Current / Next Reservation info & actions */}
								{selectedTableState.currentReservation ? (
									<div className="border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-2.5">
										<div className="flex items-center justify-between gap-2">
											<div>
												<p className="text-xs font-semibold">
													{selectedTableState.currentReservation.guestName} (
													{selectedTableState.currentReservation.partySize}p)
												</p>
												<p className="text-muted-foreground text-[11px]">
													{selectedTableState.currentReservation.hhmm} –{' '}
													{selectedTableState.currentReservation.endHhmm} ·{' '}
													{enumText(
														RESERVATION_STATUS_LABELS,
														selectedTableState.currentReservation.status,
													)}
												</p>
											</div>
											<Button
												type="button"
												size="sm"
												variant="outline"
												data-testid="floor-action-open-detail"
												onClick={() =>
													host.openReservationDetail(
														selectedTableState.currentReservation!.id,
													)
												}
											>
												<Trans>Detail sheet</Trans>
											</Button>
										</div>

										{canManage &&
										selectedTableState.currentReservation.status ===
											'arrived' ? (
											<Button
												type="button"
												size="sm"
												disabled={busyAction}
												data-testid="floor-action-seat-assigned"
												onClick={() =>
													handleSeatAssignedReservation(
														selectedTableState.currentReservation!,
														selectedTableState.table.id,
													)
												}
											>
												<Icon name="users" className="mr-1.5 size-3.5" />
												<Trans>Seat arrived party now</Trans>
											</Button>
										) : null}

										{/* Course stage buttons for seated reservation */}
										{canManage &&
										selectedTableState.currentReservation.status ===
											'seated' ? (
											<div className="flex flex-col gap-1.5">
												<span className="text-muted-foreground text-[11px] font-medium">
													<Trans>Course stage:</Trans>
												</span>
												<div className="flex flex-wrap gap-1">
													{COURSE_STAGES.map((stage) => (
														<Button
															key={stage.id}
															type="button"
															size="sm"
															variant={
																selectedTableState.currentReservation
																	?.courseStage === stage.id
																	? 'default'
																	: 'outline'
															}
															disabled={busyAction}
															className="h-7 px-2 text-xs"
															data-testid={`floor-action-course-${stage.id}`}
															onClick={() =>
																handleCourseUpdate(
																	selectedTableState.currentReservation!,
																	stage.id,
																)
															}
														>
															{i18n._(stage.label)}
														</Button>
													))}
												</div>
												<Button
													type="button"
													size="sm"
													variant="secondary"
													disabled={busyAction}
													data-testid="floor-action-finish"
													onClick={() =>
														handleFinishSeatedReservation(
															selectedTableState.currentReservation!,
														)
													}
												>
													<Icon name="check" className="mr-1.5 size-3.5" />
													<Trans>Finish & clear table</Trans>
												</Button>
											</div>
										) : null}
									</div>
								) : selectedTableState.nextReservation ? (
									<div className="border-border bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5">
										<div>
											<p className="text-xs font-semibold">
												<Trans>Next:</Trans>{' '}
												{selectedTableState.nextReservation.guestName} (
												{selectedTableState.nextReservation.partySize}p at{' '}
												{selectedTableState.nextReservation.hhmm})
											</p>
										</div>
										<div className="flex items-center gap-1">
											{canManage ? (
												<Button
													type="button"
													size="sm"
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
												data-testid="floor-action-open-detail"
												onClick={() =>
													host.openReservationDetail(
														selectedTableState.nextReservation!.id,
													)
												}
											>
												<Trans>Detail</Trans>
											</Button>
										</div>
									</div>
								) : null}

								{/* Walk-in & Block table buttons */}
								{canManage ? (
									<div className="flex flex-wrap gap-2">
										<Button
											type="button"
											size="sm"
											variant="default"
											disabled={selectedTableState.isBlocked || busyAction}
											data-testid="floor-action-walk-in"
											onClick={() => {
												setWalkInTableIds([selectedTableState.table.id])
												host.setWalkInOpen(true)
											}}
										>
											<Icon name="user-plus" className="mr-1.5 size-3.5" />
											<Trans>
												Seat walk-in at {selectedTableState.table.label}
											</Trans>
										</Button>

										<Button
											type="button"
											size="sm"
											variant={
												selectedTableState.isBlocked ? 'secondary' : 'outline'
											}
											disabled={busyAction}
											data-testid="floor-action-block-table"
											onClick={() =>
												handleBlockTableForService(selectedTableState)
											}
										>
											<Icon name="ban" className="mr-1.5 size-3.5" />
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
								setActionBanner(null)
								void floorWaitlist
									.dropOnTable(
										entry.id,
										table,
										Boolean(
											selectedTableState?.currentReservation ||
											selectedTableState?.isBlocked,
										),
									)
									.then(finishWaitlistSeat)
							}}
							onChooseTable={(entry) => floorWaitlist.setSeatDialogId(entry.id)}
						/>
					) : null}

					{/* Side Reservation List (VAL-HOST-014) */}
					<Card
						className="flex flex-col"
						data-testid="floor-side-reservation-list"
					>
						<CardHeader className="pb-2">
							<div className="flex items-center justify-between gap-2">
								<CardTitle className="text-sm font-semibold">
									<Trans>Parties ({sideReservations.length})</Trans>
								</CardTitle>
								<span className="text-muted-foreground text-[11px]">
									<Trans>Drag onto table to seat/assign</Trans>
								</span>
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
										variant={sideFilter === tab.id ? 'default' : 'outline'}
										className="h-7 px-2 text-xs"
										data-testid={`floor-side-filter-${tab.id}`}
										onClick={() => setSideFilter(tab.id)}
									>
										{tab.label}
									</Button>
								))}
							</div>
						</CardHeader>
						<CardContent className="flex max-h-[460px] flex-col gap-2 overflow-y-auto">
							{sideReservations.length === 0 ? (
								<p className="text-muted-foreground py-6 text-center text-xs">
									<Trans>No parties match this filter.</Trans>
								</p>
							) : (
								sideReservations.map((rsv) => (
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
											<button
												type="button"
												onClick={() => host.openReservationDetail(rsv.id)}
												className="truncate text-left text-xs font-semibold hover:underline"
											>
												{rsv.hhmm} · {rsv.guestName} ({rsv.partySize}p)
											</button>
											<Badge variant="outline" className="text-[10px]">
												{enumText(RESERVATION_STATUS_LABELS, rsv.status)}
											</Badge>
										</div>

										<div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
											<span className="text-muted-foreground">
												{rsv.assignedTableLabels.length > 0
													? rsv.assignedTableLabels.join(', ')
													: t`Unassigned`}
											</span>

											{canManage && selectedTableState ? (
												<Button
													type="button"
													size="sm"
													variant="secondary"
													className="h-6 px-2 text-[11px]"
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
										</div>
									</div>
								))
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
							setActionError(null)
							setActionBanner(t`Seated ${guest} from the waitlist.`)
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
