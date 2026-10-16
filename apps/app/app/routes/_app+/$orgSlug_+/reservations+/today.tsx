import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { useLoaderData } from 'react-router'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	markReservationRunningLate,
	transitionReservationStatus,
	undoReservationTransition,
} from '#app/utils/reservations/book-api.ts'
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
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION],
	})
	return { ok: true }
}

export default function ReservationsTodayRoute() {
	const { t } = useLingui()
	const { orgSlug, canManage } = useLoaderData<typeof loader>()
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

	const [actionBusyId, setActionBusyId] = useState<string | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [lastUndo, setLastUndo] = useState<{
		reservationId: string
		guestName: string
		status: string
		undoToken: string | null
	} | null>(null)

	const dayFeed = host.dayFeed
	const stats = dayFeed?.stats
	const reservations = dayFeed?.reservations ?? []

	const upcomingList = reservations.filter(
		(r) =>
			r.status === 'booked' ||
			r.status === 'confirmed' ||
			r.status === 'arrived' ||
			r.status === 'pending_payment',
	)
	const seatedList = reservations.filter((r) => r.status === 'seated')
	const finishedList = reservations.filter(
		(r) =>
			r.status === 'completed' ||
			r.status === 'finished' ||
			r.status === 'cancelled' ||
			r.status === 'no_show',
	)

	const handleQuickStatus = async (
		reservationId: string,
		guestName: string,
		to: string,
	) => {
		setActionBusyId(reservationId)
		setActionError(null)
		try {
			const current = reservations.find((r) => r.id === reservationId)
			const res = await transitionReservationStatus(
				host.client,
				reservationId,
				{
					to,
					...(current?.version ? { expectedVersion: current.version } : {}),
				},
			)
			setLastUndo({
				reservationId,
				guestName,
				status: to,
				undoToken: res.undoToken,
			})
			host.handleReservationMutated(res.reservation, res.moveNotices)
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Status update failed.`,
			)
		} finally {
			setActionBusyId(null)
		}
	}

	const handleQuickUndo = async () => {
		if (!lastUndo) return
		setActionBusyId(lastUndo.reservationId)
		setActionError(null)
		try {
			const current = reservations.find((r) => r.id === lastUndo.reservationId)
			const res = await undoReservationTransition(
				host.client,
				lastUndo.reservationId,
				lastUndo.undoToken,
				current?.version,
			)
			setLastUndo(null)
			host.handleReservationMutated(res.reservation, [])
		} catch (err) {
			setActionError(err instanceof Error ? err.message : t`Undo failed.`)
		} finally {
			setActionBusyId(null)
		}
	}

	const handleQuickLate = async (reservationId: string, minutes: number) => {
		setActionBusyId(reservationId)
		setActionError(null)
		try {
			const current = reservations.find((r) => r.id === reservationId)
			const res = await markReservationRunningLate(
				host.client,
				reservationId,
				minutes,
				true,
				current?.version,
			)
			host.handleReservationMutated(res.reservation, res.moveNotices)
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : t`Failed to mark running late.`,
			)
		} finally {
			setActionBusyId(null)
		}
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
			/>

			{host.poll.error || actionError ? (
				<Alert variant="destructive" data-testid="today-error-banner">
					<AlertDescription>{actionError ?? host.poll.error}</AlertDescription>
				</Alert>
			) : null}

			{lastUndo ? (
				<div
					className="flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
					data-testid="today-undo-banner"
				>
					<span>
						<Trans>
							Marked {lastUndo.guestName} as {lastUndo.status}. Undo available
							for 60s.
						</Trans>
					</span>
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={handleQuickUndo}
						data-testid="today-undo-btn"
					>
						<Icon name="undo-2" className="size-3.5" />
						<span>
							<Trans>Undo</Trans>
						</span>
					</Button>
				</div>
			) : null}

			{/* KPI Summary Cards */}
			<div
				className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
				data-testid="today-kpi-cards"
			>
				<Card className="p-3">
					<div className="text-muted-foreground text-xs">
						<Trans>Total Covers</Trans>
					</div>
					<div
						className="mt-1 text-xl font-bold"
						data-testid="today-kpi-total-covers"
					>
						{stats?.totalCovers ?? 0}
					</div>
					<div className="text-muted-foreground text-xs">
						{stats?.totalParties ?? 0} <Trans>parties</Trans>
					</div>
				</Card>

				<Card className="p-3">
					<div className="text-muted-foreground text-xs">
						<Trans>Arriving Soon</Trans>
					</div>
					<div
						className="mt-1 text-xl font-bold"
						data-testid="today-kpi-arriving-covers"
					>
						{stats?.arrivingSoonCovers ?? 0}
					</div>
					<div className="text-muted-foreground text-xs">
						{stats?.arrivingSoonParties ?? 0} <Trans>next 30m</Trans>
					</div>
				</Card>

				<Card className="p-3">
					<div className="text-muted-foreground text-xs">
						<Trans>Currently Seated</Trans>
					</div>
					<div
						className="mt-1 text-xl font-bold text-emerald-600 dark:text-emerald-400"
						data-testid="today-kpi-seated-covers"
					>
						{stats?.seatedCovers ?? 0}
					</div>
					<div className="text-muted-foreground text-xs">
						{stats?.seatedParties ?? 0} <Trans>tables active</Trans>
					</div>
				</Card>

				<Card className="p-3">
					<div className="text-muted-foreground text-xs">
						<Trans>Walk-Ins Today</Trans>
					</div>
					<div
						className="mt-1 text-xl font-bold"
						data-testid="today-kpi-walkin-covers"
					>
						{stats?.walkInCovers ?? 0}
					</div>
					<div className="text-muted-foreground text-xs">
						{stats?.walkInParties ?? 0} <Trans>walk-in parties</Trans>
					</div>
				</Card>

				<Card className="p-3">
					<div className="text-muted-foreground text-xs">
						<Trans>Completed</Trans>
					</div>
					<div
						className="mt-1 text-xl font-bold"
						data-testid="today-kpi-completed-covers"
					>
						{stats?.completedCovers ?? 0}
					</div>
					<div className="text-muted-foreground text-xs">
						{stats?.completedParties ?? 0} <Trans>turns finished</Trans>
					</div>
				</Card>

				<Card className="p-3">
					<div className="text-muted-foreground text-xs">
						<Trans>Attention Needed</Trans>
					</div>
					<div
						className="mt-1 text-xl font-bold text-amber-600 dark:text-amber-400"
						data-testid="today-kpi-attention"
					>
						{(stats?.unassignedCount ?? 0) +
							(stats?.conflictCount ?? 0) +
							(stats?.lateRiskCount ?? 0)}
					</div>
					<div className="text-muted-foreground text-xs">
						{stats?.unassignedCount ?? 0} <Trans>unassigned</Trans> •{' '}
						{stats?.conflictCount ?? 0} <Trans>conflicts</Trans>
					</div>
				</Card>
			</div>

			{/* 3-Column Live Shift Board */}
			<div
				className="grid grid-cols-1 gap-4 lg:grid-cols-3"
				data-testid="today-board"
			>
				{/* Column 1: Upcoming & Arriving */}
				<Card className="flex flex-col">
					<CardHeader className="pb-2">
						<CardTitle className="flex items-center justify-between text-base">
							<span>
								<Trans>Upcoming & Arriving</Trans>
							</span>
							<Badge variant="secondary">{upcomingList.length}</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2.5">
						{upcomingList.length === 0 ? (
							<div className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs">
								<Trans>No upcoming reservations for this filter.</Trans>
							</div>
						) : (
							upcomingList.map((rsv) => (
								<div
									key={rsv.id}
									className="bg-background hover:bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 text-xs transition"
									data-testid={`today-upcoming-card-${rsv.id}`}
								>
									<div className="flex items-start justify-between gap-2">
										<button
											type="button"
											onClick={() => host.openDetail(rsv.id)}
											className="text-start font-semibold hover:underline"
											data-testid={`today-open-detail-${rsv.id}`}
										>
											{rsv.hhmm} • {rsv.guestName} ({rsv.partySize})
										</button>
										<div className="flex flex-wrap items-center gap-1">
											{rsv.guest?.vipTier && rsv.guest.vipTier !== 'none' ? (
												<Badge variant="default">{rsv.guest.vipTier}</Badge>
											) : null}
											{rsv.assignedTableLabels.length > 0 ? (
												<Badge variant="outline">
													{rsv.assignedTableLabels.join(', ')}
												</Badge>
											) : (
												<Badge variant="destructive">
													<Trans>Unassigned</Trans>
												</Badge>
											)}
											<Badge variant="secondary">{rsv.status}</Badge>
										</div>
									</div>

									{(rsv.lateRisk ||
										rsv.runningLateMin ||
										rsv.dietaryCodes.length > 0 ||
										rsv.occasion ||
										rsv.guestNotes) && (
										<div className="flex flex-wrap items-center gap-1.5">
											{rsv.lateRisk ? (
												<Badge variant="destructive">
													<Trans>Late Risk</Trans>
												</Badge>
											) : null}
											{rsv.runningLateMin ? (
												<Badge variant="secondary">
													+{rsv.runningLateMin}m <Trans>late</Trans>
												</Badge>
											) : null}
											{rsv.occasion ? (
												<Badge variant="outline">{rsv.occasion}</Badge>
											) : null}
											{rsv.dietaryCodes.map((c) => (
												<Badge key={c} variant="outline">
													{c}
												</Badge>
											))}
										</div>
									)}

									{canManage ? (
										<div className="flex flex-wrap items-center gap-1.5 pt-1">
											{rsv.status !== 'arrived' ? (
												<Button
													type="button"
													size="xs"
													variant="outline"
													disabled={actionBusyId === rsv.id}
													onClick={() =>
														handleQuickStatus(rsv.id, rsv.guestName, 'arrived')
													}
													data-testid={`today-arrive-${rsv.id}`}
												>
													<Trans>Arrived</Trans>
												</Button>
											) : null}
											<Button
												type="button"
												size="xs"
												disabled={actionBusyId === rsv.id}
												onClick={() =>
													handleQuickStatus(rsv.id, rsv.guestName, 'seated')
												}
												data-testid={`today-seat-${rsv.id}`}
											>
												<Icon name="check" className="size-3.5" />
												<span>
													<Trans>Seat</Trans>
												</span>
											</Button>
											<Button
												type="button"
												size="xs"
												variant="ghost"
												disabled={actionBusyId === rsv.id}
												onClick={() => handleQuickLate(rsv.id, 15)}
												data-testid={`today-late-${rsv.id}`}
											>
												+15m
											</Button>
											<Button
												type="button"
												size="xs"
												variant="ghost"
												onClick={() => host.openDetail(rsv.id)}
											>
												<Trans>Details</Trans>
											</Button>
										</div>
									) : null}
								</div>
							))
						)}
					</CardContent>
				</Card>

				{/* Column 2: Currently Seated */}
				<Card className="flex flex-col">
					<CardHeader className="pb-2">
						<CardTitle className="flex items-center justify-between text-base">
							<span>
								<Trans>Currently Seated</Trans>
							</span>
							<Badge variant="default">{seatedList.length}</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2.5">
						{seatedList.length === 0 ? (
							<div className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs">
								<Trans>No parties currently seated.</Trans>
							</div>
						) : (
							seatedList.map((rsv) => {
								const elapsedMin = host.liveNow.elapsedMinutesSince(
									rsv.seatedAt ?? rsv.slotStartAt,
								)
								const overTurn = elapsedMin > rsv.durationMin
								return (
									<div
										key={rsv.id}
										className="bg-background flex flex-col gap-2 rounded-lg border p-3 text-xs"
										data-testid={`today-seated-card-${rsv.id}`}
									>
										<div className="flex items-start justify-between gap-2">
											<button
												type="button"
												onClick={() => host.openDetail(rsv.id)}
												className="text-start font-semibold hover:underline"
											>
												{rsv.assignedTableLabels.join(', ') || t`Table`} •{' '}
												{rsv.guestName} ({rsv.partySize})
											</button>
											<div className="flex items-center gap-1">
												<Badge
													variant={overTurn ? 'destructive' : 'secondary'}
													data-testid={`today-elapsed-${rsv.id}`}
												>
													{elapsedMin}m / {rsv.durationMin}m
												</Badge>
												{rsv.courseStage ? (
													<Badge variant="outline">{rsv.courseStage}</Badge>
												) : null}
											</div>
										</div>

										{rsv.serverLabel ? (
											<div className="text-muted-foreground">
												<Trans>Server:</Trans> {rsv.serverLabel}
											</div>
										) : null}

										{canManage ? (
											<div className="flex items-center justify-between gap-2 pt-1">
												<Button
													type="button"
													size="xs"
													variant="outline"
													disabled={actionBusyId === rsv.id}
													onClick={() =>
														handleQuickStatus(
															rsv.id,
															rsv.guestName,
															'completed',
														)
													}
													data-testid={`today-complete-${rsv.id}`}
												>
													<Icon name="check" className="size-3.5" />
													<span>
														<Trans>Complete Turn</Trans>
													</span>
												</Button>
												<Button
													type="button"
													size="xs"
													variant="ghost"
													onClick={() => host.openDetail(rsv.id)}
												>
													<Trans>Details</Trans>
												</Button>
											</div>
										) : null}
									</div>
								)
							})
						)}
					</CardContent>
				</Card>

				{/* Column 3: Finished, Waitlist & Attention */}
				<Card className="flex flex-col">
					<CardHeader className="pb-2">
						<CardTitle className="flex items-center justify-between text-base">
							<span>
								<Trans>Completed, No-Show & Cancelled</Trans>
							</span>
							<Badge variant="outline">{finishedList.length}</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2.5">
						{finishedList.length === 0 ? (
							<div className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs">
								<Trans>No completed or cancelled reservations yet.</Trans>
							</div>
						) : (
							finishedList.map((rsv) => (
								<div
									key={rsv.id}
									className="bg-muted/20 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-xs"
									data-testid={`today-finished-card-${rsv.id}`}
								>
									<button
										type="button"
										onClick={() => host.openDetail(rsv.id)}
										className="text-start font-medium hover:underline"
									>
										{rsv.hhmm} • {rsv.guestName} ({rsv.partySize})
									</button>
									<Badge
										variant={
											rsv.status === 'completed' ? 'secondary' : 'destructive'
										}
									>
										{rsv.status}
									</Badge>
								</div>
							))
						)}
					</CardContent>
				</Card>
			</div>

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
