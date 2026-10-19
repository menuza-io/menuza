import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
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
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { SettingsSaveBar } from '#app/components/reservations/settings/save-bar.tsx'
import { SwitchRow } from '#app/components/reservations/settings/settings-fields.tsx'
import { useRevealedErrors } from '#app/components/reservations/settings/use-revealed-errors.ts'
import { TextField } from '#app/components/staff/controls.tsx'
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
		} catch {
			// Plain copy only: the server's own wording is never shown here.
			setLoadError(i18n._(LOAD_FAILED))
		} finally {
			setLoading(false)
		}
	}, [client, i18n, locationId])

	useEffect(() => {
		void load()
	}, [load])

	// Derived from the draft on every render and revealed after a save attempt
	// or blur, so a message goes away as soon as the value is valid.
	const liveErrors: Partial<Record<'responseMin' | 'maxParties', string>> = {}
	if (draft) {
		const responseMin = Number(draft.responseMin)
		if (
			!Number.isInteger(responseMin) ||
			responseMin < MIN_RESPONSE ||
			responseMin > MAX_RESPONSE
		) {
			liveErrors.responseMin = t`The answer window must be a whole number of minutes from ${MIN_RESPONSE} to ${MAX_RESPONSE}.`
		}
		const maxText = draft.maxParties.trim()
		const maxParties = maxText === '' ? null : Number(maxText)
		if (
			maxParties !== null &&
			(!Number.isInteger(maxParties) ||
				maxParties < 1 ||
				maxParties > MAX_PARTIES)
		) {
			liveErrors.maxParties = t`The party limit must be a whole number from 1 to ${MAX_PARTIES}, or empty for no limit.`
		}
	}
	const {
		errors: fieldErrors,
		attempt: attemptSave,
		touch: touchField,
		reset: resetErrors,
	} = useRevealedErrors(liveErrors)

	const dirty = Boolean(saved && draft && !sameDraft(draft, draftFor(saved)))

	const update = (patch: Partial<Draft>) => {
		setSuccess(false)
		setFormError(null)
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
	}

	const discard = () => {
		if (!saved) return
		setDraft(draftFor(saved))
		setFormError(null)
		resetErrors()
		setSuccess(false)
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

		if (!attemptSave()) return
		const responseMin = Number(draft.responseMin)
		const maxText = draft.maxParties.trim()
		const maxParties = maxText === '' ? null : Number(maxText)

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
			<div
				className="flex flex-col gap-4"
				data-testid="waitlist-settings-loading"
				role="status"
				aria-label={t`Loading waitlist settings`}
			>
				<Skeleton className="h-56 w-full rounded-xl" />
			</div>
		)
	}

	if (!draft || !saved) {
		return (
			<Alert variant="destructive" data-testid="waitlist-settings-error">
				<AlertTitle>
					<Trans>Could not load the waitlist settings</Trans>
				</AlertTitle>
				<AlertDescription>
					<div className="flex flex-col items-start gap-3">
						<span>{loadError}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void load()}
						>
							<Trans>Retry</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	return (
		<form
			onSubmit={(event) => void handleSubmit(event)}
			className="flex flex-col gap-6"
			data-testid="waitlist-settings-form"
		>
			{conflict ? (
				<Alert variant="destructive" data-testid="waitlist-settings-conflict">
					<Icon name="alert-triangle" />
					<AlertTitle>
						<Trans>
							These settings were changed by someone else. Your changes were not
							saved. Reload to see the latest version.
						</Trans>
					</AlertTitle>
					<AlertDescription>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void reloadAfterConflict()}
							data-testid="waitlist-settings-reload"
						>
							<Icon name="refresh-cw" />
							<Trans>Reload latest settings</Trans>
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{formError ? (
				<Alert variant="destructive" data-testid="waitlist-settings-form-error">
					<AlertDescription>{formError}</AlertDescription>
				</Alert>
			) : null}

			<Frame>
				<FrameHeader>
					<FrameTitle>
						<Trans>Waitlist</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Control the walk-in queue and whether guests can join it online.
						</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="flex flex-col gap-2">
					<SwitchRow
						testId="waitlist-setting-enabled"
						checked={draft.waitlistEnabled}
						disabled={!canWrite}
						onCheckedChange={(checked) => update({ waitlistEnabled: checked })}
						label={<Trans>Waitlist enabled</Trans>}
						description={
							<Trans>
								Let the host stand keep a live queue for this location.
							</Trans>
						}
					/>
					<SwitchRow
						testId="waitlist-setting-online"
						checked={draft.waitlistOnline}
						disabled={!canWrite}
						onCheckedChange={(checked) => update({ waitlistOnline: checked })}
						label={<Trans>Guests can join online</Trans>}
						description={
							<Trans>
								Show a join button on your website. Online booking must also be
								on for the button to appear.
							</Trans>
						}
					/>
					<SwitchRow
						testId="waitlist-setting-notify-me"
						checked={draft.notifyMeEnabled}
						disabled={!canWrite}
						onCheckedChange={(checked) => update({ notifyMeEnabled: checked })}
						label={<Trans>Notify me when a table opens</Trans>}
						description={
							<Trans>
								When a time is full, guests can ask to be told if it frees up.
							</Trans>
						}
					/>
				</FramePanel>
			</Frame>

			<Frame>
				<FrameHeader>
					<FrameTitle>
						<Trans>Offers and limits</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							How long guests have to answer a table-ready message, and how long
							the line can get.
						</Trans>
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="grid grid-cols-1 gap-5 sm:grid-cols-2">
					<TextField
						id="waitlist-setting-response-min"
						type="number"
						inputMode="numeric"
						min={MIN_RESPONSE}
						max={MAX_RESPONSE}
						label={<Trans>Answer window (minutes)</Trans>}
						hint={
							<Trans>
								After a table-ready message, the party has this long to answer
								before the offer expires.
							</Trans>
						}
						value={draft.responseMin}
						error={fieldErrors.responseMin}
						onBlur={() => touchField('responseMin')}
						disabled={!canWrite}
						onChange={(event) => update({ responseMin: event.target.value })}
						data-testid="waitlist-setting-response-min"
					/>
					<TextField
						id="waitlist-setting-max-parties"
						type="number"
						inputMode="numeric"
						min={1}
						max={MAX_PARTIES}
						optional
						label={<Trans>Party limit</Trans>}
						hint={
							<Trans>
								Most parties allowed in line at once. Guests joining online are
								turned away when it is full. The host stand can still add
								walk-ins.
							</Trans>
						}
						value={draft.maxParties}
						error={fieldErrors.maxParties}
						onBlur={() => touchField('maxParties')}
						disabled={!canWrite}
						placeholder={t`No limit`}
						onChange={(event) => update({ maxParties: event.target.value })}
						data-testid="waitlist-setting-max-parties"
					/>
				</FramePanel>
			</Frame>

			{success ? (
				<p
					role="status"
					className="text-success flex items-center gap-2 text-sm"
					data-testid="waitlist-settings-saved"
				>
					<Icon name="check-circle" className="size-4" />
					<Trans>Waitlist settings saved.</Trans>
				</p>
			) : null}

			{canWrite ? (
				<SettingsSaveBar
					submit
					dirty={dirty}
					pending={saving}
					onDiscard={discard}
					saveTestId="waitlist-settings-save"
					dirtyTestId={dirty ? 'waitlist-settings-dirty' : undefined}
				/>
			) : (
				<p
					className="text-muted-foreground text-sm"
					data-testid="waitlist-settings-read-only"
				>
					<Trans>You can view these settings but not change them.</Trans>
				</p>
			)}
		</form>
	)
}
