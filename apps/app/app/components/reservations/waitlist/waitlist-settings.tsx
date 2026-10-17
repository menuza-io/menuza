import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
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
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	extractApiErrorMessage,
	isVersionConflictError,
} from '#app/utils/reservations/setup-api.ts'
import {
	fetchWaitlistSettings,
	saveWaitlistSettings,
	type WaitlistSettings,
} from '#app/utils/reservations/waitlist-api.ts'

type Draft = {
	waitlistEnabled: boolean
	waitlistOnline: boolean
	notifyMeEnabled: boolean
	responseMin: string
	maxParties: string
}

const MIN_RESPONSE = 1
const MAX_RESPONSE = 120
const MAX_PARTIES = 500

function draftFor(settings: WaitlistSettings): Draft {
	return {
		waitlistEnabled: settings.waitlistEnabled,
		waitlistOnline: settings.waitlistOnline,
		notifyMeEnabled: settings.notifyMeEnabled,
		responseMin: String(settings.waitlistResponseMin),
		maxParties:
			settings.waitlistMaxParties === null
				? ''
				: String(settings.waitlistMaxParties),
	}
}

function sameDraft(a: Draft, b: Draft) {
	return (
		a.waitlistEnabled === b.waitlistEnabled &&
		a.waitlistOnline === b.waitlistOnline &&
		a.notifyMeEnabled === b.notifyMeEnabled &&
		a.responseMin.trim() === b.responseMin.trim() &&
		a.maxParties.trim() === b.maxParties.trim()
	)
}

const LOAD_FAILED = msg`Could not load the waitlist settings.`
const SAVE_FAILED = msg`Could not save the waitlist settings.`

export function WaitlistSettingsScreen({
	client,
	locationId,
	canWrite,
	onSaved,
}: {
	client: ReservationsScopedClient
	locationId: string
	canWrite: boolean
	/** Lets the settings shell reload its summary (the version is shared). */
	onSaved?: () => void | Promise<void>
}) {
	const { t, i18n } = useLingui()
	const [saved, setSaved] = useState<WaitlistSettings | null>(null)
	const [draft, setDraft] = useState<Draft | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)
	const [conflict, setConflict] = useState(false)
	const [success, setSuccess] = useState(false)

	const load = useCallback(async () => {
		setLoading(true)
		setLoadError(null)
		try {
			const next = await fetchWaitlistSettings(client, locationId)
			setSaved(next)
			setDraft(draftFor(next))
		} catch (err) {
			setLoadError(extractApiErrorMessage(err, i18n._(LOAD_FAILED)))
		} finally {
			setLoading(false)
		}
	}, [client, i18n, locationId])

	useEffect(() => {
		void load()
	}, [load])

	const dirty = Boolean(saved && draft && !sameDraft(draft, draftFor(saved)))

	const update = (patch: Partial<Draft>) => {
		setSuccess(false)
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
	}

	const reloadAfterConflict = async () => {
		setConflict(false)
		setFormError(null)
		await load()
	}

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault()
		if (!canWrite || !saved || !draft || saving) return
		setFormError(null)
		setSuccess(false)

		const responseMin = Number(draft.responseMin)
		if (
			!Number.isInteger(responseMin) ||
			responseMin < MIN_RESPONSE ||
			responseMin > MAX_RESPONSE
		) {
			setFormError(
				t`The answer window must be a whole number of minutes from ${MIN_RESPONSE} to ${MAX_RESPONSE}.`,
			)
			return
		}
		const maxText = draft.maxParties.trim()
		const maxParties = maxText === '' ? null : Number(maxText)
		if (
			maxParties !== null &&
			(!Number.isInteger(maxParties) ||
				maxParties < 1 ||
				maxParties > MAX_PARTIES)
		) {
			setFormError(
				t`The party limit must be a whole number from 1 to ${MAX_PARTIES}, or empty for no limit.`,
			)
			return
		}

		setSaving(true)
		try {
			const next = await saveWaitlistSettings(client, locationId, {
				expectedVersion: saved.version,
				waitlistEnabled: draft.waitlistEnabled,
				waitlistOnline: draft.waitlistOnline,
				notifyMeEnabled: draft.notifyMeEnabled,
				waitlistResponseMin: responseMin,
				waitlistMaxParties: maxParties,
			})
			setSaved(next)
			setDraft(draftFor(next))
			setConflict(false)
			setSuccess(true)
			await onSaved?.()
		} catch (err) {
			// The draft stays as typed so nothing the manager entered is lost.
			if (isVersionConflictError(err)) {
				setConflict(true)
			} else {
				setFormError(extractApiErrorMessage(err, i18n._(SAVE_FAILED)))
			}
		} finally {
			setSaving(false)
		}
	}

	if (loading && !draft) {
		return (
			<Card data-testid="waitlist-settings-loading">
				<CardContent className="text-muted-foreground py-8">
					<Trans>Loading waitlist settings...</Trans>
				</CardContent>
			</Card>
		)
	}

	if (!draft || !saved) {
		return (
			<Card data-testid="waitlist-settings-error">
				<CardContent className="flex flex-col gap-3 py-8">
					<p className="text-destructive font-medium">{loadError}</p>
					<div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void load()}
						>
							<Trans>Retry</Trans>
						</Button>
					</div>
				</CardContent>
			</Card>
		)
	}

	return (
		<form
			onSubmit={(event) => void handleSubmit(event)}
			className="flex flex-col gap-4"
			data-testid="waitlist-settings-form"
		>
			{conflict ? (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 p-4 text-sm"
					data-testid="waitlist-settings-conflict"
				>
					<span className="font-medium">
						<Trans>
							These settings were changed by someone else. Your changes were not
							saved. Reload to see the latest version.
						</Trans>
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void reloadAfterConflict()}
						data-testid="waitlist-settings-reload"
					>
						<Icon name="refresh-cw" className="size-3.5" />
						<Trans>Reload latest settings</Trans>
					</Button>
				</div>
			) : null}

			{formError ? (
				<Alert variant="destructive" data-testid="waitlist-settings-form-error">
					<AlertDescription>{formError}</AlertDescription>
				</Alert>
			) : null}

			{success ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="waitlist-settings-saved"
				>
					<Trans>Waitlist settings saved.</Trans>
				</div>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Waitlist</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Control the walk-in queue, whether guests can join it online, and
							how long they have to answer a table-ready message.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-5">
					<div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
						<ToggleCard
							testId="waitlist-setting-enabled"
							checked={draft.waitlistEnabled}
							disabled={!canWrite}
							onChange={(checked) => update({ waitlistEnabled: checked })}
							title={<Trans>Waitlist enabled</Trans>}
							description={
								<Trans>
									Let the host stand keep a live queue for this location.
								</Trans>
							}
						/>
						<ToggleCard
							testId="waitlist-setting-online"
							checked={draft.waitlistOnline}
							disabled={!canWrite}
							onChange={(checked) => update({ waitlistOnline: checked })}
							title={<Trans>Guests can join online</Trans>}
							description={
								<Trans>
									Show a join button on your website. Online booking must also
									be on for the button to appear.
								</Trans>
							}
						/>
						<ToggleCard
							testId="waitlist-setting-notify-me"
							checked={draft.notifyMeEnabled}
							disabled={!canWrite}
							onChange={(checked) => update({ notifyMeEnabled: checked })}
							title={<Trans>Notify me when a table opens</Trans>}
							description={
								<Trans>
									When a time is full, guests can ask to be told if it frees up.
								</Trans>
							}
						/>
					</div>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="waitlist-setting-response-min">
								<Trans>Answer window (minutes)</Trans>
							</Label>
							<Input
								id="waitlist-setting-response-min"
								type="number"
								min={MIN_RESPONSE}
								max={MAX_RESPONSE}
								value={draft.responseMin}
								disabled={!canWrite}
								onChange={(event) =>
									update({ responseMin: event.target.value })
								}
								className="w-32"
								data-testid="waitlist-setting-response-min"
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									After a table-ready message, the party has this long to answer
									before the offer expires.
								</Trans>
							</p>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="waitlist-setting-max-parties">
								<Trans>Party limit (optional)</Trans>
							</Label>
							<Input
								id="waitlist-setting-max-parties"
								type="number"
								min={1}
								max={MAX_PARTIES}
								value={draft.maxParties}
								disabled={!canWrite}
								placeholder={t`No limit`}
								onChange={(event) => update({ maxParties: event.target.value })}
								className="w-32"
								data-testid="waitlist-setting-max-parties"
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Most parties allowed in line at once. Guests joining online
									are turned away when it is full. The host stand can still add
									walk-ins.
								</Trans>
							</p>
						</div>
					</div>

					{canWrite ? (
						<div className="flex items-center gap-3">
							<Button
								type="submit"
								disabled={!dirty || saving}
								data-testid="waitlist-settings-save"
							>
								{saving ? (
									<Trans>Saving...</Trans>
								) : (
									<Trans>Save changes</Trans>
								)}
							</Button>
							{dirty ? (
								<span
									className="text-muted-foreground text-xs"
									data-testid="waitlist-settings-dirty"
								>
									<Trans>You have unsaved changes.</Trans>
								</span>
							) : null}
						</div>
					) : (
						<p
							className="text-muted-foreground text-xs"
							data-testid="waitlist-settings-read-only"
						>
							<Trans>You can view these settings but not change them.</Trans>
						</p>
					)}
				</CardContent>
			</Card>
		</form>
	)
}

function ToggleCard({
	testId,
	checked,
	disabled,
	onChange,
	title,
	description,
}: {
	testId: string
	checked: boolean
	disabled: boolean
	onChange: (checked: boolean) => void
	title: React.ReactNode
	description: React.ReactNode
}) {
	return (
		<label className="border-border flex items-start gap-3 rounded-lg border p-3 text-sm">
			<input
				type="checkbox"
				className="mt-0.5"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
				data-testid={testId}
			/>
			<div>
				<div className="text-foreground font-medium">{title}</div>
				<div className="text-muted-foreground text-xs">{description}</div>
			</div>
		</label>
	)
}
