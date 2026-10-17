import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { type FormEvent, useEffect, useState } from 'react'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	extractApiErrorMessage,
	isVersionConflictError,
	type LocationSettingsDto,
	SETUP_CONFLICT_REASON_LABELS,
	updateLocationSettings,
} from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/settings._index.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

const SLOT_INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 60] as const

export default function ReservationsSettingsIndexRoute() {
	const { _ } = useLingui()
	const {
		selectedLocationId,
		canWrite,
		client,
		settings,
		validation,
		conflicts,
		loadingSummary,
		summaryError,
		refreshSummary,
		setSettingsState,
	} = useReservationsSetupContext()

	const [draft, setDraft] = useState<LocationSettingsDto | null>(settings)
	const [saving, setSaving] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)
	const [conflictBanner, setConflictBanner] = useState<string | null>(null)
	const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

	useEffect(() => {
		if (settings) {
			setDraft(settings)
		}
	}, [settings])

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !draft || !selectedLocationId || saving) return

		setFormError(null)
		setConflictBanner(null)
		setSaveSuccess(null)

		if (draft.onlinePartyMin > draft.onlinePartyMax) {
			setFormError(
				_(
					msg`Online minimum party size cannot exceed online maximum party size.`,
				),
			)
			return
		}
		if (draft.onlinePartyMax > draft.partyMax) {
			setFormError(
				_(
					msg`Online maximum party size cannot exceed overall maximum party size.`,
				),
			)
			return
		}

		setSaving(true)
		try {
			const res = await updateLocationSettings(client, selectedLocationId, {
				expectedVersion: draft.version,
				enabled: draft.enabled,
				onlineBookingEnabled: draft.onlineBookingEnabled,
				onlineEnabled: draft.onlineBookingEnabled,
				waitlistEnabled: draft.waitlistEnabled,
				slotIntervalMin: draft.slotIntervalMin,
				intervalMin: draft.slotIntervalMin,
				defaultTurnTimeMin: draft.defaultTurnTimeMin,
				defaultTurnMin: draft.defaultTurnTimeMin,
				minAdvanceMinutes: draft.minAdvanceMinutes,
				minNoticeMin: draft.minAdvanceMinutes,
				maxAdvanceDays: draft.maxAdvanceDays,
				horizonDays: draft.maxAdvanceDays,
				onlinePartyMin: draft.onlinePartyMin,
				onlinePartyMax: draft.onlinePartyMax,
				partyMax: draft.partyMax,
				holdTtlSeconds: draft.holdTtlSeconds,
				holdMinutes: Math.max(1, Math.round(draft.holdTtlSeconds / 60)),
				gracePeriodMinutes: draft.gracePeriodMinutes,
				lateGraceMin: draft.gracePeriodMinutes,
				lateCancelHours: draft.lateCancelHours,
				guestModifyCutoffMin: draft.lateCancelHours * 60,
				pacingMaxCoversPerSlot: draft.pacingMaxCoversPerSlot,
				pacingMaxPartiesPerSlot: draft.pacingMaxPartiesPerSlot,
				autoConfirmOnline: draft.autoConfirmOnline,
				autoAssignTables: draft.autoAssignTables,
				confirmationCopyI18n: draft.confirmationCopyI18n,
				publicNoteI18n: draft.confirmationCopyI18n,
				policyCopyI18n: draft.policyCopyI18n,
				largePartyNoteI18n: draft.policyCopyI18n,
			} as Partial<LocationSettingsDto> & { expectedVersion: number })
			setSettingsState(res.settings)
			setDraft(res.settings)
			setSaveSuccess(_(msg`General reservation settings saved.`))
			await refreshSummary()
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`These settings were updated by another operator. Your changes were not saved. Reload to view the latest version.`,
					),
				)
			} else {
				setFormError(
					extractApiErrorMessage(
						err,
						_(msg`Failed to save reservation settings.`),
					),
				)
			}
		} finally {
			setSaving(false)
		}
	}

	const handleReloadAfterConflict = async () => {
		setConflictBanner(null)
		setFormError(null)
		await refreshSummary()
	}

	if (loadingSummary && !draft) {
		return (
			<Card data-testid="setup-general-loading">
				<CardContent className="text-muted-foreground py-8">
					<Trans>Loading reservation settings…</Trans>
				</CardContent>
			</Card>
		)
	}

	if (summaryError && !draft) {
		return (
			<Card data-testid="setup-general-error">
				<CardContent className="flex flex-col gap-3 py-8">
					<p className="text-destructive font-medium">{summaryError}</p>
					<div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void refreshSummary()}
						>
							<Trans>Retry</Trans>
						</Button>
					</div>
				</CardContent>
			</Card>
		)
	}

	return (
		<div className="flex flex-col gap-6" data-testid="setup-general-page">
			{conflictBanner ? (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 p-4 text-sm"
					data-testid="setup-settings-conflict-banner"
				>
					<div className="flex items-center gap-2">
						<Icon
							name="alert-triangle"
							className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
						/>
						<span className="text-foreground font-medium">
							{conflictBanner}
						</span>
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void handleReloadAfterConflict()}
						data-testid="setup-settings-reload-button"
					>
						<Icon name="refresh-cw" className="size-3.5" />
						<Trans>Reload latest settings</Trans>
					</Button>
				</div>
			) : null}

			{formError ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
					data-testid="setup-general-form-error"
				>
					{formError}
				</div>
			) : null}

			{saveSuccess ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="setup-general-save-success"
				>
					{saveSuccess}
				</div>
			) : null}

			{/* General & Online Booking Form */}
			{draft ? (
				<form
					onSubmit={(e) => void handleSubmit(e)}
					className="flex flex-col gap-6"
					data-testid="setup-general-form"
				>
					<Card>
						<CardHeader>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div>
									<CardTitle>
										<Trans>Booking & Channel Rules</Trans>
									</CardTitle>
									<CardDescription>
										<Trans>
											Control online booking availability, slot intervals, party
											size bounds, and table assignment behavior.
										</Trans>
									</CardDescription>
								</div>
								<Badge variant="outline">v{draft.version}</Badge>
							</div>
						</CardHeader>
						<CardContent className="flex flex-col gap-6">
							{/* Toggles */}
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
								<label className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm">
									<input
										type="checkbox"
										checked={draft.enabled}
										disabled={!canWrite}
										onChange={(e) =>
											setDraft({ ...draft, enabled: e.target.checked })
										}
										className="mt-0.5"
										data-testid="setup-toggle-enabled"
									/>
									<div>
										<div className="text-foreground font-medium">
											<Trans>Location reservations active</Trans>
										</div>
										<div className="text-muted-foreground text-xs">
											<Trans>
												Allow host-stand and online reservations for this
												location.
											</Trans>
										</div>
									</div>
								</label>

								<label className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm">
									<input
										type="checkbox"
										checked={draft.onlineBookingEnabled}
										disabled={!canWrite}
										onChange={(e) =>
											setDraft({
												...draft,
												onlineBookingEnabled: e.target.checked,
											})
										}
										className="mt-0.5"
										data-testid="setup-toggle-online-booking"
									/>
									<div>
										<div className="text-foreground font-medium">
											<Trans>Online booking enabled</Trans>
										</div>
										<div className="text-muted-foreground text-xs">
											<Trans>
												Accept guest reservations from your public website and
												apps.
											</Trans>
										</div>
									</div>
								</label>

								<label className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm">
									<input
										type="checkbox"
										checked={draft.waitlistEnabled}
										disabled={!canWrite}
										onChange={(e) =>
											setDraft({ ...draft, waitlistEnabled: e.target.checked })
										}
										className="mt-0.5"
										data-testid="setup-toggle-waitlist"
									/>
									<div>
										<div className="text-foreground font-medium">
											<Trans>Waitlist enabled</Trans>
										</div>
										<div className="text-muted-foreground text-xs">
											<Trans>
												Allow walk-in and remote waitlist quotes when tables are
												full.
											</Trans>
										</div>
									</div>
								</label>

								<label className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm">
									<input
										type="checkbox"
										checked={draft.autoConfirmOnline}
										disabled={!canWrite}
										onChange={(e) =>
											setDraft({
												...draft,
												autoConfirmOnline: e.target.checked,
											})
										}
										className="mt-0.5"
										data-testid="setup-toggle-auto-confirm"
									/>
									<div>
										<div className="text-foreground font-medium">
											<Trans>Auto-confirm online bookings</Trans>
										</div>
										<div className="text-muted-foreground text-xs">
											<Trans>
												Immediately confirm online bookings that do not require
												a payment step.
											</Trans>
										</div>
									</div>
								</label>

								<label className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm">
									<input
										type="checkbox"
										checked={draft.autoAssignTables}
										disabled={!canWrite}
										onChange={(e) =>
											setDraft({ ...draft, autoAssignTables: e.target.checked })
										}
										className="mt-0.5"
										data-testid="setup-toggle-auto-assign"
									/>
									<div>
										<div className="text-foreground font-medium">
											<Trans>Auto-assign best table</Trans>
										</div>
										<div className="text-muted-foreground text-xs">
											<Trans>
												Automatically place new bookings on the best-fitting
												table or combination.
											</Trans>
										</div>
									</div>
								</label>
							</div>

							{/* Numeric settings */}
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-slot-interval">
										<Trans>Slot interval (minutes)</Trans>
									</Label>
									<select
										id="setup-slot-interval"
										disabled={!canWrite}
										value={draft.slotIntervalMin}
										onChange={(e) =>
											setDraft({
												...draft,
												slotIntervalMin: Number(e.target.value),
											})
										}
										className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
										data-testid="setup-slot-interval-select"
									>
										{SLOT_INTERVAL_OPTIONS.map((val) => (
											<option key={val} value={val}>
												{val} min
											</option>
										))}
									</select>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-default-turn-time">
										<Trans>Default turn time (min)</Trans>
									</Label>
									<Input
										id="setup-default-turn-time"
										type="number"
										min={15}
										max={720}
										disabled={!canWrite}
										value={draft.defaultTurnTimeMin}
										onChange={(e) =>
											setDraft({
												...draft,
												defaultTurnTimeMin: Number(e.target.value) || 90,
											})
										}
										data-testid="setup-default-turn-time-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-min-advance">
										<Trans>Min advance notice (min)</Trans>
									</Label>
									<Input
										id="setup-min-advance"
										type="number"
										min={0}
										max={43200}
										disabled={!canWrite}
										value={draft.minAdvanceMinutes}
										onChange={(e) =>
											setDraft({
												...draft,
												minAdvanceMinutes: Number(e.target.value) || 0,
											})
										}
										data-testid="setup-min-advance-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-max-advance">
										<Trans>Max advance window (days)</Trans>
									</Label>
									<Input
										id="setup-max-advance"
										type="number"
										min={1}
										max={365}
										disabled={!canWrite}
										value={draft.maxAdvanceDays}
										onChange={(e) =>
											setDraft({
												...draft,
												maxAdvanceDays: Number(e.target.value) || 30,
											})
										}
										data-testid="setup-max-advance-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-online-party-min">
										<Trans>Online min party size</Trans>
									</Label>
									<Input
										id="setup-online-party-min"
										type="number"
										min={1}
										max={50}
										disabled={!canWrite}
										value={draft.onlinePartyMin}
										onChange={(e) =>
											setDraft({
												...draft,
												onlinePartyMin: Number(e.target.value) || 1,
											})
										}
										data-testid="setup-online-party-min-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-online-party-max">
										<Trans>Online max party size</Trans>
									</Label>
									<Input
										id="setup-online-party-max"
										type="number"
										min={1}
										max={50}
										disabled={!canWrite}
										value={draft.onlinePartyMax}
										onChange={(e) =>
											setDraft({
												...draft,
												onlinePartyMax: Number(e.target.value) || 8,
											})
										}
										data-testid="setup-online-party-max-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-party-max">
										<Trans>Max party size (host stand)</Trans>
									</Label>
									<Input
										id="setup-party-max"
										type="number"
										min={1}
										max={99}
										disabled={!canWrite}
										value={draft.partyMax}
										onChange={(e) =>
											setDraft({
												...draft,
												partyMax: Number(e.target.value) || 20,
											})
										}
										data-testid="setup-party-max-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-grace-period">
										<Trans>Arrival grace period (min)</Trans>
									</Label>
									<Input
										id="setup-grace-period"
										type="number"
										min={0}
										max={120}
										disabled={!canWrite}
										value={draft.gracePeriodMinutes}
										onChange={(e) =>
											setDraft({
												...draft,
												gracePeriodMinutes: Number(e.target.value) || 0,
											})
										}
										data-testid="setup-grace-period-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-hold-ttl">
										<Trans>Checkout hold TTL (seconds)</Trans>
									</Label>
									<Input
										id="setup-hold-ttl"
										type="number"
										min={60}
										max={1800}
										disabled={!canWrite}
										value={draft.holdTtlSeconds}
										onChange={(e) =>
											setDraft({
												...draft,
												holdTtlSeconds: Number(e.target.value) || 300,
											})
										}
										data-testid="setup-hold-ttl-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-late-cancel">
										<Trans>Cancellation cutoff (hours)</Trans>
									</Label>
									<Input
										id="setup-late-cancel"
										type="number"
										min={0}
										max={720}
										disabled={!canWrite}
										value={draft.lateCancelHours}
										onChange={(e) =>
											setDraft({
												...draft,
												lateCancelHours: Number(e.target.value) || 0,
											})
										}
										data-testid="setup-late-cancel-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-pacing-covers">
										<Trans>Default max covers / slot</Trans>
									</Label>
									<Input
										id="setup-pacing-covers"
										type="number"
										min={1}
										max={500}
										disabled={!canWrite}
										placeholder={_(msg`Unlimited`)}
										value={draft.pacingMaxCoversPerSlot ?? ''}
										onChange={(e) =>
											setDraft({
												...draft,
												pacingMaxCoversPerSlot:
													e.target.value === ''
														? null
														: Number(e.target.value) || null,
											})
										}
										data-testid="setup-pacing-covers-input"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-pacing-parties">
										<Trans>Default max parties / slot</Trans>
									</Label>
									<Input
										id="setup-pacing-parties"
										type="number"
										min={1}
										max={100}
										disabled={!canWrite}
										placeholder={_(msg`Unlimited`)}
										value={draft.pacingMaxPartiesPerSlot ?? ''}
										onChange={(e) =>
											setDraft({
												...draft,
												pacingMaxPartiesPerSlot:
													e.target.value === ''
														? null
														: Number(e.target.value) || null,
											})
										}
										data-testid="setup-pacing-parties-input"
									/>
								</div>
							</div>

							{/* Guest confirmation & policy copy */}
							<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-confirmation-copy-en">
										<Trans>Confirmation message (English)</Trans>
									</Label>
									<Textarea
										id="setup-confirmation-copy-en"
										rows={2}
										disabled={!canWrite}
										value={draft.confirmationCopyI18n?.en ?? ''}
										onChange={(e) =>
											setDraft({
												...draft,
												confirmationCopyI18n: {
													...draft.confirmationCopyI18n,
													en: e.target.value,
												},
											})
										}
										data-testid="setup-confirmation-copy-en"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-confirmation-copy-ar">
										<Trans>Confirmation message (Arabic)</Trans>
									</Label>
									<Textarea
										id="setup-confirmation-copy-ar"
										rows={2}
										dir="rtl"
										disabled={!canWrite}
										value={draft.confirmationCopyI18n?.ar ?? ''}
										onChange={(e) =>
											setDraft({
												...draft,
												confirmationCopyI18n: {
													...draft.confirmationCopyI18n,
													ar: e.target.value,
												},
											})
										}
										data-testid="setup-confirmation-copy-ar"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-policy-copy-en">
										<Trans>Booking & cancellation policy (English)</Trans>
									</Label>
									<Textarea
										id="setup-policy-copy-en"
										rows={2}
										disabled={!canWrite}
										value={draft.policyCopyI18n?.en ?? ''}
										onChange={(e) =>
											setDraft({
												...draft,
												policyCopyI18n: {
													...draft.policyCopyI18n,
													en: e.target.value,
												},
											})
										}
										data-testid="setup-policy-copy-en"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-policy-copy-ar">
										<Trans>Booking & cancellation policy (Arabic)</Trans>
									</Label>
									<Textarea
										id="setup-policy-copy-ar"
										rows={2}
										dir="rtl"
										disabled={!canWrite}
										value={draft.policyCopyI18n?.ar ?? ''}
										onChange={(e) =>
											setDraft({
												...draft,
												policyCopyI18n: {
													...draft.policyCopyI18n,
													ar: e.target.value,
												},
											})
										}
										data-testid="setup-policy-copy-ar"
									/>
								</div>
							</div>

							<div className="flex items-center justify-end gap-3">
								<Button
									type="submit"
									disabled={!canWrite || saving}
									data-testid="setup-save-general-button"
								>
									<Icon name="check" className="size-4" />
									{saving ? (
										<Trans>Saving…</Trans>
									) : (
										<Trans>Save settings</Trans>
									)}
								</Button>
							</div>
						</CardContent>
					</Card>
				</form>
			) : null}

			{/* Setup Validation Panel */}
			<Card data-testid="setup-validation-panel">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Icon name="shield-check" className="size-4" />
						<Trans>Setup Diagnostics & Completeness</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Checks dining areas, active bookable tables, service windows, and
							turn-time bucket coverage across party sizes.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{!validation ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No validation data available yet.</Trans>
						</p>
					) : validation.issues.length === 0 ? (
						<div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
							<Icon name="check-circle" className="size-4" />
							<Trans>
								All setup checks passed. Online and host-stand booking have full
								table, service, and turn-time coverage.
							</Trans>
						</div>
					) : (
						<ul
							className="flex flex-col gap-2"
							data-testid="setup-validation-issues-list"
						>
							{validation.issues.map((issue, idx) => (
								<li
									key={`${issue.code}-${idx}`}
									className={
										issue.severity === 'error'
											? 'border-destructive/30 bg-destructive/10 text-destructive flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm'
											: 'flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200'
									}
								>
									<div className="flex items-center gap-2">
										<Icon
											name={
												issue.severity === 'error'
													? 'octagon-alert'
													: 'alert-triangle'
											}
											className="size-4 shrink-0"
										/>
										<span>{issue.message}</span>
									</div>
									<Badge variant="outline">{issue.code}</Badge>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</Card>

			{/* Upcoming Reservation Conflicts Panel */}
			<Card data-testid="setup-conflicts-panel">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Icon name="alert-triangle" className="size-4" />
						<Trans>Upcoming Reservation Conflicts</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Future reservations affected by table capacity reductions,
							archived tables, shortened service windows, or closed special
							days.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{conflicts.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-conflicts-empty"
						>
							<Trans>
								No upcoming reservations are in conflict with the current setup.
							</Trans>
						</p>
					) : (
						<ul
							className="flex flex-col gap-2"
							data-testid="setup-conflicts-list"
						>
							{conflicts.map((conflict, index) => {
								const partySize = conflict.partySize
								return (
									<li
										key={`${conflict.reservationId}-${conflict.kind}-${conflict.tableId ?? conflict.serviceId ?? index}`}
										className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
										data-testid="setup-conflict-row"
									>
										<div className="flex flex-col gap-0.5">
											<span className="text-foreground font-medium">
												<bdi dir="ltr">{conflict.confirmationCode ?? '—'}</bdi>
												{' · '}
												<bdi dir="ltr">{conflict.businessDate ?? '—'}</bdi>
												{partySize !== null
													? ` · ${_(msg`Party of ${partySize}`)}`
													: ''}
											</span>
											{conflict.detail ? (
												<span className="text-muted-foreground text-xs">
													{conflict.detail}
												</span>
											) : null}
										</div>
										<Badge variant="secondary">
											{_(SETUP_CONFLICT_REASON_LABELS[conflict.reason])}
										</Badge>
									</li>
								)
							})}
						</ul>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
