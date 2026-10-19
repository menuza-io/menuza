import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
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
import { TextField } from '#app/components/staff/controls.tsx'
import {
	fetchPeoplePage,
	type PeopleClient,
	type PersonRow,
} from '#app/utils/people/people-api.ts'
import { peopleErrorMessage } from '#app/utils/people/people-errors.ts'

const NO_FILTERS = new Set<never>()

/**
 * Picks a duplicate to fold into the person on screen. The person on screen
 * survives: their bookings, tags and notes gain the duplicate's. Only the
 * reservation side is merged; orders and sign-in are never touched, and two
 * different signed-in customers cannot be merged (the server answers 409).
 */
export function PersonMergeDialog({
	open,
	onOpenChange,
	client,
	currentKey,
	currentName,
	busy,
	onMerge,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	client: PeopleClient
	currentKey: string
	currentName: string
	busy: boolean
	/** Resolves when merged; throws the API error otherwise. */
	onMerge: (duplicate: PersonRow) => Promise<void>
}) {
	const { _ } = useLingui()
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<PersonRow[]>([])
	const [selected, setSelected] = useState<PersonRow | null>(null)
	const selectedName = selected?.name ?? ''
	const [failed, setFailed] = useState(false)
	const [mergeError, setMergeError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)

	useEffect(() => {
		if (!open) {
			setQuery('')
			setResults([])
			setSelected(null)
			setFailed(false)
			setMergeError(null)
			setConfirming(false)
		}
	}, [open])

	useEffect(() => {
		if (!open || query.trim().length < 2) {
			setResults([])
			return
		}
		const controller = new AbortController()
		const id = window.setTimeout(() => {
			fetchPeoplePage(
				client,
				{ q: query, filters: NO_FILTERS, hasDining: true },
				controller.signal,
			)
				.then((page) => {
					setFailed(false)
					setResults(page.people.filter((p) => p.key !== currentKey))
				})
				.catch(() => {
					if (!controller.signal.aborted) setFailed(true)
				})
		}, 250)
		return () => {
			window.clearTimeout(id)
			controller.abort()
		}
	}, [client, currentKey, open, query])

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent data-testid="person-merge-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Merge a duplicate</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Find the duplicate. Its bookings, tags, and notes move to this
							profile, and the duplicate is closed. Orders and sign-in are not
							affected. This cannot be undone.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<TextField
					id="person-merge-search"
					label={<Trans>Search for the duplicate</Trans>}
					type="search"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value)
						setSelected(null)
						setMergeError(null)
					}}
					placeholder={_(msg`Name, phone or email`)}
					autoComplete="off"
					data-testid="person-merge-search"
				/>

				{failed ? (
					<Alert variant="destructive">
						<AlertDescription>
							<Trans>The search failed. Try again.</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{mergeError ? (
					<Alert variant="destructive" data-testid="person-merge-error">
						<AlertDescription>{mergeError}</AlertDescription>
					</Alert>
				) : null}

				{query.trim().length >= 2 && results.length === 0 && !failed ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No other customers with reservation history match.</Trans>
					</p>
				) : null}

				{results.length > 0 ? (
					<ul
						className="flex max-h-56 flex-col gap-1 overflow-y-auto"
						data-testid="person-merge-results"
					>
						{results.map((person) => (
							<li key={person.key}>
								<Button
									type="button"
									variant="ghost"
									className="data-[selected=true]:bg-muted data-[selected=true]:ring-ring h-auto min-h-11 w-full flex-col items-start gap-0 py-2 text-start data-[selected=true]:ring-2"
									data-selected={selected?.key === person.key}
									aria-pressed={selected?.key === person.key}
									onClick={() => {
										setSelected(person)
										setMergeError(null)
									}}
									data-testid={`person-merge-option-${person.key}`}
								>
									<span className="font-medium wrap-anywhere">
										{person.name}
									</span>
									<span className="text-muted-foreground text-xs font-normal">
										{person.phone ? <bdi dir="ltr">{person.phone}</bdi> : null}
										{person.phone && person.email ? ' · ' : null}
										{person.email ? <bdi dir="ltr">{person.email}</bdi> : null}
									</span>
								</Button>
							</li>
						))}
					</ul>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={busy || !selected}
						onClick={() => setConfirming(true)}
						data-testid="person-merge-continue"
					>
						<Trans>Continue</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>

			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent data-testid="person-merge-confirm-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>
								Merge {selectedName} into {currentName}?
							</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								The bookings, tags and notes of {selectedName} move to{' '}
								{currentName}, and the duplicate is closed. Orders and sign-in
								stay as they are. This cannot be undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Go back</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							type="button"
							variant="destructive"
							disabled={busy || !selected}
							onClick={async () => {
								if (!selected) return
								try {
									await onMerge(selected)
									setConfirming(false)
									onOpenChange(false)
								} catch (err) {
									setConfirming(false)
									setMergeError(
										peopleErrorMessage(
											err,
											_,
											msg`The customers could not be merged. Try again.`,
										),
									)
								}
							}}
							data-testid="person-merge-confirm"
						>
							<Trans>Merge customers</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Dialog>
	)
}
