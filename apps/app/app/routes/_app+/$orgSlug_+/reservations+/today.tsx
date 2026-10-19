import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { countAllergyParties } from '#app/components/reservations/guest-flags.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import {
	RequestsPanel,
	RequestsTabs,
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
import {
	allergiesTonightLabel,
	finishedCountLabel,
	partiesLabel,
	tablesActiveLabel,
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

/** Each board column; on phones the columns snap-scroll sideways. */
const BOARD_CARD =
	'flex min-w-0 flex-col max-md:w-[88%] max-md:shrink-0 max-md:snap-start'

function ColumnEmpty({
	icon,
	children,
}: {
	icon: 'calendar' | 'users' | 'check'
	children: React.ReactNode
}) {
	return (
		<div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm">
			<Icon name={icon} className="size-5" />
			{children}
		</div>
	)
}

function KpiItem({
	label,
	value,
	hint,
	tone = 'default',
}: {
	label: React.ReactNode
	value: React.ReactNode
	hint?: string
	tone?: 'default' | 'destructive'
}) {
	return (
		<div className="flex min-w-0 flex-col px-3 py-1.5">
			<span className="text-muted-foreground truncate text-xs">{label}</span>
			<span
				className={
					tone === 'destructive'
						? 'text-destructive text-lg leading-tight font-semibold tabular-nums'
						: 'text-lg leading-tight font-semibold tabular-nums'
				}
			>
				{value}
			</span>
			{hint ? (
				<span className="text-muted-foreground hidden truncate text-xs md:block">
					{hint}
				</span>
			) : null}
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
				<div key={col} className="flex flex-col gap-2.5 rounded-xl border p-4">
					<Skeleton className="h-5 w-32" />
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
					<Skeleton className="h-20" />
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

			<div
				className="flex flex-wrap items-center gap-x-4 gap-y-2"
				data-testid="today-board-header"
			>
				<RequestsTabs
					value={view}
					onValueChange={setView}
					pendingCount={requests.pending.length}
				/>
				{view === 'reservations' ? (
					<div
						className="bg-card grid min-w-0 flex-1 grid-cols-4 divide-x rounded-lg border rtl:divide-x-reverse"
						data-testid="today-kpi-cards"
					>
						<KpiItem
							label={<Trans>Covers</Trans>}
							value={
								<span data-testid="today-kpi-total-covers">
									{stats?.totalCovers ?? 0}
								</span>
							}
							hint={partiesLabel(stats?.totalParties ?? 0)}
						/>
						<KpiItem
							label={<Trans>Next arrival</Trans>}
							value={
								<span data-testid="today-kpi-next-arrival">
									{nextArrival?.hhmm ?? '\u2013'}
								</span>
							}
							hint={
								nextArrival
									? `${nextArrival.guestName || ''} (${nextArrival.partySize})`
									: undefined
							}
						/>
						<KpiItem
							label={<Trans>Seated</Trans>}
							value={
								<span data-testid="today-kpi-seated-covers">
									{stats?.seatedCovers ?? 0}
								</span>
							}
							hint={tablesActiveLabel(stats?.seatedParties ?? 0)}
						/>
						<KpiItem
							label={<Trans>Allergies</Trans>}
							tone={allergyCount > 0 ? 'destructive' : 'default'}
							value={
								<span data-testid="today-kpi-allergies">{allergyCount}</span>
							}
							hint={allergiesTonightLabel(allergyCount)}
						/>
					</div>
				) : null}
			</div>

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
						<EmptyState
							icons={['calendar', 'users', 'clock']}
							title={<Trans>No bookings for this day yet</Trans>}
							description={
								<Trans>
									New reservations and walk-ins appear here as soon as they are
									added.
								</Trans>
							}
						>
							{canManage ? (
								<>
									<Button onClick={() => host.openBookingSheet()}>
										<Icon name="plus" />
										<Trans>New reservation</Trans>
									</Button>
									<Button variant="outline" onClick={() => host.openWalkIn()}>
										<Icon name="user-plus" />
										<Trans>Add walk-in</Trans>
									</Button>
								</>
							) : null}
						</EmptyState>
					) : (
						<div
							className={boardGridClass({
								waitlistEnabled,
								finishedOpen: finishedExpanded,
							})}
							data-testid="today-board"
							data-finished-open={finishedExpanded}
						>
							<Card className={BOARD_CARD}>
								<CardHeader className="pb-2">
									<CardTitle className="flex items-center justify-between text-base">
										<span>
											<Trans>Upcoming & arriving</Trans>
										</span>
										<span className="text-muted-foreground text-sm font-normal tabular-nums">
											{columns.upcoming.length}
										</span>
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col gap-2.5">
									{columns.upcoming.length === 0 ? (
										<ColumnEmpty icon="calendar">
											<Trans>No upcoming reservations for this filter.</Trans>
										</ColumnEmpty>
									) : (
										columns.upcoming.map((rsv) => (
											<TodayPartyCard
												key={rsv.id}
												reservation={rsv}
												kind="upcoming"
												busy={actionBusyId === rsv.id}
												{...cardProps}
											/>
										))
									)}
								</CardContent>
							</Card>

							<Card className={BOARD_CARD}>
								<CardHeader className="pb-2">
									<CardTitle className="flex items-center justify-between text-base">
										<span>
											<Trans>Seated</Trans>
										</span>
										<span className="text-muted-foreground text-sm font-normal tabular-nums">
											{columns.seated.length}
										</span>
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col gap-2.5">
									{columns.seated.length === 0 ? (
										<ColumnEmpty icon="users">
											<Trans>No parties currently seated.</Trans>
										</ColumnEmpty>
									) : (
										columns.seated.map((rsv) => (
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
										))
									)}
								</CardContent>
							</Card>

							{waitlistEnabled ? (
								<TodayWaitlistCard
									entries={dayFeed?.waitlist ?? []}
									orgSlug={orgSlug}
								/>
							) : null}

							<Card
								className={cn(BOARD_CARD, !finishedExpanded && 'self-start')}
								data-testid="today-finished-column"
							>
								<CardHeader className={finishedExpanded ? 'pb-2' : 'py-0'}>
									<CardTitle className="flex items-center justify-between gap-2 text-base">
										<span data-testid="today-finished-count">
											{columns.finished.length > 0 ? (
												finishedCountLabel(columns.finished.length)
											) : (
												<Trans>Finished</Trans>
											)}
										</span>
										{columns.finished.length > 0 ? (
											<Button
												type="button"
												size="sm"
												variant="ghost"
												className="h-8 max-md:h-11 pointer-coarse:h-11"
												aria-expanded={showFinished}
												onClick={() => setShowFinished((v) => !v)}
												data-testid="today-finished-toggle"
											>
												{showFinished ? (
													<Trans>Hide</Trans>
												) : (
													<Trans>Show</Trans>
												)}
											</Button>
										) : null}
									</CardTitle>
								</CardHeader>
								{finishedExpanded ? (
									<CardContent className="flex flex-col gap-2.5">
										{columns.finished.map((rsv) => (
											<TodayPartyCard
												key={rsv.id}
												reservation={rsv}
												kind="finished"
												busy={actionBusyId === rsv.id}
												{...cardProps}
											/>
										))}
									</CardContent>
								) : null}
							</Card>
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
