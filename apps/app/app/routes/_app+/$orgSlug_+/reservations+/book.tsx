import { type MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card } from '@repo/ui/card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import {
	countAllergyParties,
	GuestFlags,
} from '#app/components/reservations/guest-flags.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { PaymentBadge } from '#app/components/reservations/payment-badge.tsx'
import {
	RequestsPanel,
	RequestsTabs,
	type ReservationsViewTab,
} from '#app/components/reservations/requests-panel.tsx'
import {
	reservationStatusStyle,
	StatusLabel,
} from '#app/components/reservations/status-style.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { useHostTransitions } from '#app/components/reservations/use-host-transitions.ts'
import { useReservationRequests } from '#app/components/reservations/use-reservation-requests.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { formatBusinessDate } from '#app/utils/reservations/business-date.ts'
import { guestsCountLabel } from '#app/utils/reservations/count-labels.ts'
import {
	HOST_ACTION_LABELS,
	hostActionsFor,
} from '#app/utils/reservations/host-actions.ts'
import { hostLoadErrorMessage } from '#app/utils/reservations/host-errors.ts'
import {
	CHANNEL_LABELS,
	CONTACT_STATUS_LABELS,
	COURSE_STAGE_LABELS,
	DAY_CONFLICT_REASON_LABELS,
	enumLabel,
	SOURCE_FILTER_OPTIONS,
	stripTagPrefix,
	TAG_LABELS,
	RESERVATION_STATUS_LABELS,
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
	| 'allergy'

const ACTION_TEST_ID: Record<string, string> = {
	arrive: 'book-arrive',
	seat: 'book-seat',
	finish: 'book-complete',
}

const ALL = 'all'

export default function ReservationsBookRoute() {
	const { t, i18n } = useLingui()
	const tx = (d: MessageDescriptor) => i18n._(d)
	const label = (
		labels: Record<string, MessageDescriptor>,
		value: string | null | undefined,
	) => enumLabel(tx, labels, value)
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
	const businessDateLabel = formatBusinessDate(
		host.businessDate,
		i18n.locale,
		'long',
	)

	const [view, setView] = useState<ReservationsViewTab>('reservations')
	const [searchQuery, setSearchQuery] = useState('')
	const [statusFilter, setStatusFilter] = useState<BookStatusFilter>('all')

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

	const transitions = useHostTransitions({
		client: host.client,
		reservations,
		resetKey: `${locationId}:${host.businessDate}`,
		onMutated: host.handleReservationMutated,
		onFailed: () => void host.refresh(),
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
			} else if (statusFilter === 'allergy') {
				if (countAllergyParties([rsv]) === 0) return false
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

	const allergyCount = useMemo(
		() => countAllergyParties(reservations),
		[reservations],
	)
	const lastUndo = transitions.lastUndo
	const lastUndoStatusLabel = label(RESERVATION_STATUS_LABELS, lastUndo?.status)

	const statusFilters: Array<{ key: BookStatusFilter; label: string }> = [
		{ key: 'all', label: t`All` },
		{ key: 'upcoming', label: t`Upcoming` },
		{ key: 'arrived', label: t`Arrived` },
		{ key: 'seated', label: t`Seated` },
		{ key: 'completed', label: t`Completed` },
		{ key: 'unassigned', label: t`Unassigned` },
		{ key: 'conflict', label: t`Conflicts` },
		{ key: 'allergy', label: t`Allergies tonight (${allergyCount})` },
		{ key: 'no_show', label: t`No-show` },
		{ key: 'cancelled', label: t`Cancelled` },
	]

	const sourceOptions = [
		{ value: ALL, label: t`All sources` },
		...SOURCE_FILTER_OPTIONS.map((source) => ({
			value: source,
			label: label(CHANNEL_LABELS, source),
		})),
	]
	const tagOptions = [
		{ value: ALL, label: t`All tags` },
		...(dayFeed?.tags ?? []).map((tag) => ({
			value: tag.id,
			label: TAG_LABELS[stripTagPrefix(tag.id)]
				? label(TAG_LABELS, tag.id)
				: tag.name,
		})),
	]

	const filtersActive = statusFilter !== 'all' || searchQuery.trim() !== ''
	const loadFailure =
		host.poll.error && !dayFeed
			? hostLoadErrorMessage(
					{ status: host.poll.errorStatus, code: host.poll.errorCode },
					tx,
				)
			: null
	const loading = !dayFeed && host.poll.loading
	const errorText = transitions.error ?? requests.error ?? loadFailure

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
				lastUpdatedAt={host.poll.lastUpdatedAt}
				serviceNotes={dayFeed?.serviceNotes ?? []}
			/>

			{errorText ? (
				<Alert variant="destructive" data-testid="book-error-banner">
					<AlertDescription>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span>{errorText}</span>
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

			<RequestsTabs
				value={view}
				onValueChange={setView}
				pendingCount={requests.pending.length}
			/>

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
					<div className="flex flex-col gap-3" data-testid="book-filter-bar">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<Input
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder={t`Search guest, phone, code, table...`}
								aria-label={t`Search reservations`}
								className="w-full sm:max-w-xs"
								data-testid="book-search-input"
							/>
							<div
								className="text-muted-foreground flex items-center gap-3 text-sm"
								data-testid="book-counters"
							>
								<span data-testid="book-counter-parties">
									<Trans>Parties</Trans>:{' '}
									<strong className="text-foreground tabular-nums">
										{counters.parties}
									</strong>
								</span>
								<span data-testid="book-counter-covers">
									<Trans>Guests</Trans>:{' '}
									<strong className="text-foreground tabular-nums">
										{counters.covers}
									</strong>
								</span>
							</div>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<ToggleGroup
								variant="segmented"
								aria-label={t`Filter by status`}
								className="flex-wrap"
								value={[statusFilter]}
								onValueChange={(next) => {
									const picked = next[0] as BookStatusFilter | undefined
									if (picked) setStatusFilter(picked)
								}}
							>
								{statusFilters.map((f) => (
									<ToggleGroupItem
										key={f.key}
										value={f.key}
										className="h-8 max-md:h-11 pointer-coarse:h-11"
										data-testid={`book-status-filter-${f.key}`}
									>
										{f.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
							<FilterSelect
								label={t`Source`}
								options={sourceOptions}
								value={host.selectedSource ?? ALL}
								onValueChange={(v) => host.setSource(v === ALL ? null : v)}
								testId="book-source-filter"
							/>
							<FilterSelect
								label={t`Tag`}
								options={tagOptions}
								value={host.selectedTag ?? ALL}
								onValueChange={(v) => host.setTag(v === ALL ? null : v)}
								testId="book-tag-filter"
							/>
						</div>
					</div>

					{loading ? (
						<div
							className="flex flex-col gap-2"
							aria-busy="true"
							data-testid="book-skeleton"
						>
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
							<Skeleton className="h-14" />
						</div>
					) : filteredReservations.length === 0 ? (
						<div data-testid="book-empty-state">
							<EmptyState
								icons={['calendar']}
								title={
									filtersActive ? (
										<Trans>No reservations match these filters</Trans>
									) : (
										<Trans>No reservations for this day yet</Trans>
									)
								}
								description={<Trans>Showing {businessDateLabel}.</Trans>}
							>
								{filtersActive ? (
									<Button
										variant="outline"
										onClick={() => {
											setStatusFilter('all')
											setSearchQuery('')
										}}
									>
										<Trans>Clear filters</Trans>
									</Button>
								) : canManage ? (
									<Button onClick={() => host.openBookingSheet()}>
										<Icon name="plus" />
										<Trans>New reservation</Trans>
									</Button>
								) : null}
							</EmptyState>
						</div>
					) : (
						<Card className="overflow-hidden p-0">
							<Table variant="card" data-testid="book-reservations-table">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Time</Trans>
										</TableHead>
										<TableHead>
											<Trans>Guest</Trans>
										</TableHead>
										<TableHead>
											<Trans>Party</Trans>
										</TableHead>
										<TableHead>
											<Trans>Table</Trans>
										</TableHead>
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Actions</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredReservations.map((rsv) => {
										const guest = rsv.guestName || t`Guest`
										const style = reservationStatusStyle(rsv.status)
										const { primary, secondary } = hostActionsFor(rsv.status, {
											nowMs: host.liveNow.nowMs,
											finishedAtMs: rsv.completedAt,
										})
										const note = rsv.guestNotes ?? rsv.internalNotes
										const attention = rsv.hasConflict
											? {
													variant: 'destructive' as const,
													text: rsv.conflictReason
														? label(
																DAY_CONFLICT_REASON_LABELS,
																rsv.conflictReason,
															)
														: t`Conflict`,
												}
											: rsv.assignedTableLabels.length === 0 &&
												  style.tone !== 'muted' &&
												  style.tone !== 'destructive'
												? { variant: 'warning' as const, text: t`Unassigned` }
												: rsv.lateRisk
													? { variant: 'warning' as const, text: t`Late risk` }
													: null
										const meta = [
											rsv.guestPhone || null,
											rsv.contactStatus && rsv.contactStatus !== 'none'
												? label(CONTACT_STATUS_LABELS, rsv.contactStatus)
												: null,
										].filter(Boolean)
										return (
											<TableRow
												key={rsv.id}
												className="cursor-pointer"
												onClick={() => host.openDetail(rsv.id)}
												data-testid={`book-row-${rsv.id}`}
											>
												<TableCell className="whitespace-nowrap tabular-nums">
													<div className="font-semibold">{rsv.hhmm}</div>
													<div className="text-muted-foreground text-xs">
														{t`${rsv.durationMin} min`}
													</div>
												</TableCell>
												<TableCell>
													<div
														className={cn(
															'font-semibold wrap-anywhere',
															style.strike && 'line-through',
														)}
													>
														{guest}{' '}
														<span className="text-muted-foreground font-mono text-xs font-normal">
															#{rsv.confirmationCode}
														</span>
													</div>
													{meta.length > 0 ? (
														<div className="text-muted-foreground text-xs">
															{meta.join(' · ')}
														</div>
													) : null}
													<GuestFlags
														reservation={rsv}
														className="mt-1 max-w-xs"
													/>
													{note ? (
														<div className="text-muted-foreground line-clamp-1 max-w-xs text-xs">
															{note}
														</div>
													) : null}
												</TableCell>
												<TableCell className="whitespace-nowrap">
													<div className="font-semibold tabular-nums">
														{guestsCountLabel(rsv.partySize)}
													</div>
													<div
														className="text-muted-foreground text-xs"
														data-testid={`book-row-channel-${rsv.id}`}
													>
														{label(CHANNEL_LABELS, rsv.channel)}
													</div>
												</TableCell>
												<TableCell className="whitespace-nowrap">
													<div data-testid={`book-row-table-${rsv.id}`}>
														{rsv.assignedTableLabels.length > 0 ? (
															rsv.assignedTableLabels.join(', ')
														) : (
															<span className="text-muted-foreground">—</span>
														)}
													</div>
													<div className="text-muted-foreground text-xs">
														{[rsv.areaName, rsv.serviceName]
															.filter(Boolean)
															.join(' · ')}
													</div>
												</TableCell>
												<TableCell>
													<div className="flex flex-col items-start gap-1">
														<span data-testid={`book-row-status-${rsv.id}`}>
															<StatusLabel status={rsv.status} />
														</span>
														{rsv.courseStage && rsv.status === 'seated' ? (
															<span className="text-muted-foreground text-xs">
																{label(COURSE_STAGE_LABELS, rsv.courseStage)}
															</span>
														) : null}
														<div className="flex flex-wrap items-center gap-1">
															{attention ? (
																<Badge variant={attention.variant}>
																	{attention.text}
																</Badge>
															) : null}
															<PaymentBadge
																paymentStatus={rsv.paymentStatus}
																experience={Boolean(rsv.experienceId)}
															/>
														</div>
													</div>
												</TableCell>
												<TableCell
													className="text-end whitespace-nowrap"
													onClick={(e) => e.stopPropagation()}
												>
													<div className="flex items-center justify-end gap-1">
														{canManage && primary?.to ? (
															<Button
																type="button"
																size="sm"
																variant={
																	primary.action === 'seat'
																		? 'default'
																		: 'outline'
																}
																className="h-8 max-md:h-11 pointer-coarse:h-11"
																disabled={transitions.busyId === rsv.id}
																onClick={() =>
																	void transitions.run(rsv, primary, guest)
																}
																data-testid={`${ACTION_TEST_ID[primary.action] ?? 'book-action'}-${rsv.id}`}
															>
																{tx(HOST_ACTION_LABELS[primary.action])}
															</Button>
														) : null}
														<Button
															type="button"
															size="sm"
															variant="ghost"
															className="h-8 max-md:h-11 pointer-coarse:h-11"
															onClick={() => host.openDetail(rsv.id)}
															data-testid={`book-details-${rsv.id}`}
														>
															<Trans>Details</Trans>
														</Button>
														{canManage && secondary.some((a) => a.to) ? (
															<DropdownMenu>
																<DropdownMenuTrigger
																	render={
																		<Button
																			type="button"
																			size="icon"
																			variant="ghost"
																			className="size-8 max-md:size-11 pointer-coarse:size-11"
																			aria-label={t`More actions for ${guest}`}
																			disabled={transitions.busyId === rsv.id}
																		>
																			<Icon
																				name="more-horizontal"
																				className="size-4"
																			/>
																		</Button>
																	}
																/>
																<DropdownMenuContent align="end">
																	{secondary.map((item) => (
																		<DropdownMenuItem
																			key={item.action}
																			onClick={() =>
																				item.to
																					? void transitions.run(
																							rsv,
																							item,
																							guest,
																						)
																					: host.openDetail(rsv.id)
																			}
																		>
																			{tx(HOST_ACTION_LABELS[item.action])}
																		</DropdownMenuItem>
																	))}
																</DropdownMenuContent>
															</DropdownMenu>
														) : null}
													</div>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
						</Card>
					)}
				</>
			) : null}

			{lastUndo ? (
				<div
					role="status"
					className="bg-card text-foreground fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border p-3 text-sm shadow-lg"
					data-testid="book-undo-banner"
				>
					<span className="wrap-anywhere">
						<Trans>
							Changed {lastUndo.guestName} to {lastUndoStatusLabel}.
						</Trans>
					</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="h-8 shrink-0 max-md:h-11 pointer-coarse:h-11"
						disabled={transitions.busyId === lastUndo.reservationId}
						onClick={() => void transitions.undo()}
						data-testid="book-undo-btn"
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
