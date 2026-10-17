import { Trans, useLingui } from '@lingui/react/macro'
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
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	fetchMessageSettings,
	MESSAGE_LOCALES,
	type MessageLocale,
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
import {
	MESSAGE_KIND_DESCRIPTIONS,
	MESSAGE_KIND_LABELS,
	MESSAGE_LOCALE_LABELS,
} from './message-labels.ts'
import { MessagePreview } from './message-preview.tsx'

const SELECT_CLASS =
	'border-input bg-background h-9 rounded-md border px-3 text-sm'

type Props = {
	client: ReservationsScopedClient
	locationId: string
	canWrite: boolean
	/** The waitlist module is on, so its message kinds are configurable. */
	waitlistEnabled: boolean
	dataRegion: 'us' | 'ksa'
}

export function MessageSettingsScreen({
	client,
	locationId,
	canWrite,
	waitlistEnabled,
	dataRegion,
}: Props) {
	const { t, i18n } = useLingui()
	const [settings, setSettings] = useState<MessageSettings | null>(null)
	const [draft, setDraft] = useState<MessageDraft | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [notice, setNotice] = useState<'saved' | 'conflict' | null>(null)
	const [previewKind, setPreviewKind] = useState('confirmation')
	const [previewLocale, setPreviewLocale] = useState<MessageLocale>('en')

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
			} catch (err) {
				if (signal?.aborted) return
				setLoadError(
					extractApiErrorMessage(
						err,
						t`Guest message settings could not be loaded.`,
					),
				)
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
	const previewKindValue = kinds.some((k) => k.kind === previewKind)
		? previewKind
		: (kinds[0]?.kind ?? previewKind)

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
				className="text-muted-foreground flex items-center gap-2 text-sm"
				role="status"
				data-testid="message-settings-loading"
			>
				<Icon name="loader" aria-hidden className="size-4 animate-spin" />
				<Trans>Loading guest message settings…</Trans>
			</div>
		)
	}

	if (loadError || !draft || !settings || !issues) {
		return (
			<div
				role="alert"
				className="border-destructive/40 bg-destructive/10 text-destructive flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm"
				data-testid="message-settings-load-error"
			>
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
		)
	}

	const readOnly = !canWrite
	const controlsDisabled = readOnly || saving
	const hoursError = t`Enter a whole number of hours from ${HOURS_MIN} to ${HOURS_MAX}.`

	return (
		<div
			className="flex flex-col gap-6"
			data-testid="reservations-settings-messages-page"
		>
			{notice === 'conflict' ? (
				<div
					role="alert"
					className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-3 text-sm"
					data-testid="message-conflict"
				>
					<Icon name="alert-triangle" className="mt-0.5 size-4 shrink-0" />
					<span>
						<Trans>
							Someone else changed these settings while you were editing. The
							latest version is loaded and your edits are kept. Review them and
							save again.
						</Trans>
					</span>
				</div>
			) : null}
			{notice === 'saved' ? (
				<div
					role="status"
					className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="message-saved"
				>
					<Icon name="check-circle" className="size-4 shrink-0" />
					<Trans>Guest message settings saved.</Trans>
				</div>
			) : null}
			{saveError ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
					data-testid="message-error"
				>
					{saveError}
				</div>
			) : null}

			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="flex flex-col gap-1">
							<CardTitle>
								<Trans>Guest messages</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Choose which emails and texts guests receive for this
									location, when reminders go out, and add a short note to any
									message.
								</Trans>
							</CardDescription>
						</div>
						<div className="flex items-center gap-2">
							{dirty ? (
								<Badge variant="secondary" data-testid="message-dirty-badge">
									<Trans>Unsaved changes</Trans>
								</Badge>
							) : null}
							{canWrite ? (
								<>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={!dirty || saving}
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
										size="sm"
										disabled={!dirty || saving || hasIssues(issues)}
										onClick={() => void handleSave()}
										data-testid="message-save"
									>
										{saving ? (
											<Trans>Saving…</Trans>
										) : (
											<Trans>Save changes</Trans>
										)}
									</Button>
								</>
							) : null}
						</div>
					</div>
				</CardHeader>
			</Card>

			<Card data-testid="message-kinds-card">
				<CardHeader>
					<CardTitle>
						<Trans>Messages to send</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Switch off any message you do not want guests to receive. Payment
							messages follow the payment flow and are not listed here.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col divide-y">
					{kinds.map((entry) => {
						const kind = entry.kind
						const labelId = `message-kind-${kind}-label`
						const enabled = Boolean(draft.kinds[kind])
						const isReminder = kind === 'reminder'
						const isReconfirm = kind === 'reconfirm_request'
						return (
							<div
								key={kind}
								className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0"
								data-testid={`message-kind-row-${kind}`}
							>
								<div className="flex items-start gap-3">
									<Switch
										checked={enabled}
										disabled={controlsDisabled}
										onCheckedChange={(checked) =>
											update((d) => ({
												...d,
												kinds: { ...d.kinds, [kind]: checked },
											}))
										}
										aria-labelledby={labelId}
										data-testid={`message-kind-switch-${kind}`}
									/>
									<div className="flex flex-col gap-0.5">
										<span id={labelId} className="text-sm font-medium">
											{kindLabel(kind)}
										</span>
										{MESSAGE_KIND_DESCRIPTIONS[kind] ? (
											<span className="text-muted-foreground text-xs">
												{i18n._(MESSAGE_KIND_DESCRIPTIONS[kind])}
											</span>
										) : null}
									</div>
								</div>
								{isReminder || isReconfirm ? (
									<div className="ps-11">
										<div className="flex max-w-xs flex-col gap-1.5">
											<Label
												htmlFor={`message-${kind}-hours`}
												className="text-xs"
											>
												{isReminder ? (
													<Trans>
														Send the reminder this many hours before
													</Trans>
												) : (
													<Trans>
														Ask for reconfirmation this many hours before
													</Trans>
												)}
											</Label>
											<Input
												id={`message-${kind}-hours`}
												type="number"
												inputMode="numeric"
												min={HOURS_MIN}
												max={HOURS_MAX}
												className="tabular-nums"
												value={
													isReminder
														? draft.reminderHours
														: draft.reconfirmHours
												}
												disabled={controlsDisabled}
												aria-invalid={
													isReminder
														? issues.reminderHours
														: issues.reconfirmHours
												}
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
											{(
												isReminder
													? issues.reminderHours
													: issues.reconfirmHours
											) ? (
												<p className="text-destructive text-xs">{hoursError}</p>
											) : null}
										</div>
									</div>
								) : null}
							</div>
						)
					})}
				</CardContent>
			</Card>

			<Card data-testid="message-delivery-card">
				<CardHeader>
					<CardTitle>
						<Trans>Delivery</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Email is the default channel. Text messages and quiet hours are
							set here.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-5">
					<div className="flex items-start gap-3">
						<Switch
							checked={draft.smsEnabled}
							disabled={controlsDisabled || dataRegion === 'ksa'}
							onCheckedChange={(checked) =>
								update((d) => ({ ...d, smsEnabled: checked }))
							}
							aria-labelledby="message-sms-label"
							aria-describedby="message-sms-note"
							data-testid="message-sms-switch"
						/>
						<div className="flex flex-col gap-0.5">
							<span id="message-sms-label" className="text-sm font-medium">
								<Trans>Send text messages</Trans>
							</span>
							<span
								id="message-sms-note"
								className="text-muted-foreground text-xs"
								data-testid="message-sms-note"
							>
								{dataRegion === 'ksa' ? (
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
								)}
							</span>
						</div>
					</div>

					<div className="flex flex-col gap-3">
						<div className="flex items-start gap-3">
							<Switch
								checked={draft.quietEnabled}
								disabled={controlsDisabled}
								onCheckedChange={(checked) =>
									update((d) => ({ ...d, quietEnabled: checked }))
								}
								aria-labelledby="message-quiet-label"
								aria-describedby="message-quiet-note"
								data-testid="message-quiet-switch"
							/>
							<div className="flex flex-col gap-0.5">
								<span id="message-quiet-label" className="text-sm font-medium">
									<Trans>Quiet hours</Trans>
								</span>
								<span
									id="message-quiet-note"
									className="text-muted-foreground text-xs"
								>
									<Trans>
										Scheduled reminders avoid these hours (location time).
										Confirmations and other immediate messages are always sent
										right away.
									</Trans>
								</span>
							</div>
						</div>
						{draft.quietEnabled ? (
							<div className="grid max-w-md grid-cols-2 gap-3 ps-11">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="message-quiet-start" className="text-xs">
										<Trans>Quiet hours start</Trans>
									</Label>
									<Input
										id="message-quiet-start"
										type="time"
										className="tabular-nums"
										value={draft.quietStart}
										disabled={controlsDisabled}
										aria-invalid={issues.quietHours}
										onChange={(event) => {
											const value = event.target.value
											update((d) => ({ ...d, quietStart: value }))
										}}
										data-testid="message-quiet-start"
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="message-quiet-end" className="text-xs">
										<Trans>Quiet hours end</Trans>
									</Label>
									<Input
										id="message-quiet-end"
										type="time"
										className="tabular-nums"
										value={draft.quietEnd}
										disabled={controlsDisabled}
										aria-invalid={issues.quietHours}
										onChange={(event) => {
											const value = event.target.value
											update((d) => ({ ...d, quietEnd: value }))
										}}
										data-testid="message-quiet-end"
									/>
								</div>
								{issues.quietHours ? (
									<p className="text-destructive col-span-2 text-xs">
										<Trans>
											Quiet hours must start and end at different times.
										</Trans>
									</p>
								) : null}
							</div>
						) : null}
					</div>
				</CardContent>
			</Card>

			<Card data-testid="message-notes-card">
				<CardHeader>
					<CardTitle>
						<Trans>Custom notes</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Add a short plain-text note to the end of a message, in English
							and Arabic. Guests whose language is not Arabic receive the
							English note.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col divide-y">
					{kinds.map((entry) => {
						const kind = entry.kind
						return (
							<div
								key={kind}
								className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
								data-testid={`message-note-row-${kind}`}
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="text-sm font-medium">{kindLabel(kind)}</span>
									<Button
										type="button"
										variant="ghost"
										size="xs"
										onClick={() => setPreviewKind(kind)}
										data-testid={`message-preview-pick-${kind}`}
									>
										<Trans>Preview</Trans>
									</Button>
								</div>
								<div className="grid gap-3 md:grid-cols-2">
									{MESSAGE_LOCALES.map((locale) => {
										const value = draft.notes[kind]?.[locale] ?? ''
										const tooLong = issues.longNotes.includes(
											noteSlot(kind, locale),
										)
										const id = `message-note-${kind}-${locale}`
										const localeLabel = i18n._(MESSAGE_LOCALE_LABELS[locale])
										const kindName = kindLabel(kind)
										const length = value.length
										return (
											<div key={locale} className="flex flex-col gap-1.5">
												<Label htmlFor={id} className="text-xs">
													{t`${kindName} note (${localeLabel})`}
												</Label>
												<Textarea
													id={id}
													rows={2}
													dir={locale === 'ar' ? 'rtl' : 'ltr'}
													lang={locale}
													value={value}
													disabled={controlsDisabled}
													aria-invalid={tooLong}
													onChange={(event) => {
														const next = event.target.value
														update((d) => ({
															...d,
															notes: {
																...d.notes,
																[kind]: {
																	en: d.notes[kind]?.en ?? '',
																	ar: d.notes[kind]?.ar ?? '',
																	[locale]: next,
																},
															},
														}))
													}}
													data-testid={id}
												/>
												<span
													className={
														tooLong
															? 'text-destructive text-xs'
															: 'text-muted-foreground text-xs'
													}
												>
													<bdi className="tabular-nums">
														{t`${length} of ${noteMaxLength} characters`}
													</bdi>
												</span>
											</div>
										)
									})}
								</div>
							</div>
						)
					})}
				</CardContent>
			</Card>

			<Card data-testid="message-preview-card">
				<CardHeader>
					<CardTitle>
						<Trans>Preview</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							A sample message with made-up guest details, built from the saved
							settings.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-wrap gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="message-preview-kind" className="text-xs">
								<Trans>Message</Trans>
							</Label>
							<select
								id="message-preview-kind"
								className={SELECT_CLASS}
								value={previewKindValue}
								onChange={(event) => setPreviewKind(event.target.value)}
								data-testid="message-preview-kind"
							>
								{kinds.map((entry) => (
									<option key={entry.kind} value={entry.kind}>
										{kindLabel(entry.kind)}
									</option>
								))}
							</select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="message-preview-locale" className="text-xs">
								<Trans>Language</Trans>
							</Label>
							<select
								id="message-preview-locale"
								className={SELECT_CLASS}
								value={previewLocale}
								onChange={(event) =>
									setPreviewLocale(event.target.value as MessageLocale)
								}
								data-testid="message-preview-locale"
							>
								{MESSAGE_LOCALES.map((locale) => (
									<option key={locale} value={locale}>
										{i18n._(MESSAGE_LOCALE_LABELS[locale])}
									</option>
								))}
							</select>
						</div>
					</div>
					{dirty ? (
						<p
							className="text-muted-foreground text-xs"
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
				</CardContent>
			</Card>
		</div>
	)
}
