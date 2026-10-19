import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Textarea } from '@repo/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspaceMetric, WorkspaceMetricGrid } from '@repo/ui/workspace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { GuestFlags } from '#app/components/reservations/guest-flags.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	type DayOverviewResponse,
	fetchBookOverview,
	saveServiceNotes,
} from '#app/utils/reservations/book-api.ts'
import { formatBusinessDate } from '#app/utils/reservations/business-date.ts'
import {
	guestsCountLabel,
	partiesLabel,
} from '#app/utils/reservations/count-labels.ts'
import {
	hostErrorMessage,
	hostLoadErrorMessage,
} from '#app/utils/reservations/host-errors.ts'
import {
	enumLabel,
	OCCASION_LABELS,
	VIP_TIER_LABELS,
} from '#app/utils/reservations/labels.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/overview.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const [access, impersonated] = await Promise.all([
		requireReservationsAccess(
			request,
			params.orgSlug,
			RESERVATIONS_SECTION_REQUIREMENTS.book,
		),
		isImpersonating(request),
	])

	return {
		orgSlug: access.organizationSlug,
		canManage:
			!impersonated &&
			access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION),
		canReadGuest:
			!impersonated &&
			access.grants.includes(RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST),
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION],
	})
	return { ok: true }
}

export default function ReservationsOverviewRoute() {
	const { t, i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { orgSlug, canManage, canReadGuest } = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]
	const locationId = activeLocation?.id ?? ''

	const host = useHostStand({
		orgSlug,
		locationId,
		defaultTimeZone: activeLocation?.timezone ?? 'UTC',
		pollIntervalMs: 60_000,
	})
	const businessDateLabel = formatBusinessDate(
		host.businessDate,
		i18n.locale,
		'long',
	)

	const [overview, setOverview] = useState<DayOverviewResponse | null>(null)
	const [loadingOverview, setLoadingOverview] = useState(true)
	const [overviewError, setOverviewError] = useState<string | null>(null)

	// Per-service notes state keyed by (locationId, businessDate, selectedServiceId)
	const [noteDraft, setNoteDraft] = useState('')
	const [noteDirty, setNoteDirty] = useState(false)
	const [savingNote, setSavingNote] = useState(false)
	const [noteSavedBanner, setNoteSavedBanner] = useState<string | null>(null)
	const [noteError, setNoteError] = useState<string | null>(null)

	// Only the latest request may write state: a slow answer for another date,
	// service or location is aborted and ignored.
	const overviewAbortRef = useRef<AbortController | null>(null)
	const loadOverview = useCallback(async () => {
		overviewAbortRef.current?.abort()
		if (!locationId || !host.businessDate) {
			setLoadingOverview(false)
			return
		}
		const controller = new AbortController()
		overviewAbortRef.current = controller
		setLoadingOverview(true)
		setOverviewError(null)
		try {
			const res = await fetchBookOverview(
				host.client,
				{
					locationId,
					date: host.businessDate,
					serviceId: host.selectedServiceId,
				},
				controller.signal,
			)
			if (controller.signal.aborted) return
			setOverview(res)
		} catch (err) {
			if (controller.signal.aborted) return
			setOverviewError(
				hostErrorMessage(
					err,
					tx,
					msg`Could not load the pre-service overview.`,
				),
			)
		} finally {
			if (!controller.signal.aborted) setLoadingOverview(false)
		}
	}, [host.businessDate, host.client, host.selectedServiceId, locationId, tx])

	// Never show another day's, service's or location's lineup while the next loads.
	useEffect(() => {
		setOverview(null)
		return () => overviewAbortRef.current?.abort()
	}, [host.businessDate, host.selectedServiceId, locationId])

	useEffect(() => {
		void loadOverview()
	}, [loadOverview])

	// Match exact (businessDate, serviceId) note so notes never bleed across dates or services
	const activeServiceNote = useMemo(() => {
		const targetServiceId = host.selectedServiceId ?? null
		const list = overview?.serviceNotes ?? host.dayFeed?.serviceNotes ?? []
		return (
			list.find(
				(n) =>
					n.businessDate === host.businessDate &&
					(n.serviceId ?? null) === targetServiceId,
			) ?? null
		)
	}, [
		host.businessDate,
		host.dayFeed?.serviceNotes,
		host.selectedServiceId,
		overview?.serviceNotes,
	])

	// Reset draft when location, businessDate, serviceId, or persisted note changes
	useEffect(() => {
		setNoteDraft(activeServiceNote?.body ?? '')
		setNoteDirty(false)
		setNoteSavedBanner(null)
		setNoteError(null)
	}, [
		locationId,
		host.businessDate,
		host.selectedServiceId,
		activeServiceNote?.id,
		activeServiceNote?.body,
		activeServiceNote?.version,
	])

	const handleSaveServiceNote = async () => {
		if (!canManage || !locationId) return
		setSavingNote(true)
		setNoteError(null)
		setNoteSavedBanner(null)
		try {
			await saveServiceNotes(host.client, {
				locationId,
				date: host.businessDate,
				serviceId: host.selectedServiceId ?? null,
				note: noteDraft,
				expectedVersion: activeServiceNote?.version,
			})
			setNoteDirty(false)
			setNoteSavedBanner(t`Service notes saved.`)
			await Promise.all([loadOverview(), host.poll.refresh({ force: true })])
		} catch (err) {
			setNoteError(
				hostErrorMessage(err, tx, msg`Could not save the service notes.`),
			)
		} finally {
			setSavingNote(false)
		}
	}

	const services = useMemo(
		() => host.dayFeed?.services ?? [],
		[host.dayFeed?.services],
	)
	const activeServiceName = useMemo(() => {
		if (!host.selectedServiceId) return t`All services`
		return (
			services.find((s) => s.id === host.selectedServiceId)?.name ??
			host.selectedServiceId
		)
	}, [host.selectedServiceId, services, t])

	// Peak 15-minute arrival slots
	const pacingSlots = useMemo(() => {
		const buckets = overview?.pacingBuckets ?? []
		return buckets.filter((b) => b.covers > 0 || b.parties > 0)
	}, [overview?.pacingBuckets])

	const peakCovers = useMemo(() => {
		let max = 0
		for (const b of pacingSlots) {
			if (b.covers > max) max = b.covers
		}
		return max
	}, [pacingSlots])

	const peakSlots = useMemo(() => {
		if (peakCovers <= 0) return []
		return pacingSlots.filter((b) => b.covers === peakCovers)
	}, [pacingSlots, peakCovers])

	const largeParties = overview?.largeParties ?? []
	const vips = overview?.vips ?? []
	const occasions = overview?.occasions ?? []
	const allergies = overview?.allergies ?? []

	return (
		<div
			className="flex flex-col gap-4"
			data-testid="reservations-overview-page"
		>
			<HostSubnav
				orgSlug={orgSlug}
				activeView="overview"
				businessDate={host.businessDate}
				todayDate={host.todayDate}
				onDateChange={host.setDate}
				services={services}
				selectedServiceId={host.selectedServiceId}
				onServiceChange={host.setServiceId}
				areas={host.dayFeed?.areas ?? []}
				selectedAreaId={host.selectedAreaId}
				onAreaChange={host.setAreaId}
				unassignedCount={host.dayFeed?.unassigned.length ?? 0}
				conflictCount={host.dayFeed?.conflicts.length ?? 0}
				moveNoticeCount={host.allMoveNotices.length}
				onOpenBookingSheet={() => host.openBookingSheet()}
				onOpenWalkIn={() => host.openWalkIn()}
				onOpenConflictPanel={() => host.setConflictPanelOpen(true)}
				canManage={canManage}
				refreshing={host.poll.refreshing || loadingOverview}
				lastUpdatedAt={host.poll.lastUpdatedAt}
				onRefresh={() => {
					void host.poll.refresh({ force: true })
					void loadOverview()
				}}
				serviceNotes={
					overview?.serviceNotes ?? host.dayFeed?.serviceNotes ?? []
				}
			/>

			{overviewError || (host.poll.error && !host.dayFeed) ? (
				<Alert variant="destructive" data-testid="overview-error-banner">
					<AlertDescription>
						{overviewError ??
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

			{/* Pre-service KPI summary strip */}
			{loadingOverview && !overview ? (
				<Skeleton className="h-24 w-full" data-testid="overview-skeleton" />
			) : (
				<div data-testid="overview-kpi-grid">
					<WorkspaceMetricGrid className="xl:grid-cols-4">
						<WorkspaceMetric
							label={<Trans>Expected guests</Trans>}
							value={
								<span dir="ltr" data-testid="overview-total-covers">
									{overview?.stats.expectedCovers ?? 0}
								</span>
							}
						/>
						<WorkspaceMetric
							label={<Trans>Parties</Trans>}
							value={
								<span dir="ltr" data-testid="overview-total-parties">
									{overview?.stats.partyCount ?? 0}
								</span>
							}
						/>
						<WorkspaceMetric
							label={<Trans>Large parties (6+)</Trans>}
							value={
								<span dir="ltr" data-testid="overview-large-parties-count">
									{overview?.stats.largePartiesCount ?? largeParties.length}
								</span>
							}
						/>
						<WorkspaceMetric
							label={<Trans>Dietary / allergies</Trans>}
							tone={
								(overview?.stats.allergiesCount ?? allergies.length) > 0
									? 'warning'
									: 'default'
							}
							value={
								<span dir="ltr" data-testid="overview-allergies-count">
									{overview?.stats.allergiesCount ?? allergies.length}
								</span>
							}
						/>
					</WorkspaceMetricGrid>
				</div>
			)}

			{/* Service Notes & Peak 15-Minute Arrival Slots */}
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{/* Service Notes Card (VAL-HOST-024) */}
				<Card data-testid="overview-service-notes-card">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div>
								<CardTitle className="text-base">
									<Trans>Service Notes & Shift Briefing</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>
										Keyed to {businessDateLabel} · {activeServiceName}
									</Trans>
								</CardDescription>
							</div>

							{/* Quick service period switcher pills */}
							{services.length > 0 ? (
								<ToggleGroup
									variant="segmented"
									aria-label={t`Service period`}
									value={[host.selectedServiceId ?? '']}
									onValueChange={(next) => {
										const picked = next[0]
										if (picked === undefined) return
										host.setServiceId(picked === '' ? null : picked)
									}}
									data-testid="overview-service-tabs"
								>
									<ToggleGroupItem
										value=""
										className="h-8 max-md:h-11 pointer-coarse:h-11"
										data-testid="overview-service-tab-all"
									>
										<Trans>All / Day</Trans>
									</ToggleGroupItem>
									{services.map((svc) => (
										<ToggleGroupItem
											key={svc.id}
											value={svc.id}
											className="h-8 max-md:h-11 pointer-coarse:h-11"
											data-testid={`overview-service-tab-${svc.id}`}
										>
											{svc.name}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							) : null}
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						{noteError ? (
							<Alert variant="destructive" data-testid="overview-note-error">
								<AlertDescription>{noteError}</AlertDescription>
							</Alert>
						) : null}

						{noteSavedBanner ? (
							<div
								className="border-success/30 bg-success/10 text-foreground rounded-lg border px-3 py-2 text-sm font-medium"
								data-testid="overview-note-saved-banner"
							>
								{noteSavedBanner}
							</div>
						) : null}

						<Textarea
							value={noteDraft}
							onChange={(e) => {
								setNoteDraft(e.target.value)
								setNoteDirty(true)
							}}
							disabled={!canManage || savingNote}
							rows={4}
							placeholder={t`Enter 86'd items, VIP table callouts, or pre-shift notes for ${activeServiceName}…`}
							data-testid="overview-service-notes-input"
						/>

						<div className="flex items-center justify-between gap-2">
							<span className="text-muted-foreground text-xs">
								{activeServiceNote?.updatedAt ? (
									<Trans>
										Saved for {activeServiceName} (v{activeServiceNote.version})
									</Trans>
								) : (
									<Trans>No saved notes for {activeServiceName} yet.</Trans>
								)}
							</span>

							{canManage ? (
								<Button
									type="button"
									size="sm"
									className="h-8 max-md:h-11 pointer-coarse:h-11"
									disabled={
										savingNote || (!noteDirty && Boolean(activeServiceNote))
									}
									onClick={handleSaveServiceNote}
									data-testid="overview-save-service-notes-btn"
								>
									<Icon name="check" className="size-4" />
									<span>
										{savingNote ? (
											<Trans>Saving…</Trans>
										) : (
											<Trans>Save Service Notes</Trans>
										)}
									</span>
								</Button>
							) : null}
						</div>
					</CardContent>
				</Card>

				{/* Peak 15-Minute Arrival Slots (VAL-HOST-022) */}
				<Card data-testid="overview-peak-slots-card">
					<CardHeader className="pb-2">
						<div className="flex items-center justify-between gap-2">
							<div>
								<CardTitle className="text-base">
									<Trans>15-Minute Arrival Pacing & Peak Slots</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>Arrival distribution across 15-minute intervals</Trans>
								</CardDescription>
							</div>
							{peakSlots.length > 0 ? (
								<Badge variant="default" data-testid="overview-peak-slot-badge">
									<Trans>Peak:</Trans>{' '}
									<span dir="ltr" className="ms-1 font-mono">
										{peakSlots.map((s) => s.hhmm).join(', ')} (
										{guestsCountLabel(peakCovers)})
									</span>
								</Badge>
							) : null}
						</div>
					</CardHeader>
					<CardContent>
						{pacingSlots.length === 0 ? (
							<div
								className="text-muted-foreground py-6 text-center text-sm"
								data-testid="overview-peak-slots-empty"
							>
								<Trans>No arrivals scheduled for this selection.</Trans>
							</div>
						) : (
							<div
								className="flex flex-col gap-2"
								data-testid="overview-pacing-slots-list"
							>
								{pacingSlots.map((slot) => {
									const isPeak = peakCovers > 0 && slot.covers === peakCovers
									const widthPct =
										peakCovers > 0
											? Math.min(
													100,
													Math.round((slot.covers / peakCovers) * 100),
												)
											: 0
									return (
										<div
											key={slot.startMin}
											data-testid={`overview-pacing-slot-${slot.hhmm}`}
											data-peak={isPeak ? 'true' : 'false'}
											className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
												isPeak
													? 'border-warning/50 bg-warning/12 font-semibold'
													: 'border-border bg-card'
											}`}
										>
											<span className="w-14 shrink-0 font-mono" dir="ltr">
												{slot.hhmm}
											</span>
											<div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
												<div
													className={`h-full rounded-full ${
														isPeak ? 'bg-warning' : 'bg-primary'
													}`}
													style={{ width: `${widthPct}%` }}
												/>
											</div>
											<span className="w-28 shrink-0 text-end" dir="ltr">
												{guestsCountLabel(slot.covers)} ·{' '}
												{partiesLabel(slot.parties)}
											</span>
											{isPeak ? (
												<Badge variant="secondary">
													<Trans>Peak</Trans>
												</Badge>
											) : null}
										</div>
									)
								})}
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			{/* Pre-service Lineup Breakdown Cards: Large Parties, VIPs, Occasions, Dietary/Allergy */}
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{/* Dietary & Allergy Briefing (VAL-HOST-022, VAL-HOST-023) */}
				<Card data-testid="overview-allergies-card">
					<CardHeader className="pb-2">
						<div className="flex items-center justify-between">
							<CardTitle className="text-base">
								<Trans>Dietary & Allergy Alerts</Trans>
							</CardTitle>
							<Badge variant="secondary" dir="ltr">
								{overview?.stats.allergiesCount ?? allergies.length}
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{allergies.length === 0 ? (
							<p className="text-muted-foreground py-4 text-center text-sm">
								<Trans>No dietary or allergy alerts for this service.</Trans>
							</p>
						) : (
							allergies.map((rsv) => {
								const allergyDetail = canReadGuest
									? [rsv.guest?.allergiesText, rsv.dietaryCodes.join(', ')]
											.filter(Boolean)
											.join(' · ')
									: null

								return (
									<div
										key={rsv.id}
										data-testid={`overview-allergy-item-${rsv.id}`}
										className="hover:bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm"
									>
										<div className="flex flex-col gap-0.5">
											<Button
												type="button"
												variant="link"
												className="h-auto min-h-8 justify-start p-0 text-start text-sm font-semibold max-md:min-h-11 pointer-coarse:min-h-11"
												onClick={() => host.openDetail(rsv.id)}
											>
												<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName} (
												<span dir="ltr">{rsv.partySize}</span>)
											</Button>
											<GuestFlags reservation={rsv} showOccasion={false} />
											{canReadGuest && allergyDetail ? (
												<span
													className="text-destructive text-xs font-medium"
													data-testid={`overview-allergy-detail-${rsv.id}`}
												>
													{allergyDetail}
												</span>
											) : (
												<span
													className="text-muted-foreground text-xs"
													data-testid={`overview-allergy-redacted-${rsv.id}`}
												>
													<Trans>
														Dietary / allergy flag on file (restricted detail)
													</Trans>
												</span>
											)}
										</div>
										<Badge variant="destructive">
											<Trans>Allergy / Dietary</Trans>
										</Badge>
									</div>
								)
							})
						)}
					</CardContent>
				</Card>

				{/* Large Parties (6+) */}
				<Card data-testid="overview-large-parties-card">
					<CardHeader className="pb-2">
						<div className="flex items-center justify-between">
							<CardTitle className="text-base">
								<Trans>Large parties (6+ guests)</Trans>
							</CardTitle>
							<Badge variant="secondary" dir="ltr">
								{largeParties.length}
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{largeParties.length === 0 ? (
							<p className="text-muted-foreground py-4 text-center text-sm">
								<Trans>No large parties (6+) booked.</Trans>
							</p>
						) : (
							largeParties.map((rsv) => (
								<div
									key={rsv.id}
									data-testid={`overview-large-party-item-${rsv.id}`}
									className="hover:bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm"
								>
									<div className="flex flex-col gap-0.5">
										<Button
											type="button"
											variant="link"
											className="h-auto min-h-8 justify-start p-0 text-start text-sm font-semibold max-md:min-h-11 pointer-coarse:min-h-11"
											onClick={() => host.openDetail(rsv.id)}
										>
											<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName}
										</Button>
										<span className="text-muted-foreground text-xs">
											{rsv.assignedTableLabels.length > 0
												? rsv.assignedTableLabels.join(', ')
												: t`Unassigned`}
										</span>
									</div>
									<Badge variant="default" dir="ltr">
										{guestsCountLabel(rsv.partySize)}
									</Badge>
								</div>
							))
						)}
					</CardContent>
				</Card>

				{/* VIP & Tagged Guests */}
				<Card data-testid="overview-vips-card">
					<CardHeader className="pb-2">
						<div className="flex items-center justify-between">
							<CardTitle className="text-base">
								<Trans>VIP & Tagged Bookings</Trans>
							</CardTitle>
							<Badge
								variant="secondary"
								dir="ltr"
								data-testid="overview-vips-count"
							>
								{vips.length}
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{vips.length === 0 ? (
							<p className="text-muted-foreground py-4 text-center text-sm">
								<Trans>No VIP or tagged guests booked.</Trans>
							</p>
						) : (
							vips.map((rsv) => (
								<div
									key={rsv.id}
									data-testid={`overview-vip-item-${rsv.id}`}
									className="hover:bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm"
								>
									<div className="flex flex-col gap-0.5">
										<Button
											type="button"
											variant="link"
											className="h-auto min-h-8 justify-start p-0 text-start text-sm font-semibold max-md:min-h-11 pointer-coarse:min-h-11"
											onClick={() => host.openDetail(rsv.id)}
										>
											<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName} (
											<span dir="ltr">{rsv.partySize}</span>)
										</Button>
										<div className="flex flex-wrap items-center gap-1">
											{rsv.guest?.vipTier && rsv.guest.vipTier !== 'none' ? (
												<Badge variant="default">
													VIP:{' '}
													{enumLabel(
														(d) => i18n._(d),
														VIP_TIER_LABELS,
														rsv.guest.vipTier,
													)}
												</Badge>
											) : null}
											{(rsv.guest?.tags ?? []).map((tag) => (
												<Badge key={tag.id} variant="outline">
													{tag.name}
												</Badge>
											))}
										</div>
									</div>
									<span className="text-muted-foreground text-xs">
										{rsv.assignedTableLabels.length > 0
											? rsv.assignedTableLabels.join(', ')
											: t`Unassigned`}
									</span>
								</div>
							))
						)}
					</CardContent>
				</Card>

				{/* Occasions */}
				<Card data-testid="overview-occasions-card">
					<CardHeader className="pb-2">
						<div className="flex items-center justify-between">
							<CardTitle className="text-base">
								<Trans>Special Occasions</Trans>
							</CardTitle>
							<Badge
								variant="secondary"
								dir="ltr"
								data-testid="overview-occasions-count"
							>
								{occasions.length}
							</Badge>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{occasions.length === 0 ? (
							<p className="text-muted-foreground py-4 text-center text-sm">
								<Trans>No special occasions noted for this service.</Trans>
							</p>
						) : (
							occasions.map((rsv) => (
								<div
									key={rsv.id}
									data-testid={`overview-occasion-item-${rsv.id}`}
									className="hover:bg-muted/30 flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm"
								>
									<div className="flex flex-col gap-0.5">
										<Button
											type="button"
											variant="link"
											className="h-auto min-h-8 justify-start p-0 text-start text-sm font-semibold max-md:min-h-11 pointer-coarse:min-h-11"
											onClick={() => host.openDetail(rsv.id)}
										>
											<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName} (
											<span dir="ltr">{rsv.partySize}</span>)
										</Button>
										{rsv.guestNotes ? (
											<span className="text-muted-foreground text-xs">
												{rsv.guestNotes}
											</span>
										) : null}
									</div>
									<Badge variant="outline">
										{rsv.occasion
											? enumLabel(tx, OCCASION_LABELS, rsv.occasion)
											: t`Occasion`}
									</Badge>
								</div>
							))
						)}
					</CardContent>
				</Card>
			</div>

			{/* Shared Host Stand Sheets & Modals */}
			<BookingSheet
				open={host.bookingSheetOpen}
				onOpenChange={host.setBookingSheetOpen}
				client={host.client}
				locationId={locationId}
				defaultDate={host.businessDate}
				services={services}
				areas={host.dayFeed?.areas ?? []}
				tables={host.dayFeed?.tables ?? []}
				initialLocalStartMin={host.bookingDefaults.localStartMin}
				initialPartySize={host.bookingDefaults.partySize}
				initialTableId={host.bookingDefaults.tableId}
				initialAreaId={host.bookingDefaults.areaId ?? host.selectedAreaId}
				initialServiceId={
					host.bookingDefaults.serviceId ?? host.selectedServiceId
				}
				onCreated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadOverview()
				}}
			/>

			<WalkInDialog
				open={host.walkInOpen}
				onOpenChange={host.setWalkInOpen}
				client={host.client}
				locationId={locationId}
				businessDate={host.businessDate}
				localStartMin={host.liveNow.localStartMin}
				tableStates={host.dayFeed?.tableStates ?? []}
				initialTableId={host.walkInDefaults.tableId}
				initialPartySize={host.walkInDefaults.partySize}
				onCreated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadOverview()
				}}
			/>

			<DetailSheet
				reservationId={host.detailReservationId}
				fallbackReservation={host.selectedReservation}
				onClose={host.closeDetail}
				client={host.client}
				areas={host.dayFeed?.areas ?? []}
				timeZone={host.timeZone}
				tables={host.dayFeed?.tables ?? []}
				canManage={canManage}
				onUpdated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadOverview()
				}}
			/>

			<ConflictPanel
				open={host.conflictPanelOpen}
				onOpenChange={host.setConflictPanelOpen}
				client={host.client}
				conflicts={host.dayFeed?.conflicts ?? []}
				unassigned={host.dayFeed?.unassigned ?? []}
				moveNotices={host.allMoveNotices}
				tables={host.dayFeed?.tables ?? []}
				canManage={canManage}
				onSelectReservation={host.openDetail}
				onResolved={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadOverview()
				}}
				onClearMoveNotices={host.clearMoveNotices}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
