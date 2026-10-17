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
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	type DayOverviewResponse,
	fetchBookOverview,
	saveServiceNotes,
} from '#app/utils/reservations/book-api.ts'
import { enumLabel, VIP_TIER_LABELS } from '#app/utils/reservations/labels.ts'
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

	const [overview, setOverview] = useState<DayOverviewResponse | null>(null)
	const [loadingOverview, setLoadingOverview] = useState(true)
	const [overviewError, setOverviewError] = useState<string | null>(null)

	// Per-service notes state keyed by (locationId, businessDate, selectedServiceId)
	const [noteDraft, setNoteDraft] = useState('')
	const [noteDirty, setNoteDirty] = useState(false)
	const [savingNote, setSavingNote] = useState(false)
	const [noteSavedBanner, setNoteSavedBanner] = useState<string | null>(null)
	const [noteError, setNoteError] = useState<string | null>(null)

	const loadOverview = useCallback(async () => {
		if (!locationId || !host.businessDate) {
			setLoadingOverview(false)
			return
		}
		setLoadingOverview(true)
		setOverviewError(null)
		try {
			const res = await fetchBookOverview(host.client, {
				locationId,
				date: host.businessDate,
				serviceId: host.selectedServiceId,
			})
			setOverview(res)
		} catch (err) {
			setOverviewError(
				err instanceof Error
					? err.message
					: t`Failed to load pre-service overview.`,
			)
		} finally {
			setLoadingOverview(false)
		}
	}, [host.businessDate, host.client, host.selectedServiceId, locationId, t])

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
				err instanceof Error ? err.message : t`Failed to save service notes.`,
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
				onRefresh={() => {
					void host.poll.refresh({ force: true })
					void loadOverview()
				}}
				serviceNotes={
					overview?.serviceNotes ?? host.dayFeed?.serviceNotes ?? []
				}
			/>

			{overviewError || host.poll.error ? (
				<Alert variant="destructive" data-testid="overview-error-banner">
					<AlertDescription>
						{overviewError ?? host.poll.error}
					</AlertDescription>
				</Alert>
			) : null}

			{/* Pre-service KPI summary strip */}
			<div
				className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
				data-testid="overview-kpi-grid"
			>
				<Card data-testid="overview-kpi-covers">
					<CardContent className="p-3">
						<div className="text-muted-foreground text-xs">
							<Trans>Expected Covers</Trans>
						</div>
						<div
							className="mt-1 text-2xl font-bold"
							dir="ltr"
							data-testid="overview-total-covers"
						>
							{overview?.stats.expectedCovers ?? 0}
						</div>
					</CardContent>
				</Card>

				<Card data-testid="overview-kpi-parties">
					<CardContent className="p-3">
						<div className="text-muted-foreground text-xs">
							<Trans>Total Parties</Trans>
						</div>
						<div
							className="mt-1 text-2xl font-bold"
							dir="ltr"
							data-testid="overview-total-parties"
						>
							{overview?.stats.partyCount ?? 0}
						</div>
					</CardContent>
				</Card>

				<Card data-testid="overview-kpi-large-parties">
					<CardContent className="p-3">
						<div className="text-muted-foreground text-xs">
							<Trans>Large Parties (6+)</Trans>
						</div>
						<div
							className="mt-1 text-2xl font-bold"
							dir="ltr"
							data-testid="overview-large-parties-count"
						>
							{overview?.stats.largePartiesCount ?? largeParties.length}
						</div>
					</CardContent>
				</Card>

				<Card data-testid="overview-kpi-vips">
					<CardContent className="p-3">
						<div className="text-muted-foreground text-xs">
							<Trans>VIP & Tagged</Trans>
						</div>
						<div
							className="mt-1 text-2xl font-bold"
							dir="ltr"
							data-testid="overview-vips-count"
						>
							{overview?.stats.vipsCount ?? vips.length}
						</div>
					</CardContent>
				</Card>

				<Card data-testid="overview-kpi-occasions">
					<CardContent className="p-3">
						<div className="text-muted-foreground text-xs">
							<Trans>Occasions</Trans>
						</div>
						<div
							className="mt-1 text-2xl font-bold"
							dir="ltr"
							data-testid="overview-occasions-count"
						>
							{overview?.stats.occasionsCount ?? occasions.length}
						</div>
					</CardContent>
				</Card>

				<Card data-testid="overview-kpi-allergies">
					<CardContent className="p-3">
						<div className="text-muted-foreground text-xs">
							<Trans>Dietary / Allergies</Trans>
						</div>
						<div
							className="mt-1 text-2xl font-bold"
							dir="ltr"
							data-testid="overview-allergies-count"
						>
							{overview?.stats.allergiesCount ?? allergies.length}
						</div>
					</CardContent>
				</Card>
			</div>

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
										Keyed to {host.businessDate} · {activeServiceName}
									</Trans>
								</CardDescription>
							</div>

							{/* Quick service period switcher pills */}
							{services.length > 0 ? (
								<div
									className="bg-muted inline-flex flex-wrap items-center gap-1 rounded-lg p-1"
									data-testid="overview-service-tabs"
								>
									<button
										type="button"
										onClick={() => host.setServiceId(null)}
										data-testid="overview-service-tab-all"
										className={`rounded-md px-2 py-1 text-xs font-medium transition ${
											!host.selectedServiceId
												? 'bg-background text-foreground shadow-xs'
												: 'text-muted-foreground hover:text-foreground'
										}`}
									>
										<Trans>All / Day</Trans>
									</button>
									{services.map((svc) => {
										const isSelected = host.selectedServiceId === svc.id
										return (
											<button
												key={svc.id}
												type="button"
												onClick={() => host.setServiceId(svc.id)}
												data-testid={`overview-service-tab-${svc.id}`}
												className={`rounded-md px-2 py-1 text-xs font-medium transition ${
													isSelected
														? 'bg-background text-foreground shadow-xs'
														: 'text-muted-foreground hover:text-foreground'
												}`}
											>
												{svc.name}
											</button>
										)
									})}
								</div>
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
								className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-800 dark:text-emerald-300"
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
										{peakSlots.map((s) => s.hhmm).join(', ')} ({peakCovers}{' '}
										{t`covers`})
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
											className={`flex items-center gap-3 rounded-lg border px-3 py-1.5 text-xs ${
												isPeak
													? 'border-amber-500/50 bg-amber-500/10 font-semibold'
													: 'border-border bg-card'
											}`}
										>
											<span className="w-14 shrink-0 font-mono" dir="ltr">
												{slot.hhmm}
											</span>
											<div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
												<div
													className={`h-full rounded-full ${
														isPeak ? 'bg-amber-500' : 'bg-primary'
													}`}
													style={{ width: `${widthPct}%` }}
												/>
											</div>
											<span className="w-28 shrink-0 text-end" dir="ltr">
												{slot.covers} {t`covers`} · {slot.parties} {t`parties`}
											</span>
											{isPeak ? (
												<Badge
													variant="secondary"
													className="px-1.5 py-0 text-[10px]"
												>
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
				{/* Large Parties (6+) */}
				<Card data-testid="overview-large-parties-card">
					<CardHeader className="pb-2">
						<div className="flex items-center justify-between">
							<CardTitle className="text-base">
								<Trans>Large Parties (6+ Covers)</Trans>
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
										<button
											type="button"
											onClick={() => host.openDetail(rsv.id)}
											className="text-start font-semibold hover:underline"
										>
											<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName}
										</button>
										<span className="text-muted-foreground text-xs">
											{rsv.assignedTableLabels.length > 0
												? rsv.assignedTableLabels.join(', ')
												: t`Unassigned`}
										</span>
									</div>
									<Badge variant="default" dir="ltr">
										{rsv.partySize} {t`guests`}
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
							<Badge variant="secondary" dir="ltr">
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
										<button
											type="button"
											onClick={() => host.openDetail(rsv.id)}
											className="text-start font-semibold hover:underline"
										>
											<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName} (
											<span dir="ltr">{rsv.partySize}</span>)
										</button>
										<div className="flex flex-wrap items-center gap-1">
											{rsv.guest?.vipTier && rsv.guest.vipTier !== 'none' ? (
												<Badge variant="default" className="text-[10px]">
													VIP:{' '}
													{enumLabel(
														(d) => i18n._(d),
														VIP_TIER_LABELS,
														rsv.guest.vipTier,
													)}
												</Badge>
											) : null}
											{(rsv.guest?.tags ?? []).map((tag) => (
												<Badge
													key={tag.id}
													variant="outline"
													className="text-[10px]"
												>
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
							<Badge variant="secondary" dir="ltr">
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
										<button
											type="button"
											onClick={() => host.openDetail(rsv.id)}
											className="text-start font-semibold hover:underline"
										>
											<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName} (
											<span dir="ltr">{rsv.partySize}</span>)
										</button>
										{rsv.guestNotes ? (
											<span className="text-muted-foreground text-xs">
												{rsv.guestNotes}
											</span>
										) : null}
									</div>
									<Badge variant="outline" className="capitalize">
										{rsv.occasion ?? t`Occasion`}
									</Badge>
								</div>
							))
						)}
					</CardContent>
				</Card>

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
											<button
												type="button"
												onClick={() => host.openDetail(rsv.id)}
												className="text-start font-semibold hover:underline"
											>
												<span dir="ltr">{rsv.hhmm}</span> · {rsv.guestName} (
												<span dir="ltr">{rsv.partySize}</span>)
											</button>
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
										<Badge variant="destructive" className="text-[10px]">
											<Trans>Allergy / Dietary</Trans>
										</Badge>
									</div>
								)
							})
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
