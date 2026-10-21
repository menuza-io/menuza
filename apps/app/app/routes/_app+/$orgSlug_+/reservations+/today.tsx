import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router'
import { KanbanColumn } from '#app/components/kanban/kanban.tsx'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { countAllergyParties } from '#app/components/reservations/guest-flags.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import {
	RequestsPanel,
	RequestsNotice,
	type ReservationsViewTab,
} from '#app/components/reservations/requests-panel.tsx'
import { TodayPartyCard } from '#app/components/reservations/today-party-card.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { useReservationRequests } from '#app/components/reservations/use-reservation-requests.ts'
import { TodayWaitlistCard } from '#app/components/reservations/waitlist/today-waitlist-card.tsx'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { boardGridClass } from '#app/utils/reservations/board-layout.ts'
import {
	markReservationRunningLate,
	type DayReservationView,
	transitionReservationStatus,
	undoReservationTransition,
} from '#app/utils/reservations/book-api.ts'
import { formatBusinessDate } from '#app/utils/reservations/business-date.ts'
import {
	allergyCountLabel,
	coversAndPartiesLabel,
	finishedCountLabel,
	seatedCoversLabel,
} from '#app/utils/reservations/count-labels.ts'
import {
	boardColumnFor,
	type HostAction,
} from '#app/utils/reservations/host-actions.ts'
import {
	hostErrorMessage,
	hostLoadErrorMessage,
} from '#app/utils/reservations/host-errors.ts'
import {
	RESERVATION_STATUS_LABELS,
	enumLabel,
} from '#app/utils/reservations/labels.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/today.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.today,
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

const UNDO_WINDOW_MS = 60_000

/** Added to each board column; on phones the columns snap-scroll sideways. */
const BOARD_COLUMN = 'max-md:w-[88%] max-md:shrink-0 max-md:snap-start'

/**
 * The day in one quiet line: covers and parties always, then only the items
 * that have something to say. Not drawn at all on an empty day.
 */
function DaySummary({
	covers,
	parties,
	nextArrival,
	seatedCovers,
	allergies,
}: {
	covers: number
	parties: number
	nextArrival: string | null
	seatedCovers: number
	allergies: number
}) {
	const { t } = useLingui()
	const items: Array<{
		key: string
		testId: string
		text: string
		destructive?: boolean
	}> = [
		{
			key: 'covers',
			testId: 'today-kpi-total-covers',
			text: coversAndPartiesLabel(covers, parties),
		},
	]
	if (nextArrival) {
		items.push({
			key: 'next',
			testId: 'today-kpi-next-arrival',
			text: t`Next arrival ${nextArrival}`,
		})
	}
	if (seatedCovers > 0) {
		items.push({
			key: 'seated',
			testId: 'today-kpi-seated-covers',
			text: seatedCoversLabel(seatedCovers),
		})
	}
	if (allergies > 0) {
		items.push({
			key: 'allergies',
			testId: 'today-kpi-allergies',
			text: allergyCountLabel(allergies),
			destructive: true,
		})
	}
	return (
		<div
			role="group"
			aria-label={t`Day summary`}
			className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums"
			data-testid="today-kpi-cards"
		>
			{items.map((item, index) => (
				<Fragment key={item.key}>
					{index > 0 ? (
						<span aria-hidden className="bg-border h-3.5 w-px" />
					) : null}
					<span
						className={
							item.destructive
								? 'text-destructive font-medium'
								: index === 0
									? 'text-foreground font-medium'
									: undefined
						}
						data-testid={item.testId}
					>
						{item.text}
					</span>
				</Fragment>
			))}
		</div>
	)
}

function BoardSkeleton() {
	return (
		<div
			className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4"
			data-testid="today-board-skeleton"
			aria-busy="true"
		>
			{[0, 1, 2, 3].map((col) => (
				<div
					key={col}
					className="bg-muted/30 flex flex-col gap-2 rounded-lg p-2 shadow-xs"
				>
					<Skeleton className="m-1 h-5 w-24" />
					<div className="flex flex-col gap-2 p-1">
						<Skeleton className="h-24" />
						<Skeleton className="h-24" />
					</div>
				</div>
			))}
		</div>
	)
}

export default function ReservationsTodayRoute() {
	const { t, i18n } = useLingui()
	const tx = (d: MessageDescriptor) => i18n._(d)
	const { orgSlug, canManage, waitlistEnabled } = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]
	const locationId = activeLocation?.id ?? ''

	const host = useHostStand({
		orgSlug,
		locationId,
		defaultTimeZone: activeLocation?.timezone ?? 'UTC',
		pollIntervalMs: 5_000,
	})

	const [view, setView] = useState<ReservationsViewTab>('reservations')
	const [actionBusyId, setActionBusyId] = useState<string | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [showFinished, setShowFinished] = useState(false)
	const [lastUndo, setLastUndo] = useState<{
		reservationId: string
		guestName: string
		status: string
		undoToken: string | null
	} | null>(null)

	const lastUndoStatusLabel = enumLabel(
		tx,
		RESERVATION_STATUS_LABELS,
		lastUndo?.status,
	)

	const dayFeed = host.dayFeed
	const stats = dayFeed?.stats
	const reservations = useMemo(
		() => dayFeed?.reservations ?? [],
		[dayFeed?.reservations],
	)
	const reservationsRef = useRef(reservations)
	reservationsRef.current = reservations
	const requests = useReservationRequests({
		client: host.client,
		locationId,
		reservations,
		onMutated: host.handleReservationMutated,
	})

	// The undo belongs to one day and location, and lapses after a minute.
	useEffect(() => {
		setLastUndo(null)
	}, [host.businessDate, locationId])
	useEffect(() => {
		if (!lastUndo) return
		const id = window.setTimeout(() => setLastUndo(null), UNDO_WINDOW_MS)
		return () => window.clearTimeout(id)
	}, [lastUndo])

	const columns = useMemo(() => {
		const upcoming = []
		const seated = []
		const finished = []
		for (const r of reservations) {
			const column = boardColumnFor(r.status)
			if (column === 'upcoming') upcoming.push(r)
			else if (column === 'seated') seated.push(r)
			else if (column === 'finished') finished.push(r)
		}
		return { upcoming, seated, finished }
	}, [reservations])

	const findVersion = (id: string) =>
		reservationsRef.current.find((r) => r.id === id)?.version

	const handleAction = async (rsv: DayReservationView, action: HostAction) => {
		if (!action.to) {
			host.openDetail(rsv.id)
			return
		}
		const to = action.to
		setActionBusyId(rsv.id)
		setActionError(null)
		try {
			const version = findVersion(rsv.id)
			const res = await transitionReservationStatus(host.client, rsv.id, {
				to,
				...(version ? { expectedVersion: version } : {}),
			})
			setLastUndo({
				reservationId: rsv.id,
				guestName: rsv.guestName || t`Guest`,
				status: to,
				undoToken: res.undoToken,
			})
			host.handleReservationMutated(res.reservation, res.moveNotices)
		} catch (err) {
			setActionError(
				hostErrorMessage(err, tx, msg`Could not update the status.`),
			)
			void host.refresh()
		} finally {
			setActionBusyId(null)
		}
	}

	const handleQuickUndo = async () => {
		if (!lastUndo) return
		setActionBusyId(lastUndo.reservationId)
		setActionError(null)
		try {
			const res = await undoReservationTransition(
				host.client,
				lastUndo.reservationId,
				lastUndo.undoToken,
				findVersion(lastUndo.reservationId),
			)
			setLastUndo(null)
			host.handleReservationMutated(res.reservation, [])
		} catch (err) {
			setActionError(hostErrorMessage(err, tx, msg`Could not undo.`))
			void host.refresh()
		} finally {
			setActionBusyId(null)
		}
	}

	const handleQuickLate = async (rsv: DayReservationView, minutes: number) => {
		setActionBusyId(rsv.id)
		setActionError(null)
		try {
			const res = await markReservationRunningLate(
				host.client,
				rsv.id,
				minutes,
				true,
				findVersion(rsv.id),
			)
			host.handleReservationMutated(res.reservation, res.moveNotices)
		} catch (err) {
			setActionError(
				hostErrorMessage(
					err,
					tx,
					msg`Could not mark the party as running late.`,
				),
			)
			void host.refresh()
		} finally {
			setActionBusyId(null)
		}
	}

	const loadFailure =
		host.poll.error && !dayFeed
			? hostLoadErrorMessage(
					{ status: host.poll.errorStatus, code: host.poll.errorCode },
					tx,
				)
			: null
	const loading = !dayFeed && host.poll.loading
	const waitlistCount = (dayFeed?.waitlist ?? []).length
	const allergyCount = useMemo(
		() => countAllergyParties(reservations),
		[reservations],
	)
	const nextArrival = useMemo(() => {
		const floor = host.liveNow.nowMs - 15 * 60_000
		let next: DayReservationView | null = null
		for (const r of columns.upcoming) {
			if (r.slotStartAt < floor) continue
			if (!next || r.slotStartAt < next.slotStartAt) next = r
		}
		return next
	}, [columns.upcoming, host.liveNow.nowMs])
	const finishedExpanded = columns.finished.length > 0 && showFinished
	const dayIsEmpty =
		Boolean(dayFeed) && reservations.length === 0 && waitlistCount === 0
	const emptyDayLabel = formatBusinessDate(host.businessDate, i18n.locale, {
		weekday: 'long',
		month: 'short',
		day: 'numeric',
	})
	const cardProps = {
		canManage,
		nowMs: host.liveNow.nowMs,
		onOpenDetail: host.openDetail,
		onAction: handleAction,
		onRunningLate: handleQuickLate,
	}

	return (
		<div className="flex flex-col gap-4" data-testid="reservations-today-view">
			<HostSubnav
				orgSlug={orgSlug}
				activeView="today"
				businessDate={host.businessDate}
				todayDate={host.todayDate}
				onDateChange={host.setDate}
				services={dayFeed?.services ?? []}
				selectedServiceId={host.selectedServiceId}
				onServiceChange={host.setServiceId}
				areas={dayFeed?.areas ?? []}
				selectedAreaId={host.selectedAreaId}
				onAreaChange={host.setAreaId}
				unassignedCount={dayFeed?.unassigned.length ?? 0}
				conflictCount={dayFeed?.conflicts.length ?? 0}
				moveNoticeCount={host.allMoveNotices.length}
				onOpenBookingSheet={() => host.openBookingSheet()}
				onOpenWalkIn={() => host.openWalkIn()}
				onOpenConflictPanel={() => host.setConflictPanelOpen(true)}
				canManage={canManage}
				refreshing={host.poll.refreshing}
				onRefresh={() => void host.poll.refresh({ force: true })}
				serviceNotes={dayFeed?.serviceNotes ?? []}
				lastUpdatedAt={host.poll.lastUpdatedAt}
			/>

			{loadFailure || actionError || requests.error ? (
				<Alert variant="destructive" data-testid="today-error-banner">
					<AlertDescription>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span>{actionError ?? requests.error ?? loadFailure}</span>
							{loadFailure && !host.poll.accessDenied ? (
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="h-8 max-md:h-11 pointer-coarse:h-11"
									onClick={() => void host.poll.refresh({ force: true })}
								>
									<Trans>Try again</Trans>
								</Button>
							) : null}
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			<RequestsNotice
				value={view}
				onValueChange={setView}
				pendingCount={requests.pending.length}
			/>

			{view === 'reservations' && dayFeed && !dayIsEmpty ? (
				<DaySummary
					covers={stats?.totalCovers ?? 0}
					parties={stats?.totalParties ?? 0}
					nextArrival={nextArrival?.hhmm ?? null}
					seatedCovers={stats?.seatedCovers ?? 0}
					allergies={allergyCount}
				/>
			) : null}

			{view === 'requests' ? (
				<RequestsPanel
					requests={requests.pending}
					decided={requests.decided}
					canManage={canManage}
					busyId={requests.busyId}
					onApprove={requests.approve}
					onDecline={requests.decline}
					onOpenDetail={host.openDetail}
				/>
			) : (
				<>
					{loading ? (
						<BoardSkeleton />
					) : dayIsEmpty ? (
						<p
							className="text-muted-foreground py-10 text-center text-sm"
							data-testid="today-empty"
						>
							<Trans>No bookings for {emptyDayLabel}</Trans>
						</p>
					) : (
						<div
							className={boardGridClass({
								waitlistEnabled,
								finishedOpen: finishedExpanded,
							})}
							data-testid="today-board"
							data-finished-open={finishedExpanded}
						>
							<KanbanColumn
								className={BOARD_COLUMN}
								title={<Trans>Upcoming & arriving</Trans>}
								count={columns.upcoming.length}
								empty={
									<>
										<Icon name="calendar" className="size-4" />
										<Trans>No upcoming reservations for this filter.</Trans>
									</>
								}
							>
								{columns.upcoming.map((rsv) => (
									<TodayPartyCard
										key={rsv.id}
										reservation={rsv}
										kind="upcoming"
										busy={actionBusyId === rsv.id}
										{...cardProps}
									/>
								))}
							</KanbanColumn>

							<KanbanColumn
								className={BOARD_COLUMN}
								title={<Trans>Seated</Trans>}
								count={columns.seated.length}
								empty={
									<>
										<Icon name="users" className="size-4" />
										<Trans>No parties currently seated.</Trans>
									</>
								}
							>
								{columns.seated.map((rsv) => (
									<TodayPartyCard
										key={rsv.id}
										reservation={rsv}
										kind="seated"
										busy={actionBusyId === rsv.id}
										elapsedMin={host.liveNow.elapsedMinutesSince(
											rsv.seatedAt ?? rsv.slotStartAt,
										)}
										{...cardProps}
									/>
								))}
							</KanbanColumn>

							{waitlistEnabled ? (
								<TodayWaitlistCard
									className={BOARD_COLUMN}
									entries={dayFeed?.waitlist ?? []}
									orgSlug={orgSlug}
								/>
							) : null}

							<KanbanColumn
								className={cn(BOARD_COLUMN, !finishedExpanded && 'self-start')}
								testId="today-finished-column"
								titleTestId="today-finished-count"
								collapsed={!finishedExpanded}
								title={
									columns.finished.length > 0 ? (
										finishedCountLabel(columns.finished.length)
									) : (
										<Trans>Finished</Trans>
									)
								}
								count={columns.finished.length === 0 ? 0 : undefined}
								headerAction={
									columns.finished.length > 0 ? (
										<Button
											type="button"
											size="xs"
											variant="ghost"
											className="text-muted-foreground -me-1 pointer-coarse:h-11"
											aria-expanded={showFinished}
											onClick={() => setShowFinished((v) => !v)}
											data-testid="today-finished-toggle"
										>
											{showFinished ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
										</Button>
									) : undefined
								}
							>
								{columns.finished.map((rsv) => (
									<TodayPartyCard
										key={rsv.id}
										reservation={rsv}
										kind="finished"
										busy={actionBusyId === rsv.id}
										{...cardProps}
									/>
								))}
							</KanbanColumn>
						</div>
					)}
				</>
			)}

			{lastUndo ? (
				<div
					role="status"
					className="bg-card text-foreground fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border p-3 text-sm shadow-lg"
					data-testid="today-undo-banner"
				>
					<span className="wrap-anywhere">
						<Trans>
							Marked {lastUndo.guestName} as {lastUndoStatusLabel}.
						</Trans>
					</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="h-8 shrink-0 max-md:h-11 pointer-coarse:h-11"
						disabled={actionBusyId === lastUndo.reservationId}
						onClick={handleQuickUndo}
						data-testid="today-undo-btn"
					>
						<Icon name="undo-2" className="size-3.5" />
						<Trans>Undo</Trans>
					</Button>
				</div>
			) : null}

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
