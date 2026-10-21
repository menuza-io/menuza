import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router'
import {
	LocalizedMapField,
	ReservationLocaleProvider,
	ReservationLocaleSwitcher,
	WritingLanguageNote,
} from '#app/components/reservations/localized-fields.tsx'
import { SettingsSaveBar } from '#app/components/reservations/settings/save-bar.tsx'
import { SwitchRow } from '#app/components/reservations/settings/settings-fields.tsx'
import { SetupChecklist } from '#app/components/reservations/settings/setup-checklist.tsx'
import { SetupDiagnostics } from '#app/components/reservations/settings/setup-diagnostics.tsx'
import { useRevealedErrors } from '#app/components/reservations/settings/use-revealed-errors.ts'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { formatBusinessDate } from '#app/utils/reservations/business-date.ts'
import { cleanLocalizedMap } from '#app/utils/reservations/localized.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	extractApiErrorMessage,
	isVersionConflictError,
	type LocationSettingsDto,
	SETUP_CONFLICT_REASON_LABELS,
	updateLocationSettings,
} from '#app/utils/reservations/setup-api.ts'
import { useReservationLocales } from '#app/utils/reservations/use-reservation-locales.ts'
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

function sameSettings(a: LocationSettingsDto, b: LocationSettingsDto) {
	return JSON.stringify(a) === JSON.stringify(b)
}

export default function ReservationsSettingsIndexRoute() {
	const { _, i18n } = useLingui()
	const siteLocales = useReservationLocales()
	const {
		selectedLocationId,
		canWrite,
		client,
		settings,
		conflicts,
		setupStatus,
		setupIssues,
		setupSteps,
		markSetupStep,
		setupChecklistDismissed,
		dismissSetupChecklist,
		orgSlug,
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
	const [showAdvanced, setShowAdvanced] = useState(false)
	const { search } = useLocation()

	const dirty = useMemo(
		() => Boolean(draft && settings && !sameSettings(draft, settings)),
		[draft, settings],
	)

	// Derived from the draft on every render and revealed after a save attempt
	// or blur, so a message goes away as soon as the numbers agree again.
	const livePartyErrors: Partial<Record<'onlineRange' | 'overallMax', string>> =
		{}
	if (draft) {
		if (draft.onlinePartyMin > draft.onlinePartyMax) {
			livePartyErrors.onlineRange = _(
				msg`The online minimum cannot be more than the online maximum.`,
			)
		}
		if (draft.onlinePartyMax > draft.partyMax) {
			livePartyErrors.overallMax = _(
				msg`The online maximum cannot be more than the largest party at the host stand.`,
			)
		}
	}
	const {
		errors: partyErrors,
		attempt: attemptSave,
		touch: touchParty,
		reset: resetPartyErrors,
	} = useRevealedErrors(livePartyErrors)

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

		if (!attemptSave()) return

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
				publicNoteI18n: cleanLocalizedMap(draft.publicNoteI18n, siteLocales),
				largePartyNoteI18n: cleanLocalizedMap(
					draft.largePartyNoteI18n,
					siteLocales,
				),
			} as Partial<LocationSettingsDto> & { expectedVersion: number })
			setSettingsState(res.settings)
			setDraft(res.settings)
			setSaveSuccess(_(msg`General reservation settings saved.`))
			await refreshSummary()
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`These settings were changed by someone else. Your changes were not saved. Reload to see the latest version.`,
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

	const handleDiscard = () => {
		setDraft(settings)
		setFormError(null)
		resetPartyErrors()
		setSaveSuccess(null)
	}

	const edit = (patch: Partial<LocationSettingsDto>) => {
		setFormError(null)
		setSaveSuccess(null)
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
	}

	const handleReloadAfterConflict = async () => {
		setConflictBanner(null)
		setFormError(null)
		await refreshSummary()
	}

	if (loadingSummary && !draft) {
		return (
			<div
				className="flex flex-col gap-4"
				data-testid="setup-general-loading"
				role="status"
				aria-label={_(msg`Loading reservation settings`)}
			>
				<Skeleton className="h-48 w-full rounded-xl" />
				<Skeleton className="h-40 w-full rounded-xl" />
			</div>
		)
	}

	if (summaryError && !draft) {
		return (
			<Alert variant="destructive" data-testid="setup-general-error">
				<AlertTitle>
					<Trans>Could not load reservation settings</Trans>
				</AlertTitle>
				<AlertDescription>
					<div className="flex flex-col items-start gap-3">
						<span>{summaryError}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void refreshSummary()}
						>
							<Trans>Retry</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	const disabled = !canWrite

	return (
		<div className="flex flex-col gap-6" data-testid="setup-general-page">
			{conflictBanner ? (
				<Alert
					variant="destructive"
					data-testid="setup-settings-conflict-banner"
				>
					<Icon name="alert-triangle" />
					<AlertTitle>{conflictBanner}</AlertTitle>
					<AlertDescription>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void handleReloadAfterConflict()}
							data-testid="setup-settings-reload-button"
						>
							<Icon name="refresh-cw" />
							<Trans>Reload latest settings</Trans>
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{formError ? (
				<Alert variant="destructive" data-testid="setup-general-form-error">
					<AlertDescription>{formError}</AlertDescription>
				</Alert>
			) : null}

			<SetupChecklist
				steps={setupSteps}
				orgSlug={orgSlug}
				search={search}
				dismissed={setupChecklistDismissed}
				onGo={markSetupStep}
				onDismiss={dismissSetupChecklist}
			/>

			{/* One status for the header and this list: specific items, each with its own Fix link */}
			<div data-testid="setup-validation-panel">
				<SetupDiagnostics
					items={setupIssues}
					status={setupStatus}
					loading={loadingSummary && !setupStatus}
					search={search}
				/>
			</div>

			{draft ? (
				<form
					onSubmit={(e) => void handleSubmit(e)}
					className="flex flex-col gap-6"
					data-testid="setup-general-form"
				>
					<Frame>
						<FrameHeader>
							<FrameTitle>
								<Trans>Taking reservations</Trans>
							</FrameTitle>
							<FrameDescription>
								<Trans>
									Choose where guests can book and how bookings are confirmed.
								</Trans>
							</FrameDescription>
						</FrameHeader>
						<FramePanel className="flex flex-col gap-2">
							<SwitchRow
								testId="setup-toggle-enabled"
								checked={draft.enabled}
								disabled={disabled}
								onCheckedChange={(enabled) => edit({ enabled })}
								label={<Trans>Reservations open</Trans>}
								description={
									<Trans>
										Turn off to stop all new bookings, online and at the host
										stand.
									</Trans>
								}
							/>
							<SwitchRow
								testId="setup-toggle-online-booking"
								checked={draft.onlineBookingEnabled}
								disabled={disabled}
								onCheckedChange={(onlineBookingEnabled) =>
									edit({ onlineBookingEnabled })
								}
								label={<Trans>Online booking enabled</Trans>}
								description={
									<Trans>
										Accept guest reservations from your public website and apps.
									</Trans>
								}
							/>
							<SwitchRow
								testId="setup-toggle-auto-confirm"
								checked={draft.autoConfirmOnline}
								disabled={disabled}
								onCheckedChange={(autoConfirmOnline) =>
									edit({ autoConfirmOnline })
								}
								label={<Trans>Auto-confirm online bookings</Trans>}
								description={
									<Trans>
										Immediately confirm online bookings that do not require a
										payment step.
									</Trans>
								}
							/>
							<SwitchRow
								testId="setup-toggle-waitlist"
								checked={draft.waitlistEnabled}
								disabled={disabled}
								onCheckedChange={(waitlistEnabled) => edit({ waitlistEnabled })}
								label={<Trans>Waitlist enabled</Trans>}
								description={
									<Trans>
										Allow walk-in and remote waitlist quotes when tables are
										full.
									</Trans>
								}
							/>
						</FramePanel>
						<FramePanel className="grid grid-cols-1 gap-5 sm:grid-cols-3">
							<div data-testid="setup-slot-interval-select">
								<SelectField
									id="setup-slot-interval"
									label={<Trans>How often guests can pick a start time</Trans>}
									hint={<Trans>For example, every 15 minutes.</Trans>}
									disabled={disabled}
									value={String(draft.slotIntervalMin)}
									onValueChange={(value) =>
										edit({ slotIntervalMin: Number(value) })
									}
									options={SLOT_INTERVAL_OPTIONS.map((val) => {
										const minutes = val
										return {
											value: String(val),
											label: _(msg`${minutes} min`),
										}
									})}
								/>
							</div>
							<TextField
								id="setup-min-advance"
								type="number"
								inputMode="numeric"
								min={0}
								max={43200}
								label={<Trans>Minimum notice (minutes)</Trans>}
								hint={<Trans>0 allows bookings up to the last minute.</Trans>}
								disabled={disabled}
								value={draft.minAdvanceMinutes}
								onChange={(e) =>
									edit({ minAdvanceMinutes: Number(e.target.value) || 0 })
								}
								data-testid="setup-min-advance-input"
							/>
							<TextField
								id="setup-max-advance"
								type="number"
								inputMode="numeric"
								min={1}
								max={365}
								label={<Trans>Book up to (days ahead)</Trans>}
								disabled={disabled}
								value={draft.maxAdvanceDays}
								onChange={(e) =>
									edit({ maxAdvanceDays: Number(e.target.value) || 30 })
								}
								data-testid="setup-max-advance-input"
							/>
						</FramePanel>
					</Frame>

					<Frame>
						<FrameHeader>
							<FrameTitle>
								<Trans>Party size</Trans>
							</FrameTitle>
							<FrameDescription>
								<Trans>
									Larger parties can still be booked by your team at the host
									stand.
								</Trans>
							</FrameDescription>
						</FrameHeader>
						<FramePanel className="grid grid-cols-1 gap-5 sm:grid-cols-3">
							<TextField
								id="setup-online-party-min"
								type="number"
								inputMode="numeric"
								min={1}
								max={50}
								label={<Trans>Online minimum</Trans>}
								disabled={disabled}
								value={draft.onlinePartyMin}
								onChange={(e) =>
									edit({ onlinePartyMin: Number(e.target.value) || 1 })
								}
								data-testid="setup-online-party-min-input"
							/>
							<TextField
								id="setup-online-party-max"
								type="number"
								inputMode="numeric"
								min={1}
								max={50}
								label={<Trans>Online maximum</Trans>}
								disabled={disabled}
								value={draft.onlinePartyMax}
								error={partyErrors.onlineRange}
								onBlur={() => touchParty('onlineRange')}
								onChange={(e) =>
									edit({ onlinePartyMax: Number(e.target.value) || 8 })
								}
								data-testid="setup-online-party-max-input"
							/>
							<TextField
								id="setup-party-max"
								type="number"
								inputMode="numeric"
								min={1}
								max={99}
								label={<Trans>Largest party at the host stand</Trans>}
								disabled={disabled}
								value={draft.partyMax}
								error={partyErrors.overallMax}
								onBlur={() => touchParty('overallMax')}
								onChange={(e) =>
									edit({ partyMax: Number(e.target.value) || 20 })
								}
								data-testid="setup-party-max-input"
							/>
						</FramePanel>
					</Frame>

					<Frame>
						<FrameHeader>
							<FrameTitle>
								<Trans>Tables and timing</Trans>
							</FrameTitle>
							<FrameDescription>
								<Trans>
									How long a party keeps a table and how new bookings find one.
								</Trans>
							</FrameDescription>
						</FrameHeader>
						<FramePanel className="flex flex-col gap-5">
							<SwitchRow
								testId="setup-toggle-auto-assign"
								checked={draft.autoAssignTables}
								disabled={disabled}
								onCheckedChange={(autoAssignTables) =>
									edit({ autoAssignTables })
								}
								label={<Trans>Auto-assign best table</Trans>}
								description={
									<Trans>
										Automatically place new bookings on the best-fitting table
										or combination.
									</Trans>
								}
							/>
							<TextField
								id="setup-default-turn-time"
								type="number"
								inputMode="numeric"
								min={15}
								max={720}
								className="sm:max-w-xs"
								label={<Trans>Default dining time (minutes)</Trans>}
								hint={
									<Trans>
										Used when a service has no turn-time rule for the party
										size.
									</Trans>
								}
								disabled={disabled}
								value={draft.defaultTurnTimeMin}
								onChange={(e) =>
									edit({ defaultTurnTimeMin: Number(e.target.value) || 90 })
								}
								data-testid="setup-default-turn-time-input"
							/>
						</FramePanel>
						<FramePanel className="flex flex-col gap-5">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="-ms-2 self-start"
								aria-expanded={showAdvanced}
								aria-controls="setup-advanced-settings"
								onClick={() => setShowAdvanced((open) => !open)}
								data-testid="setup-advanced-toggle"
							>
								<Icon
									name="chevron-right"
									className={
										showAdvanced
											? 'size-4 rotate-90 transition-transform'
											: 'size-4 transition-transform rtl:rotate-180'
									}
								/>
								<Trans>
									Advanced: late arrivals, cancellation and limits per time slot
								</Trans>
							</Button>
							{showAdvanced ? (
								<div
									id="setup-advanced-settings"
									className="grid grid-cols-1 gap-5 sm:grid-cols-2"
								>
									<TextField
										id="setup-grace-period"
										type="number"
										inputMode="numeric"
										min={0}
										max={120}
										label={<Trans>Late arrival grace (minutes)</Trans>}
										hint={
											<Trans>
												How long a table is kept before a no-show is flagged.
											</Trans>
										}
										disabled={disabled}
										value={draft.gracePeriodMinutes}
										onChange={(e) =>
											edit({ gracePeriodMinutes: Number(e.target.value) || 0 })
										}
										data-testid="setup-grace-period-input"
									/>
									<TextField
										id="setup-late-cancel"
										type="number"
										inputMode="numeric"
										min={0}
										max={720}
										label={<Trans>Cancellation cutoff (hours)</Trans>}
										hint={
											<Trans>
												Guests cancel and change freely until this long before
												the booking.
											</Trans>
										}
										disabled={disabled}
										value={draft.lateCancelHours}
										onChange={(e) =>
											edit({ lateCancelHours: Number(e.target.value) || 0 })
										}
										data-testid="setup-late-cancel-input"
									/>
									<TextField
										id="setup-hold-ttl"
										type="number"
										inputMode="numeric"
										min={60}
										max={1800}
										label={<Trans>Payment hold (seconds)</Trans>}
										hint={
											<Trans>
												How long a slot is reserved while a guest pays.
											</Trans>
										}
										disabled={disabled}
										value={draft.holdTtlSeconds}
										onChange={(e) =>
											edit({ holdTtlSeconds: Number(e.target.value) || 300 })
										}
										data-testid="setup-hold-ttl-input"
									/>
									<div className="hidden sm:block" />
									<TextField
										id="setup-pacing-covers"
										type="number"
										inputMode="numeric"
										min={1}
										max={500}
										label={<Trans>Guests per time slot</Trans>}
										hint={<Trans>Empty means no limit.</Trans>}
										disabled={disabled}
										placeholder={_(msg`Unlimited`)}
										value={draft.pacingMaxCoversPerSlot ?? ''}
										onChange={(e) =>
											edit({
												pacingMaxCoversPerSlot:
													e.target.value === ''
														? null
														: Number(e.target.value) || null,
											})
										}
										data-testid="setup-pacing-covers-input"
									/>
									<TextField
										id="setup-pacing-parties"
										type="number"
										inputMode="numeric"
										min={1}
										max={100}
										label={<Trans>Parties per time slot</Trans>}
										hint={<Trans>Empty means no limit.</Trans>}
										disabled={disabled}
										placeholder={_(msg`Unlimited`)}
										value={draft.pacingMaxPartiesPerSlot ?? ''}
										onChange={(e) =>
											edit({
												pacingMaxPartiesPerSlot:
													e.target.value === ''
														? null
														: Number(e.target.value) || null,
											})
										}
										data-testid="setup-pacing-parties-input"
									/>
								</div>
							) : null}
						</FramePanel>
					</Frame>

					<ReservationLocaleProvider>
						<Frame>
							<FrameHeader>
								<div className="flex items-start justify-between gap-3">
									<div className="flex min-w-0 flex-col gap-1">
										<FrameTitle>
											<Trans>What guests read</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>
												Shown on the booking page. Write it in each language
												your website offers; guests see the default language
												where a translation is missing.
											</Trans>
										</FrameDescription>
									</div>
									<ReservationLocaleSwitcher />
								</div>
							</FrameHeader>
							<FramePanel className="grid grid-cols-1 gap-5 md:grid-cols-2">
								<LocalizedMapField
									id="setup-public-note"
									multiline
									rows={3}
									label={<Trans>Booking page note (guest-facing)</Trans>}
									hint={
										<Trans>
											A short note shown with the booking form, for example
											parking or dress code.
										</Trans>
									}
									disabled={disabled}
									value={draft.publicNoteI18n}
									onChange={(publicNoteI18n) => edit({ publicNoteI18n })}
									data-testid="setup-public-note"
								/>
								<LocalizedMapField
									id="setup-large-party-note"
									multiline
									rows={3}
									label={<Trans>Large party message (guest-facing)</Trans>}
									hint={
										<Trans>
											Shown to guests whose party is larger than you take
											online.
										</Trans>
									}
									disabled={disabled}
									value={draft.largePartyNoteI18n}
									onChange={(largePartyNoteI18n) =>
										edit({ largePartyNoteI18n })
									}
									data-testid="setup-large-party-note"
								/>
								<div className="md:col-span-2">
									<WritingLanguageNote />
								</div>
							</FramePanel>
						</Frame>
					</ReservationLocaleProvider>

					{saveSuccess ? (
						<p
							role="status"
							className="text-success flex items-center gap-2 text-sm"
							data-testid="setup-general-save-success"
						>
							<Icon name="check-circle" className="size-4" />
							{saveSuccess}
						</p>
					) : null}

					{canWrite ? (
						<SettingsSaveBar
							submit
							dirty={dirty}
							pending={saving}
							onDiscard={handleDiscard}
							saveTestId="setup-save-general-button"
						/>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>You can view these settings but not change them.</Trans>
						</p>
					)}
				</form>
			) : null}

			{/* Upcoming Reservation Conflicts */}
			<Frame data-testid="setup-conflicts-panel">
				<FrameHeader>
					<FrameTitle>
						<Trans>Upcoming reservation conflicts</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Future reservations affected by table capacity reductions,
							archived tables, shortened service windows, or closed special
							days.
						</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel>
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
										className="bg-warning/10 flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm"
										data-testid="setup-conflict-row"
									>
										<div className="flex flex-col gap-0.5">
											<span className="text-foreground font-medium">
												<bdi dir="ltr">{conflict.confirmationCode ?? '—'}</bdi>
												{' · '}
												<bdi dir="ltr">
													{conflict.businessDate
														? formatBusinessDate(
																conflict.businessDate,
																i18n.locale,
															)
														: '—'}
												</bdi>
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
				</FramePanel>
			</Frame>
		</div>
	)
}
