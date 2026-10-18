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
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'
import {
	PartyFields,
	type PartyFieldValues,
} from '#app/components/reservations/waitlist/party-fields.tsx'
import { type WaitlistActionResult } from '#app/components/reservations/waitlist/use-waitlist.ts'
import { generateIdempotencyKey } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	type AddWaitlistEntryInput,
	fetchWaitlistQuote,
	type WaitlistEntry,
	type WaitlistQuote,
} from '#app/utils/reservations/waitlist-api.ts'
import { useFormatMinutes } from './waitlist-clock.tsx'

const EMPTY: PartyFieldValues = {
	displayName: '',
	partySize: 2,
	phone: '',
	smsOptIn: false,
	notes: '',
	areaPrefId: '',
}

const QUOTE_DEBOUNCE_MS = 300

export function AddPartyDialog({
	open,
	onOpenChange,
	client,
	locationId,
	areas,
	onAdd,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	client: ReservationsScopedClient
	locationId: string
	areas: ReadonlyArray<{ id: string; name: string }>
	onAdd: (
		input: Omit<AddWaitlistEntryInput, 'locationId'>,
		idempotencyKey: string,
	) => Promise<WaitlistActionResult<WaitlistEntry>>
}) {
	const formatMinutes = useFormatMinutes()
	const [values, setValues] = useState<PartyFieldValues>(EMPTY)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [quote, setQuote] = useState<WaitlistQuote | null>(null)
	const [quoteFailed, setQuoteFailed] = useState(false)
	// One key per distinct form: a retry of the same form never adds the party twice.
	const keyRef = useRef(generateIdempotencyKey('wl'))

	useEffect(() => {
		if (!open) return
		setValues(EMPTY)
		setError(null)
		setSubmitting(false)
		keyRef.current = generateIdempotencyKey('wl')
	}, [open])

	const { partySize, areaPrefId } = values
	useEffect(() => {
		if (!open) return
		const controller = new AbortController()
		const timer = window.setTimeout(() => {
			fetchWaitlistQuote(
				client,
				{ locationId, partySize, areaId: areaPrefId || null },
				controller.signal,
			)
				.then((next) => {
					setQuote(next)
					setQuoteFailed(false)
				})
				.catch(() => {
					if (controller.signal.aborted) return
					setQuote(null)
					setQuoteFailed(true)
				})
		}, QUOTE_DEBOUNCE_MS)
		return () => {
			window.clearTimeout(timer)
			controller.abort()
		}
	}, [areaPrefId, client, locationId, open, partySize])

	const change = (patch: Partial<PartyFieldValues>) => {
		keyRef.current = generateIdempotencyKey('wl')
		setValues((prev) => ({ ...prev, ...patch }))
	}

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault()
		if (submitting || !values.displayName.trim()) return
		setSubmitting(true)
		setError(null)
		const result = await onAdd(
			{
				displayName: values.displayName.trim(),
				partySize: values.partySize,
				phone: values.phone.trim() || null,
				smsOptIn: values.smsOptIn,
				areaPrefId: values.areaPrefId || null,
				notes: values.notes.trim() || null,
			},
			keyRef.current,
		)
		setSubmitting(false)
		if (result.ok) {
			onOpenChange(false)
		} else {
			setError(result.message)
		}
	}

	const quotedText =
		quote && quote.quotedMin !== null ? formatMinutes(quote.quotedMin) : null
	const position = quote?.position

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md" data-testid="waitlist-add-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add party to the waitlist</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Quote the wait, then add the party to the end of the queue.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="flex flex-col gap-5">
					{error ? (
						<Alert variant="destructive" data-testid="waitlist-add-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<PartyFields
						idPrefix="waitlist-add"
						values={values}
						onChange={change}
						areas={areas}
						disabled={submitting}
					/>

					<div
						className="bg-muted/40 rounded-lg border px-3 py-2.5 text-sm font-medium"
						role="status"
						data-testid="waitlist-add-quote"
					>
						{quotedText ? (
							<span data-testid="waitlist-add-quote-minutes">
								<Trans>
									Quote this party {quotedText}. They would be number {position}{' '}
									in line.
								</Trans>
							</span>
						) : quote ? (
							<span>
								<Trans>
									No wait estimate is available yet. They would be number{' '}
									{position} in line.
								</Trans>
							</span>
						) : quoteFailed ? (
							<span className="text-muted-foreground">
								<Trans>The wait estimate could not be loaded.</Trans>
							</span>
						) : (
							<span className="text-muted-foreground">
								<Trans>Working out the wait...</Trans>
							</span>
						)}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							className="h-11 md:h-8"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							className="h-11 md:h-8"
							disabled={submitting || !values.displayName.trim()}
							data-testid="waitlist-add-submit"
						>
							<Icon name="user-plus" className="size-4" />
							<span>
								{submitting ? (
									<Trans>Adding...</Trans>
								) : (
									<Trans>Add to waitlist</Trans>
								)}
							</span>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
