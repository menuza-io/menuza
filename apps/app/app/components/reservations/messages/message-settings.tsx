import { Trans, useLingui } from '@lingui/react/macro'
import { getSiteLocaleLabel } from '@repo/common/site-locales'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { FieldLabel } from '@repo/ui/field'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Switch } from '@repo/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	LocalizedMapField,
	ReservationLocaleProvider,
	ReservationLocaleSwitcher,
	useActiveLocale,
	WritingLanguageNote,
} from '#app/components/reservations/localized-fields.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { type LocalizedMap } from '#app/utils/reservations/localized.ts'
import {
	fetchMessageSettings,
	type MessageSettings,
	saveMessageSettings,
	settingsFromConflict,
} from '#app/utils/reservations/messages-api.ts'
import {
	buildPatch,
	draftFromSettings,
	hasIssues,
	HOURS_MAX,
	HOURS_MIN,
	isDraftDirty,
	type MessageDraft,
	noteSlot,
	rebaseDraft,
	validateDraft,
	visibleKinds,
} from '#app/utils/reservations/messages-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	extractApiErrorMessage,
	isVersionConflictError,
} from '#app/utils/reservations/setup-api.ts'
import { useReservationLocales } from '#app/utils/reservations/use-reservation-locales.ts'
import {
	MESSAGE_KIND_DESCRIPTIONS,
	MESSAGE_KIND_LABELS,
} from './message-labels.ts'
import { MessagePreview } from './message-preview.tsx'

/**
 * A message setting that is on or off. Local twin of `SwitchField` that also
 * carries the test id and the aria wiring the screen's tests rely on.
 */
function MessageSwitchRow({
	label,
	description,
	checked,
	onCheckedChange,
	disabled,
	testId,
	descriptionTestId,
	children,
}: {
	label: ReactNode
	description?: ReactNode
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	disabled?: boolean
	testId: string
	descriptionTestId?: string
	children?: ReactNode
}) {
	const id = useId()
	return (
		<div className="flex flex-col gap-3">
			<div className="flex min-h-11 shrink-0 items-start justify-between gap-4 py-1">
				<div className="flex min-w-0 flex-col gap-0.5">
					<FieldLabel
						id={`${id}-label`}
						htmlFor={id}
						className="text-sm font-medium"
					>
						{label}
					</FieldLabel>
					{description ? (
						<p
							id={`${id}-description`}
							className="text-muted-foreground text-sm text-pretty"
							data-testid={descriptionTestId}
						>
							{description}
						</p>
					) : null}
				</div>
				<Switch
					id={id}
					checked={checked}
					onCheckedChange={(next) => onCheckedChange(Boolean(next))}
					disabled={disabled}
					aria-labelledby={`${id}-label`}
					aria-describedby={description ? `${id}-description` : undefined}
					className="mt-0.5"
					data-testid={testId}
				/>
			</div>
			{children}
		</div>
	)
}

type Props = {
	client: ReservationsScopedClient
	locationId: string
	canWrite: boolean
	/** The waitlist module is on, so its message kinds are configurable. */
	waitlistEnabled: boolean
	dataRegion: 'us' | 'ksa'
}

/** One kind's note: the active language's text, with a counter and a preview shortcut. */
function NoteRow({
	kind,
	label,
	notes,
	noteMaxLength,
	tooLongSlots,
	disabled,
	onPreview,
	onChange,
}: {
	kind: string
	label: string
	notes: LocalizedMap
	noteMaxLength: number
	tooLongSlots: string[]
	disabled: boolean
	onPreview: () => void
	onChange: (next: LocalizedMap) => void
}) {
	const { t } = useLingui()
	const { activeLocale } = useActiveLocale()
	const length = (notes[activeLocale] ?? '').length
	const tooLong = tooLongSlots.includes(noteSlot(kind, activeLocale))
	const counter = t`${length} of ${noteMaxLength} characters`
	return (
		<div
			className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
			data-testid={`message-note-row-${kind}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="text-sm font-medium">{label}</span>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={onPreview}
					data-testid={`message-preview-pick-${kind}`}
				>
					<Trans>Preview</Trans>
				</Button>
			</div>
			<LocalizedMapField
				multiline
				id={`message-note-${kind}`}
				label={t`${label} note (guest-facing)`}
				rows={2}
				value={notes}
				disabled={disabled}
				hint={
					tooLong ? undefined : <bdi className="tabular-nums">{counter}</bdi>
				}
				error={tooLong ? counter : null}
				onChange={onChange}
				data-testid={`message-note-${kind}`}
			/>
		</div>
	)
}

export function MessageSettingsScreen({
	client,
	locationId,
	canWrite,
	waitlistEnabled,
	dataRegion,
}: Props) {
	const { t, i18n } = useLingui()
	const languages = useReservationLocales()
	const [settings, setSettings] = useState<MessageSettings | null>(null)
	const [draft, setDraft] = useState<MessageDraft | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [notice, setNotice] = useState<'saved' | 'conflict' | null>(null)
	const [previewKind, setPreviewKind] = useState('confirmation')
	const [chosenPreviewLocale, setPreviewLocale] = useState<string | null>(null)
	const previewLocale =
		chosenPreviewLocale && languages.locales.includes(chosenPreviewLocale)
			? chosenPreviewLocale
			: languages.defaultLocale
	const previewCardRef = useRef<HTMLDivElement>(null)

	const base = useMemo(
		() => (settings ? draftFromSettings(settings) : null),
		[settings],
	)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true)
			setLoadError(null)
			try {
				const next = await fetchMessageSettings(client, locationId, signal)
				if (signal?.aborted) return
				setSettings(next)
				setDraft(draftFromSettings(next))
			} catch {
				if (signal?.aborted) return
				// Plain copy only: the server's own wording is never shown here.
				setLoadError(t`Guest message settings could not be loaded.`)
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[client, locationId, t],
	)

	useEffect(() => {
		const controller = new AbortController()
		setSettings(null)
		setDraft(null)
		setNotice(null)
		setSaveError(null)
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const noteMaxLength = settings?.noteMaxLength ?? 500
	const kinds = useMemo(
		() => (settings ? visibleKinds(settings, waitlistEnabled) : []),
		[settings, waitlistEnabled],
	)
	const issues = useMemo(
		() => (draft ? validateDraft(draft, noteMaxLength) : null),
		[draft, noteMaxLength],
	)
	const dirty = Boolean(draft && base && isDraftDirty(draft, base))
	// An invalid edit is not "dirty" to the patch builder but still unsaved.
	const edited = Boolean(
		draft && base && JSON.stringify(draft) !== JSON.stringify(base),
	)
	const previewKindValue = kinds.some((k) => k.kind === previewKind)
		? previewKind
		: (kinds[0]?.kind ?? previewKind)

	// The preview lives in its own card below the notes, and "confirmation" is
	// already selected on load, so choosing a kind alone changes nothing on
	// screen. Bring the card into view and move focus to it so the click always
	// has a visible result.
	const openPreview = (kind: string) => {
		setPreviewKind(kind)
		const card = previewCardRef.current
		if (!card) return
		const reduceMotion =
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		card.scrollIntoView?.({
			behavior: reduceMotion ? 'auto' : 'smooth',
			block: 'start',
		})
		card.focus({ preventScroll: true })
	}
	const savedNote = (kind: string, locale: string) =>
		settings?.kinds.find((entry) => entry.kind === kind)?.notes[locale] ?? ''
	const previewHasNote =
		savedNote(previewKindValue, previewLocale).trim() !== ''

	const update = (change: (current: MessageDraft) => MessageDraft) => {
		setDraft((current) => (current ? change(current) : current))
		setNotice(null)
	}

	const kindLabel = (kind: string) =>
		MESSAGE_KIND_LABELS[kind] ? i18n._(MESSAGE_KIND_LABELS[kind]) : kind

	const handleSave = async () => {
		if (!canWrite || saving || !settings || !draft || !base || !issues) return
		if (hasIssues(issues)) return
		const patch = buildPatch(draft, base, settings.version)
		if (!patch) return
		setSaving(true)
		setSaveError(null)
		setNotice(null)
		try {
			const saved = await saveMessageSettings(client, locationId, patch)
			setSettings(saved)
			setDraft(draftFromSettings(saved))
			setNotice('saved')
		} catch (err) {
			if (isVersionConflictError(err)) {
				try {
					const latest =
						settingsFromConflict(err) ??
						(await fetchMessageSettings(client, locationId))
					setSettings(latest)
					setDraft(rebaseDraft(draft, base, draftFromSettings(latest)))
					setNotice('conflict')
				} catch (reloadErr) {
					setSaveError(
						extractApiErrorMessage(
							reloadErr,
							t`These settings changed elsewhere and the latest version could not be loaded. Reload the page and try again.`,
						),
					)
				}
			} else {
				setSaveError(
					extractApiErrorMessage(
						err,
						t`Guest message settings could not be saved.`,
					),
				)
			}
		} finally {
			setSaving(false)
		}
	}

	if (loading && !draft) {
		return (
			<div
				className="flex flex-col gap-4"
				role="status"
				data-testid="message-settings-loading"
			>
				<span className="sr-only">
					<Trans>Loading guest message settings…</Trans>
				</span>
				<Skeleton className="h-48 w-full rounded-xl" />
				<Skeleton className="h-32 w-full rounded-xl" />
			</div>
		)
	}

	if (loadError || !draft || !settings || !issues) {
		return (
			<Alert variant="destructive" data-testid="message-settings-load-error">
				<Icon name="alert-triangle" aria-hidden />
				<AlertDescription>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span>
							{loadError ?? t`Guest message settings could not be loaded.`}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void load()}
						>
							<Trans>Try again</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	const readOnly = !canWrite
	const controlsDisabled = readOnly || saving
	const hoursError = t`Enter a whole number of hours from ${HOURS_MIN} to ${HOURS_MAX}.`
	const kindOptions = kinds.map((entry) => ({
		value: entry.kind,
		label: kindLabel(entry.kind),
	}))

	return (
		<div
			className="flex flex-col gap-6"
			data-testid="reservations-settings-messages-page"
		>
			{readOnly ? (
				<Alert data-testid="message-read-only">
					<Icon name="lock" aria-hidden />
					<AlertDescription>
						<Trans>You can view these settings but not change them.</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{notice === 'conflict' ? (
				<Alert data-testid="message-conflict">
					<Icon name="alert-triangle" aria-hidden />
					<AlertDescription>
						<Trans>
							Someone else changed these settings while you were editing. The
							latest version is loaded and your edits are kept. Review them and
							save again.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{notice === 'saved' ? (
				<div
					role="status"
					className="bg-success/10 text-success flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
					data-testid="message-saved"
				>
					<Icon name="check-circle" className="size-4 shrink-0" aria-hidden />
					<Trans>Guest message settings saved.</Trans>
				</div>
			) : null}
			{saveError ? (
				<Alert variant="destructive" data-testid="message-error">
					<AlertDescription>{saveError}</AlertDescription>
				</Alert>
			) : null}

			<Frame data-testid="message-kinds-card">
				<FrameHeader>
					<FrameTitle>
						<Trans>Messages to send</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Switch off any message you do not want guests to receive. Payment
							messages follow the payment flow and are not listed here.
						</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel>
					<div className="flex flex-col divide-y">
						{kinds.map((entry) => {
							const kind = entry.kind
							const enabled = Boolean(draft.kinds[kind])
							const isReminder = kind === 'reminder'
							const isReconfirm = kind === 'reconfirm_request'
							const hoursInvalid = isReminder
								? issues.reminderHours
								: issues.reconfirmHours
							return (
								<div
									key={kind}
									className="py-3 first:pt-0 last:pb-0"
									data-testid={`message-kind-row-${kind}`}
								>
									<MessageSwitchRow
										label={kindLabel(kind)}
										description={
											MESSAGE_KIND_DESCRIPTIONS[kind]
												? i18n._(MESSAGE_KIND_DESCRIPTIONS[kind])
												: undefined
										}
										checked={enabled}
										disabled={controlsDisabled}
										onCheckedChange={(checked) =>
											update((d) => ({
												...d,
												kinds: { ...d.kinds, [kind]: checked },
											}))
										}
										testId={`message-kind-switch-${kind}`}
									>
										{isReminder || isReconfirm ? (
											<TextField
												className="max-w-xs"
												label={
													isReminder ? (
														<Trans>
															Send the reminder this many hours before
														</Trans>
													) : (
														<Trans>
															Ask for reconfirmation this many hours before
														</Trans>
													)
												}
												type="number"
												inputMode="numeric"
												min={HOURS_MIN}
												max={HOURS_MAX}
												value={
													isReminder
														? draft.reminderHours
														: draft.reconfirmHours
												}
												disabled={controlsDisabled}
												error={hoursInvalid ? hoursError : null}
												onChange={(event) => {
													const value = event.target.value
													update((d) =>
														isReminder
															? { ...d, reminderHours: value }
															: { ...d, reconfirmHours: value },
													)
												}}
												data-testid={
													isReminder
														? 'message-reminder-hours'
														: 'message-reconfirm-hours'
												}
											/>
										) : null}
									</MessageSwitchRow>
								</div>
							)
						})}
					</div>
				</FramePanel>
			</Frame>

			<Frame data-testid="message-delivery-card">
				<FrameHeader>
					<FrameTitle>
						<Trans>Delivery</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Email is the default channel. Text messages and quiet hours are
							set here.
						</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="flex flex-col gap-5">
					<MessageSwitchRow
						label={<Trans>Send text messages</Trans>}
						checked={draft.smsEnabled}
						disabled={controlsDisabled || dataRegion === 'ksa'}
						onCheckedChange={(checked) =>
							update((d) => ({ ...d, smsEnabled: checked }))
						}
						testId="message-sms-switch"
						descriptionTestId="message-sms-note"
						description={
							dataRegion === 'ksa' ? (
								<Trans>
									Guests of this location receive email only, because text
									messages are not sent from the Saudi Arabia region. This
									setting has no effect here.
								</Trans>
							) : (
								<Trans>
									Text messages are sent only to guests who opted in, and only
									from the US region. Guests of locations in Saudi Arabia
									receive email only.
								</Trans>
							)
						}
					/>
					<MessageSwitchRow
						label={<Trans>Quiet hours</Trans>}
						checked={draft.quietEnabled}
						disabled={controlsDisabled}
						onCheckedChange={(checked) =>
							update((d) => ({ ...d, quietEnabled: checked }))
						}
						testId="message-quiet-switch"
						description={
							<Trans>
								Scheduled reminders avoid these hours (location time).
								Confirmations and other immediate messages are always sent right
								away.
							</Trans>
						}
					>
						{draft.quietEnabled ? (
							<div className="grid max-w-md grid-cols-2 gap-3">
								<TextField
									label={<Trans>Quiet hours start</Trans>}
									type="time"
									value={draft.quietStart}
									disabled={controlsDisabled}
									aria-invalid={issues.quietHours}
									onChange={(event) => {
										const value = event.target.value
										update((d) => ({ ...d, quietStart: value }))
									}}
									data-testid="message-quiet-start"
								/>
								<TextField
									label={<Trans>Quiet hours end</Trans>}
									type="time"
									value={draft.quietEnd}
									disabled={controlsDisabled}
									aria-invalid={issues.quietHours}
									onChange={(event) => {
										const value = event.target.value
										update((d) => ({ ...d, quietEnd: value }))
									}}
									data-testid="message-quiet-end"
								/>
								{issues.quietHours ? (
									<p className="text-destructive col-span-2 text-sm">
										<Trans>
											Quiet hours must start and end at different times.
										</Trans>
									</p>
								) : null}
							</div>
						) : null}
					</MessageSwitchRow>
				</FramePanel>
			</Frame>

			<ReservationLocaleProvider>
				<Frame data-testid="message-notes-card">
					<FrameHeader>
						<div className="flex items-start justify-between gap-3">
							<div className="flex min-w-0 flex-col gap-1">
								<FrameTitle>
									<Trans>Custom notes</Trans>
								</FrameTitle>
								<FrameDescription>
									<Trans>
										Add a short plain-text note to the end of a message. Write
										it in each language your website offers. A guest gets the
										note in their language, or in the default language when
										there is none.
									</Trans>
								</FrameDescription>
							</div>
							<ReservationLocaleSwitcher />
						</div>
					</FrameHeader>
					<FramePanel>
						<WritingLanguageNote />
						<div className="flex flex-col divide-y">
							{kinds.map((entry) => (
								<NoteRow
									key={entry.kind}
									kind={entry.kind}
									label={kindLabel(entry.kind)}
									notes={draft.notes[entry.kind] ?? {}}
									noteMaxLength={noteMaxLength}
									tooLongSlots={issues.longNotes}
									disabled={controlsDisabled}
									onPreview={() => openPreview(entry.kind)}
									onChange={(next) =>
										update((d) => ({
											...d,
											notes: { ...d.notes, [entry.kind]: next },
										}))
									}
								/>
							))}
						</div>
					</FramePanel>
				</Frame>
			</ReservationLocaleProvider>

			<div
				ref={previewCardRef}
				tabIndex={-1}
				className="scroll-mt-4 outline-none"
				data-testid="message-preview-card"
			>
				<Frame>
					<FrameHeader>
						<FrameTitle>
							<Trans>Preview</Trans>
						</FrameTitle>
						<FrameDescription>
							<Trans>
								A sample message with made-up guest details, built from the
								saved settings.
							</Trans>
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="flex flex-col gap-4">
						<div className="flex flex-wrap items-end gap-3">
							<SelectField
								className="w-full max-w-xs"
								id="message-preview-kind"
								label={<Trans>Message</Trans>}
								options={kindOptions}
								value={previewKindValue}
								onValueChange={setPreviewKind}
							/>
							<ToggleGroup
								aria-label={t`Language`}
								value={[previewLocale]}
								onValueChange={(next) => {
									const picked = next[0]
									if (picked) setPreviewLocale(picked)
								}}
								variant="segmented"
								data-testid="message-preview-locale"
							>
								{languages.locales.map((locale) => (
									<ToggleGroupItem
										key={locale}
										value={locale}
										className="h-11 md:h-7"
										data-testid={`message-preview-locale-${locale}`}
									>
										{getSiteLocaleLabel(locale)}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</div>
						<p
							className="text-muted-foreground text-sm"
							data-testid="message-preview-note-status"
						>
							{previewHasNote ? (
								<Trans>Includes your saved custom note.</Trans>
							) : (
								<Trans>
									No custom note. This is the default text with sample guest
									details.
								</Trans>
							)}
						</p>
						{dirty ? (
							<p
								className="text-muted-foreground text-sm"
								data-testid="message-preview-stale-note"
							>
								<Trans>
									The preview shows the saved settings. Save your changes to see
									them here.
								</Trans>
							</p>
						) : null}
						<MessagePreview
							client={client}
							locationId={locationId}
							kind={previewKindValue}
							locale={previewLocale}
							refreshKey={settings.version}
						/>
					</FramePanel>
				</Frame>
			</div>

			{canWrite && (dirty || (edited && hasIssues(issues))) ? (
				<div
					className="bg-background/95 sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 backdrop-blur md:-mx-6 md:px-6"
					data-testid="message-save-bar"
				>
					<span
						className="text-muted-foreground flex items-center gap-2 text-sm"
						data-testid="message-dirty-badge"
					>
						<span className="bg-warning size-1.5 rounded-full" aria-hidden />
						<Trans>Unsaved changes</Trans>
					</span>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={saving}
							onClick={() => {
								setDraft(base)
								setNotice(null)
								setSaveError(null)
							}}
							data-testid="message-discard"
						>
							<Trans>Discard changes</Trans>
						</Button>
						<Button
							type="button"
							disabled={saving || hasIssues(issues)}
							onClick={() => void handleSave()}
							data-testid="message-save"
						>
							{saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
						</Button>
					</div>
				</div>
			) : null}
		</div>
	)
}
