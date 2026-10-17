import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import {
	fetchGuestPage,
	type GuestRow,
} from '#app/utils/reservations/guests-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

/**
 * Picks a duplicate profile to fold into the one on screen. The profile on
 * screen survives: its bookings, tags and notes gain the duplicate's.
 */
export function GuestMergeDialog({
	open,
	onOpenChange,
	client,
	current,
	busy,
	onMerge,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	client: ReservationsScopedClient
	current: GuestRow
	busy: boolean
	onMerge: (duplicate: GuestRow) => Promise<boolean>
}) {
	const { _ } = useLingui()
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<GuestRow[]>([])
	const [selected, setSelected] = useState<GuestRow | null>(null)
	const selectedName = selected?.name ?? ''
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		if (!open) {
			setQuery('')
			setResults([])
			setSelected(null)
			setFailed(false)
		}
	}, [open])

	useEffect(() => {
		if (!open || query.trim().length < 2) {
			setResults([])
			return
		}
		const controller = new AbortController()
		const id = window.setTimeout(() => {
			fetchGuestPage(client, { q: query }, controller.signal)
				.then((page) => {
					setFailed(false)
					setResults(page.guests.filter((g) => g.id !== current.id))
				})
				.catch(() => {
					if (!controller.signal.aborted) setFailed(true)
				})
		}, 250)
		return () => {
			window.clearTimeout(id)
			controller.abort()
		}
	}, [client, current.id, open, query])

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent data-testid="guest-merge-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Merge a duplicate guest</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Find the duplicate profile. Its bookings, tags, and notes move to
							this profile, and the duplicate is closed. This cannot be undone.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-1">
					<Label htmlFor="guest-merge-search" className="text-xs">
						<Trans>Search for the duplicate</Trans>
					</Label>
					<Input
						id="guest-merge-search"
						type="search"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value)
							setSelected(null)
						}}
						placeholder={_(msg`Name, phone, or email`)}
						autoComplete="off"
						data-testid="guest-merge-search"
					/>
				</div>

				{failed ? (
					<Alert variant="destructive">
						<AlertDescription>
							<Trans>The search failed. Try again.</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{query.trim().length >= 2 && results.length === 0 && !failed ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No other guests match.</Trans>
					</p>
				) : null}

				{results.length > 0 ? (
					<ul
						className="flex max-h-56 flex-col gap-1 overflow-y-auto"
						data-testid="guest-merge-results"
					>
						{results.map((guest) => (
							<li key={guest.id}>
								<button
									type="button"
									className="hover:bg-muted data-[selected=true]:bg-muted data-[selected=true]:ring-ring flex w-full flex-col rounded-md px-3 py-2 text-start data-[selected=true]:ring-2"
									data-selected={selected?.id === guest.id}
									onClick={() => setSelected(guest)}
									data-testid={`guest-merge-option-${guest.id}`}
								>
									<span className="font-medium wrap-anywhere">
										{guest.name}
									</span>
									<span className="text-muted-foreground text-xs">
										{guest.phone ? <bdi dir="ltr">{guest.phone}</bdi> : null}
										{guest.phone && guest.email ? ' · ' : null}
										{guest.email ? <bdi dir="ltr">{guest.email}</bdi> : null}
									</span>
								</button>
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
						variant="destructive"
						disabled={busy || !selected}
						onClick={async () => {
							if (selected && (await onMerge(selected))) onOpenChange(false)
						}}
						data-testid="guest-merge-confirm"
					>
						{selected ? (
							<Trans>Merge {selectedName} into this guest</Trans>
						) : (
							<Trans>Merge</Trans>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
