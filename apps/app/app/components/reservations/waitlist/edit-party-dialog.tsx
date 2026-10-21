import { Trans } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useEffect, useState } from 'react'
import {
	PartyFields,
	type PartyFieldValues,
} from '#app/components/reservations/waitlist/party-fields.tsx'
import { type WaitlistActionResult } from '#app/components/reservations/waitlist/use-waitlist.ts'
import {
	type UpdateWaitlistEntryPatch,
	type WaitlistEntry,
} from '#app/utils/reservations/waitlist-api.ts'

function valuesFor(entry: WaitlistEntry): PartyFieldValues {
	return {
		displayName: entry.displayName,
		partySize: entry.partySize,
		phone: entry.phone ?? '',
		smsOptIn: entry.smsOptIn,
		notes: entry.notes ?? '',
		areaPrefId: entry.areaPrefId ?? '',
	}
}

export function EditPartyDialog({
	entry,
	onClose,
	areas,
	onSave,
}: {
	entry: WaitlistEntry | null
	onClose: () => void
	areas: ReadonlyArray<{ id: string; name: string }>
	onSave: (
		entry: WaitlistEntry,
		patch: Omit<UpdateWaitlistEntryPatch, 'expectedVersion'>,
	) => Promise<WaitlistActionResult<WaitlistEntry>>
}) {
	const [values, setValues] = useState<PartyFieldValues | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [stale, setStale] = useState(false)

	// Opening a different party starts a fresh draft; a poll that changes the
	// same party underneath an open dialog must not wipe what the host typed.
	const entryId = entry?.id ?? null
	useEffect(() => {
		setValues(entry ? valuesFor(entry) : null)
		setError(null)
		setStale(false)
		setSubmitting(false)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entryId])

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault()
		if (!entry || !values || submitting || !values.displayName.trim()) return
		setSubmitting(true)
		setError(null)
		const phone = values.phone.trim()
		const result = await onSave(entry, {
			displayName: values.displayName.trim(),
			partySize: values.partySize,
			phone: phone || null,
			smsOptIn: Boolean(phone) && values.smsOptIn,
			areaPrefId: values.areaPrefId || null,
			notes: values.notes.trim() || null,
		})
		setSubmitting(false)
		if (result.ok) {
			onClose()
		} else {
			setError(result.message)
			setStale(result.stale)
		}
	}

	return (
		<Dialog
			open={entry !== null}
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md" data-testid="waitlist-edit-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Edit party</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Changing the party size can change the wait you quoted.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{values ? (
					<form onSubmit={handleSubmit} className="flex flex-col gap-5">
						{error ? (
							<Alert variant="destructive" data-testid="waitlist-edit-error">
								<AlertDescription>
									{error}
									{stale ? (
										<span className="block">
											<Trans>
												Close this window and open the party again to see the
												latest details.
											</Trans>
										</span>
									) : null}
								</AlertDescription>
							</Alert>
						) : null}

						<PartyFields
							idPrefix="waitlist-edit"
							values={values}
							onChange={(patch) =>
								setValues((prev) => (prev ? { ...prev, ...patch } : prev))
							}
							areas={areas}
							disabled={submitting}
						/>

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								className="h-11 md:h-8"
								onClick={onClose}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="submit"
								className="h-11 md:h-8"
								disabled={submitting || !values.displayName.trim()}
								data-testid="waitlist-edit-submit"
							>
								{submitting ? <Trans>Saving...</Trans> : <Trans>Save</Trans>}
							</Button>
						</DialogFooter>
					</form>
				) : null}
			</DialogContent>
		</Dialog>
	)
}
