import { type MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ChannelBadge } from '#app/components/reservations/channel-badge.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import {
	RequestsPanel,
	RequestsTabs,
	type ReservationsViewTab,
} from '#app/components/reservations/requests-panel.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { useReservationRequests } from '#app/components/reservations/use-reservation-requests.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	transitionReservationStatus,
	undoReservationTransition,
} from '#app/utils/reservations/book-api.ts'
import {
	CHANNEL_LABELS,
	CONTACT_STATUS_LABELS,
	COURSE_STAGE_LABELS,
	DAY_CONFLICT_REASON_LABELS,
	DIETARY_LABELS,
	enumLabel,
	OCCASION_LABELS,
	RESERVATION_STATUS_LABELS,
	SOURCE_FILTER_OPTIONS,
	stripTagPrefix,
	TAG_LABELS,
	VIP_TIER_LABELS,
} from '#app/utils/reservations/labels.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/book.ts'
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

type BookStatusFilter =
	| 'all'
	| 'upcoming'
	| 'arrived'
	| 'seated'
	| 'completed'
	| 'cancelled'
	| 'no_show'
	| 'unassigned'
	| 'conflict'

export default function ReservationsBookRoute() {
	const { t, i18n } = useLingui()
	const label = (
		labels: Record<string, MessageDescriptor>,
		value: string | null | undefined,
	) => enumLabel((d) => i18n._(d), labels, value)
	const { orgSlug, canManage } = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]
	const locationId = activeLocation?.id ?? ''

	const host = useHostStand({
		orgSlug,
		locationId,
		defaultTimeZone: activeLocation?.timezone ?? 'UTC',
		pollIntervalMs: 10_000,
	})

	const [view, setView] = useState<ReservationsViewTab>('reservations')
	const [searchQuery, setSearchQuery] = useState('')
	const [statusFilter, setStatusFilter] = useState<BookStatusFilter>('all')
	const [busyId, setBusyId] = useState<string | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const [lastUndo, setLastUndo] = useState<{
		reservationId: string
		guestName: string
		status: string
		undoToken: string | null
	} | null>(null)

	const dayFeed = host.dayFeed
	const reservations = useMemo(
		() => dayFeed?.reservations ?? [],
		[dayFeed?.reservations],
	)

	const requests = useReservationRequests({
		client: host.client,
		locationId,
		reservations,
		onMutated: host.handleReservationMutated,
	})

	const filteredReservations = useMemo(() => {
		const q = searchQuery.trim().toLowerCase()
		return reservations.filter((rsv) => {
			if (statusFilter === 'upcoming') {
				if (
					rsv.status !== 'booked' &&
					rsv.status !== 'confirmed' &&
					rsv.status !== 'pending_payment'
				) {
					return false
				}
			} else if (statusFilter === 'unassigned') {
				if (
					rsv.assignedTableIds.length > 0 ||
					rsv.status === 'cancelled' ||
					rsv.status === 'no_show' ||
					rsv.status === 'completed' ||
					rsv.status === 'finished'
				) {
					return false
				}
			} else if (statusFilter === 'completed') {
				if (rsv.status !== 'completed' && rsv.status !== 'finished') {
					return false
				}
			} else if (statusFilter === 'conflict') {
				if (!rsv.hasConflict) return false
			} else if (statusFilter !== 'all') {
				if (rsv.status !== statusFilter) return false
			}

			if (!q) return true
			return (
				rsv.guestName.toLowerCase().includes(q) ||
				rsv.guestPhone.toLowerCase().includes(q) ||
				rsv.confirmationCode.toLowerCase().includes(q) ||
				rsv.assignedTableLabels.some((lbl) => lbl.toLowerCase().includes(q)) ||
				(rsv.guestNotes ?? '').toLowerCase().includes(q) ||
				(rsv.internalNotes ?? '').toLowerCase().includes(q)
			)
		})
	}, [reservations, searchQuery, statusFilter])

	const counters = useMemo(() => {
		const active = filteredReservations.filter(
			(rsv) => rsv.status !== 'cancelled' && rsv.status !== 'no_show',
		)
		return {
			parties: active.length,
			covers: active.reduce((sum, rsv) => sum + rsv.partySize, 0),
		}
	}, [filteredReservations])

	const handleQuickStatus = async (
		reservationId: string,
		guestName: string,
		to: string,
	) => {
		setBusyId(reservationId)
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
				err instanceof Error ? err.message : t`Status transition failed.`,
			)
		} finally {
			setBusyId(null)
		}
	}

	const handleQuickUndo = async () => {
		if (!lastUndo) return
		setBusyId(lastUndo.reservationId)
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
			setBusyId(null)
		}
	}

	const lastUndoStatusLabel = label(RESERVATION_STATUS_LABELS, lastUndo?.status)

	const statusFilters: Array<{ key: BookStatusFilter; label: string }> = [
		{ key: 'all', label: t`All` },
		{ key: 'upcoming', label: t`Upcoming` },
		{ key: 'arrived', label: t`Arrived` },
		{ key: 'seated', label: t`Seated` },
		{ key: 'completed', label: t`Completed` },
		{ key: 'unassigned', label: t`Unassigned` },
		{ key: 'conflict', label: t`Conflicts` },
		{ key: 'no_show', label: t`No-Show` },
		{ key: 'cancelled', label: t`Cancelled` },
	]

	return (
		<div className="flex flex-col gap-4" data-testid="reservations-book-view">
			<HostSubnav
				orgSlug={orgSlug}
				activeView="book"
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

			{host.poll.error || actionError || requests.error ? (
				<Alert variant="destructive" data-testid="book-error-banner">
					<AlertDescription>
						{actionError ?? requests.error ?? host.poll.error}
					</AlertDescription>
				</Alert>
			) : null}

			<RequestsTabs
				value={view}
				onValueChange={setView}
				pendingCount={requests.pending.length}
			/>

			{lastUndo ? (
				<div
					className="flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
					data-testid="book-undo-banner"
				>
					<span>
						<Trans>
							Changed {lastUndo.guestName} to {lastUndoStatusLabel}. Undo
							available for 60 seconds.
						</Trans>
					</span>
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={handleQuickUndo}
						data-testid="book-undo-btn"
					>
						<Icon name="undo-2" className="size-3.5" />
						<span>
							<Trans>Undo</Trans>
						</span>
					</Button>
				</div>
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
			) : null}

			{view === 'reservations' ? (
				<>
					{/* Filter & Search Bar */}
					<Card
						className="flex flex-col gap-3 p-3"
						data-testid="book-filter-bar"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="relative w-full sm:max-w-xs">
								<Input
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder={t`Search guest, phone, code, table...`}
									className="h-8 text-xs"
									data-testid="book-search-input"
								/>
							</div>

							<div
								className="text-muted-foreground flex items-center gap-3 text-xs"
								data-testid="book-counters"
							>
								<span data-testid="book-counter-parties">
									<Trans>Parties</Trans>:{' '}
									<strong className="text-foreground">
										{counters.parties}
									</strong>
								</span>
								<span data-testid="book-counter-covers">
									<Trans>Covers</Trans>:{' '}
									<strong className="text-foreground">{counters.covers}</strong>
								</span>
							</div>

							<div className="flex flex-wrap items-center gap-1">
								{statusFilters.map((f) => (
									<Button
										key={f.key}
										type="button"
										size="xs"
										variant={statusFilter === f.key ? 'default' : 'outline'}
										onClick={() => setStatusFilter(f.key)}
										data-testid={`book-status-filter-${f.key}`}
									>
										{f.label}
									</Button>
								))}
							</div>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Label htmlFor="book-source-filter" className="text-xs">
								<Trans>Source</Trans>
							</Label>
							<select
								id="book-source-filter"
								value={host.selectedSource ?? ''}
								onChange={(e) => host.setSource(e.target.value || null)}
								className="border-input bg-background h-8 rounded-md border px-2 text-xs"
								data-testid="book-source-filter"
							>
								<option value="">{t`All sources`}</option>
								{SOURCE_FILTER_OPTIONS.map((source) => (
									<option key={source} value={source}>
										{label(CHANNEL_LABELS, source)}
									</option>
								))}
							</select>
							<Label htmlFor="book-tag-filter" className="text-xs">
								<Trans>Tag</Trans>
							</Label>
							<select
								id="book-tag-filter"
								value={host.selectedTag ?? ''}
								onChange={(e) => host.setTag(e.target.value || null)}
								className="border-input bg-background h-8 rounded-md border px-2 text-xs"
								data-testid="book-tag-filter"
							>
								<option value="">{t`All tags`}</option>
								{(dayFeed?.tags ?? []).map((tag) => (
									<option key={tag.id} value={tag.id}>
										{TAG_LABELS[stripTagPrefix(tag.id)]
											? label(TAG_LABELS, tag.id)
											: tag.name}
									</option>
								))}
							</select>
						</div>
					</Card>

					{/* Reservations Table */}
					<Card className="overflow-hidden">
						<div className="overflow-x-auto">
							<table
								className="w-full border-collapse text-start text-xs"
								data-testid="book-reservations-table"
							>
								<thead>
									<tr className="bg-muted/50 border-b text-start font-medium">
										<th className="px-3 py-2.5 text-start">
											<Trans>Time</Trans>
										</th>
										<th className="px-3 py-2.5 text-start">
											<Trans>Guest</Trans>
										</th>
										<th className="px-3 py-2.5 text-start">
											<Trans>Party</Trans>
										</th>
										<th className="px-3 py-2.5 text-start">
											<Trans>Table & Area</Trans>
										</th>
										<th className="px-3 py-2.5 text-start">
											<Trans>Tags & Notes</Trans>
										</th>
										<th className="px-3 py-2.5 text-start">
											<Trans>Status</Trans>
										</th>
										<th className="px-3 py-2.5 text-end">
											<Trans>Actions</Trans>
										</th>
									</tr>
								</thead>
								<tbody className="divide-y">
									{filteredReservations.length === 0 ? (
										<tr>
											<td
												colSpan={7}
												className="text-muted-foreground px-4 py-8 text-center"
												data-testid="book-empty-state"
											>
												<Trans>
													No reservations match the current filters for{' '}
													{host.businessDate}.
												</Trans>
											</td>
										</tr>
									) : (
										filteredReservations.map((rsv) => (
											<tr
												key={rsv.id}
												className="hover:bg-muted/30 cursor-pointer transition"
												onClick={() => host.openDetail(rsv.id)}
												data-testid={`book-row-${rsv.id}`}
											>
												<td className="px-3 py-2.5 font-mono font-semibold whitespace-nowrap">
													<div>{rsv.hhmm}</div>
													<div className="text-muted-foreground font-sans text-[11px] font-normal">
														{rsv.durationMin}m
													</div>
												</td>

												<td className="px-3 py-2.5">
													<div className="flex flex-wrap items-center gap-1.5 font-semibold">
														<span>{rsv.guestName}</span>
														{rsv.guest?.vipTier &&
														rsv.guest.vipTier !== 'none' ? (
															<Badge variant="default">
																{label(VIP_TIER_LABELS, rsv.guest.vipTier)}
															</Badge>
														) : null}
														<Badge variant="outline" className="font-mono">
															#{rsv.confirmationCode}
														</Badge>
													</div>
													<div className="text-muted-foreground">
														{rsv.guestPhone || '—'}
														{rsv.guest?.visitCount ? (
															<span className="ms-2">
																• {rsv.guest.visitCount} <Trans>visits</Trans>
															</span>
														) : null}
													</div>
												</td>

												<td className="px-3 py-2.5 font-semibold whitespace-nowrap">
													{rsv.partySize} <Trans>guests</Trans>
													<div className="mt-0.5">
														<ChannelBadge
															channel={rsv.channel}
															testId={`book-row-channel-${rsv.id}`}
														/>
													</div>
												</td>

												<td className="px-3 py-2.5 whitespace-nowrap">
													<div className="flex flex-wrap items-center gap-1">
														{rsv.assignedTableLabels.length > 0 ? (
															<Badge
																variant="outline"
																data-testid={`book-row-table-${rsv.id}`}
															>
																{rsv.assignedTableLabels.join(', ')}
															</Badge>
														) : (
															<Badge variant="destructive">
																<Trans>Unassigned</Trans>
															</Badge>
														)}
														{rsv.serverLabel ? (
															<Badge variant="secondary">
																{rsv.serverLabel}
															</Badge>
														) : null}
													</div>
													<div className="text-muted-foreground mt-0.5 text-[11px]">
														{rsv.areaName ?? '—'} • {rsv.serviceName ?? '—'}
													</div>
												</td>

												<td className="px-3 py-2.5">
													<div className="flex flex-wrap items-center gap-1">
														{rsv.hasConflict ? (
															<Badge variant="destructive">
																{rsv.conflictReason
																	? label(
																			DAY_CONFLICT_REASON_LABELS,
																			rsv.conflictReason,
																		)
																	: t`Conflict`}
															</Badge>
														) : null}
														{rsv.lateRisk ? (
															<Badge variant="destructive">
																<Trans>Late Risk</Trans>
															</Badge>
														) : null}
														{rsv.runningLateMin ? (
															<Badge variant="secondary">
																+{rsv.runningLateMin}m
															</Badge>
														) : null}
														{rsv.contactStatus &&
														rsv.contactStatus !== 'none' ? (
															<Badge variant="outline">
																{label(
																	CONTACT_STATUS_LABELS,
																	rsv.contactStatus,
																)}
															</Badge>
														) : null}
														{rsv.occasion ? (
															<Badge variant="outline">
																{label(OCCASION_LABELS, rsv.occasion)}
															</Badge>
														) : null}
														{rsv.dietaryCodes.map((code) => (
															<Badge key={code} variant="secondary">
																{label(DIETARY_LABELS, code)}
															</Badge>
														))}
													</div>
													{rsv.guestNotes || rsv.internalNotes ? (
														<div className="text-muted-foreground mt-1 line-clamp-1 max-w-xs text-[11px]">
															{rsv.guestNotes ?? rsv.internalNotes}
														</div>
													) : null}
												</td>

												<td className="px-3 py-2.5 whitespace-nowrap">
													<Badge
														variant={
															rsv.status === 'seated'
																? 'default'
																: rsv.status === 'cancelled' ||
																	  rsv.status === 'no_show'
																	? 'destructive'
																	: 'secondary'
														}
														data-testid={`book-row-status-${rsv.id}`}
													>
														{label(RESERVATION_STATUS_LABELS, rsv.status)}
													</Badge>
													{rsv.courseStage && rsv.status === 'seated' ? (
														<div className="text-muted-foreground mt-0.5 text-[11px]">
															{label(COURSE_STAGE_LABELS, rsv.courseStage)}
														</div>
													) : null}
												</td>

												<td
													className="px-3 py-2.5 text-end whitespace-nowrap"
													onClick={(e) => e.stopPropagation()}
												>
													<div className="flex items-center justify-end gap-1">
														{canManage &&
														(rsv.status === 'booked' ||
															rsv.status === 'confirmed') ? (
															<Button
																type="button"
																size="xs"
																variant="outline"
																disabled={busyId === rsv.id}
																onClick={() =>
																	handleQuickStatus(
																		rsv.id,
																		rsv.guestName,
																		'arrived',
																	)
																}
																data-testid={`book-arrive-${rsv.id}`}
															>
																<Trans>Arrive</Trans>
															</Button>
														) : null}
														{canManage &&
														(rsv.status === 'booked' ||
															rsv.status === 'confirmed' ||
															rsv.status === 'arrived') ? (
															<Button
																type="button"
																size="xs"
																disabled={busyId === rsv.id}
																onClick={() =>
																	handleQuickStatus(
																		rsv.id,
																		rsv.guestName,
																		'seated',
																	)
																}
																data-testid={`book-seat-${rsv.id}`}
															>
																<Trans>Seat</Trans>
															</Button>
														) : null}
														{canManage && rsv.status === 'seated' ? (
															<Button
																type="button"
																size="xs"
																variant="outline"
																disabled={busyId === rsv.id}
																onClick={() =>
																	handleQuickStatus(
																		rsv.id,
																		rsv.guestName,
																		'completed',
																	)
																}
																data-testid={`book-complete-${rsv.id}`}
															>
																<Trans>Complete</Trans>
															</Button>
														) : null}
														<Button
															type="button"
															size="xs"
															variant="ghost"
															onClick={() => host.openDetail(rsv.id)}
															data-testid={`book-details-${rsv.id}`}
														>
															<Trans>Details</Trans>
														</Button>
													</div>
												</td>
											</tr>
										))
									)}
								</tbody>
							</table>
						</div>
					</Card>
				</>
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
