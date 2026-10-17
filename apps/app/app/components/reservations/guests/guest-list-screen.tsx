import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GuestTagBadge } from '#app/components/reservations/guests/guest-tag-badge.tsx'
import {
	fetchGuestPage,
	fetchGuestTags,
	GUEST_SORTS,
	type GuestRow,
	type GuestSort,
	type GuestTag,
} from '#app/utils/reservations/guests-api.ts'
import { guestsErrorInfo } from '#app/utils/reservations/guests-errors.ts'
import {
	formatInstantDate,
	GUEST_SORT_LABELS,
	guestTagName,
} from '#app/utils/reservations/guests-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const SEARCH_DEBOUNCE_MS = 300

export function GuestListScreen({
	client,
	orgSlug,
}: {
	client: ReservationsScopedClient
	orgSlug: string
}) {
	const { _, i18n } = useLingui()
	const [query, setQuery] = useState('')
	const [debouncedQuery, setDebouncedQuery] = useState('')
	const [tagId, setTagId] = useState('')
	const [sort, setSort] = useState<GuestSort>('updated')
	const [tags, setTags] = useState<GuestTag[]>([])
	const [guests, setGuests] = useState<GuestRow[]>([])
	const shownCount = guests.length
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const [total, setTotal] = useState(0)
	const [loading, setLoading] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const [error, setError] = useState<'denied' | 'failed' | null>(null)
	const requestId = useRef(0)

	useEffect(() => {
		const id = window.setTimeout(
			() => setDebouncedQuery(query),
			SEARCH_DEBOUNCE_MS,
		)
		return () => window.clearTimeout(id)
	}, [query])

	useEffect(() => {
		const controller = new AbortController()
		fetchGuestTags(client, controller.signal)
			.then(setTags)
			.catch(() => {
				// The filter is optional; the list reports its own errors.
			})
		return () => controller.abort()
	}, [client])

	const load = useCallback(
		async (cursor: string | null, signal?: AbortSignal) => {
			const current = (requestId.current += 1)
			try {
				const page = await fetchGuestPage(
					client,
					{ q: debouncedQuery, tagId, sort, cursor },
					signal,
				)
				if (current !== requestId.current) return
				setGuests((prev) => (cursor ? [...prev, ...page.guests] : page.guests))
				setNextCursor(page.nextCursor)
				setTotal(page.total)
				setError(null)
			} catch (err) {
				if (signal?.aborted || current !== requestId.current) return
				setError(guestsErrorInfo(err).status === 403 ? 'denied' : 'failed')
			} finally {
				if (current === requestId.current) {
					setLoading(false)
					setLoadingMore(false)
				}
			}
		},
		[client, debouncedQuery, tagId, sort],
	)

	useEffect(() => {
		const controller = new AbortController()
		setLoading(true)
		void load(null, controller.signal)
		return () => controller.abort()
	}, [load])

	const filtering = debouncedQuery.trim() !== '' || tagId !== ''

	return (
		<div className="flex flex-col gap-4" data-testid="guests-screen">
			<PageHeader
				title={<Trans>Guests</Trans>}
				description={
					<Trans>
						Everyone who has booked or walked in, with visit history, tags, and
						notes. Guest details stay in your regional database.
					</Trans>
				}
			/>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-60 flex-1 flex-col gap-1">
					<Label htmlFor="guests-search" className="text-xs">
						<Trans>Search</Trans>
					</Label>
					<Input
						id="guests-search"
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={_(msg`Name, phone, or email`)}
						autoComplete="off"
						data-testid="guests-search"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="guests-tag-filter" className="text-xs">
						<Trans>Tag</Trans>
					</Label>
					<select
						id="guests-tag-filter"
						value={tagId}
						onChange={(event) => setTagId(event.target.value)}
						className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
						data-testid="guests-tag-filter"
					>
						<option value="">{_(msg`All guests`)}</option>
						{tags.map((tag) => (
							<option key={tag.id} value={tag.id}>
								{guestTagName(_, tag)}
							</option>
						))}
					</select>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="guests-sort" className="text-xs">
						<Trans>Sort by</Trans>
					</Label>
					<select
						id="guests-sort"
						value={sort}
						onChange={(event) => setSort(event.target.value as GuestSort)}
						className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
						data-testid="guests-sort"
					>
						{GUEST_SORTS.map((value) => (
							<option key={value} value={value}>
								{_(GUEST_SORT_LABELS[value])}
							</option>
						))}
					</select>
				</div>
			</div>

			{error === 'denied' ? (
				<Alert variant="destructive" data-testid="guests-denied">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<Trans>You do not have access to guest profiles.</Trans>
					</AlertDescription>
				</Alert>
			) : error === 'failed' ? (
				<Alert variant="destructive" data-testid="guests-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							<Trans>The guest list could not be loaded.</Trans>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setLoading(true)
									void load(null)
								}}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{loading && guests.length === 0 && !error ? (
				<p
					className="text-muted-foreground text-sm"
					role="status"
					data-testid="guests-loading"
				>
					<Trans>Loading guests...</Trans>
				</p>
			) : null}

			{!loading && !error && guests.length === 0 ? (
				<div data-testid={filtering ? 'guests-empty-search' : 'guests-empty'}>
					<EmptyState
						title={
							filtering ? (
								<Trans>No guests match your search</Trans>
							) : (
								<Trans>No guest profiles yet</Trans>
							)
						}
						description={
							filtering ? (
								<Trans>
									Try a different name, part of a phone number, or an email
									address, or clear the tag filter.
								</Trans>
							) : (
								<Trans>
									Guests appear here after their first booking or walk-in.
								</Trans>
							)
						}
						icons={['users', 'calendar', 'clock']}
					/>
				</div>
			) : null}

			{guests.length > 0 ? (
				<>
					<p
						className="text-muted-foreground text-sm"
						data-testid="guests-count"
					>
						<Trans>
							<bdi>{shownCount}</bdi> of <bdi>{total}</bdi> guests
						</Trans>
					</p>
					<Frame>
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Guest</Trans>
									</TableHead>
									<TableHead>
										<Trans>Contact</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Visits</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>No-shows</Trans>
									</TableHead>
									<TableHead>
										<Trans>Last visit</Trans>
									</TableHead>
									<TableHead>
										<Trans>Tags</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{guests.map((guest) => (
									<TableRow
										key={guest.id}
										data-testid={`guest-row-${guest.id}`}
									>
										<TableCell>
											<Link
												to={`/${orgSlug}/reservations/guests/${guest.id}`}
												className="text-foreground font-medium underline-offset-4 hover:underline"
												data-testid={`guest-link-${guest.id}`}
											>
												<span className="wrap-anywhere">{guest.name}</span>
											</Link>
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											<div className="flex flex-col">
												{guest.phone ? (
													<bdi dir="ltr" className="text-start">
														{guest.phone}
													</bdi>
												) : null}
												{guest.email ? (
													<bdi dir="ltr" className="text-start wrap-anywhere">
														{guest.email}
													</bdi>
												) : null}
											</div>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											<bdi>{guest.visits}</bdi>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											<bdi>{guest.noShows}</bdi>
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{formatInstantDate(guest.lastVisitAt, i18n.locale) ?? '—'}
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap gap-1">
												{guest.tags.map((tag) => (
													<GuestTagBadge key={tag.id} tag={tag} />
												))}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Frame>
					{nextCursor ? (
						<div className="flex justify-center">
							<Button
								type="button"
								variant="outline"
								disabled={loadingMore}
								onClick={() => {
									setLoadingMore(true)
									void load(nextCursor)
								}}
								data-testid="guests-load-more"
							>
								<Trans>Load more</Trans>
							</Button>
						</div>
					) : null}
				</>
			) : null}
		</div>
	)
}
