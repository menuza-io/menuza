import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspaceToolbar } from '@repo/ui/workspace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GuestTagBadge } from '#app/components/reservations/guests/guest-tag-badge.tsx'
import { ReservationsHeaderActions } from '#app/components/reservations/shell-context.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
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
/** `FilterSelect` cannot hold an empty value, so "all guests" travels as this key. */
const ALL_TAGS = 'all'
const LAPSED_DAYS = 90
const DAY_MS = 86_400_000

type QuickFilter = 'vip' | 'allergy' | 'lapsed'

/** A guest tagged VIP (the same rule the booking sheet uses). */
export function isVipGuest(guest: GuestRow): boolean {
	return guest.tags.some(
		(tag) => tag.category === 'vip' || tag.name.toLowerCase().includes('vip'),
	)
}

/** Seen before, but not within the last 90 days. Guests with no recorded visit are not lapsed. */
export function isLapsedGuest(guest: GuestRow, now: number): boolean {
	return (
		guest.lastVisitAt !== null && guest.lastVisitAt < now - LAPSED_DAYS * DAY_MS
	)
}

export function matchesQuickFilters(
	guest: GuestRow,
	active: ReadonlySet<QuickFilter>,
	now: number,
): boolean {
	if (active.has('vip') && !isVipGuest(guest)) return false
	if (active.has('allergy') && !guest.hasAllergy) return false
	if (active.has('lapsed') && !isLapsedGuest(guest, now)) return false
	return true
}

export function GuestListScreen({
	client,
	orgSlug,
	canBook = false,
}: {
	client: ReservationsScopedClient
	orgSlug: string
	/** Show the New reservation action (the operator may book). */
	canBook?: boolean
}) {
	const { _, i18n } = useLingui()
	const [query, setQuery] = useState('')
	const [debouncedQuery, setDebouncedQuery] = useState('')
	const [tagId, setTagId] = useState('')
	const [sort, setSort] = useState<GuestSort>('updated')
	const [tags, setTags] = useState<GuestTag[]>([])
	const [guests, setGuests] = useState<GuestRow[]>([])
	const [quick, setQuick] = useState<ReadonlySet<QuickFilter>>(
		new Set<QuickFilter>(),
	)
	// Stable for the life of the screen: filters compare against load time.
	const [now] = useState(() => Date.now())
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

	const quickActive = quick.size > 0
	const visibleGuests = useMemo(
		() => guests.filter((guest) => matchesQuickFilters(guest, quick, now)),
		[guests, quick, now],
	)
	const shownCount = visibleGuests.length
	const loadedCount = guests.length
	const filtering = debouncedQuery.trim() !== '' || tagId !== '' || quickActive
	const toggleQuick = (key: QuickFilter) =>
		setQuick((prev) => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	const quickOptions: Array<{ key: QuickFilter; label: string }> = [
		{ key: 'vip', label: _(msg`VIP`) },
		{ key: 'allergy', label: _(msg`Has allergy`) },
		{ key: 'lapsed', label: _(msg`Not visited in 90 days`) },
	]

	const tagOptions = [
		{ value: ALL_TAGS, label: _(msg`All guests`) },
		...tags.map((tag) => ({ value: tag.id, label: guestTagName(_, tag) })),
	]
	const sortOptions = GUEST_SORTS.map((value) => ({
		value,
		label: _(GUEST_SORT_LABELS[value]),
	}))

	return (
		<div className="flex flex-col gap-6" data-testid="guests-screen">
			{canBook ? (
				<ReservationsHeaderActions>
					<Button
						render={<Link to={`/${orgSlug}/reservations/book`} />}
						data-testid="guests-new-reservation"
					>
						<Icon name="plus" />
						<Trans>New reservation</Trans>
					</Button>
				</ReservationsHeaderActions>
			) : null}
			<WorkspaceToolbar>
				<div
					role="search"
					className="flex flex-col gap-2 md:flex-row md:items-center"
				>
					<div className="relative md:w-72">
						<Icon
							name="search"
							className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
						/>
						<Input
							id="guests-search"
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={_(msg`Name, phone or email`)}
							aria-label={_(msg`Search guests`)}
							autoComplete="off"
							className="ps-8"
							data-testid="guests-search"
						/>
					</div>
					<FilterSelect
						label={_(msg`Tag`)}
						options={tagOptions}
						value={tagId || ALL_TAGS}
						onValueChange={(next) => setTagId(next === ALL_TAGS ? '' : next)}
						testId="guests-tag-filter"
					/>
					<FilterSelect
						label={_(msg`Sort by`)}
						options={sortOptions}
						value={sort}
						onValueChange={(next) => setSort(next as GuestSort)}
						testId="guests-sort"
					/>
					<div
						role="group"
						aria-label={_(msg`Quick filters`)}
						className="flex flex-wrap gap-1.5"
					>
						{quickOptions.map((option) => (
							<Button
								key={option.key}
								type="button"
								variant={quick.has(option.key) ? 'secondary' : 'outline'}
								className="h-11 md:h-8"
								aria-pressed={quick.has(option.key)}
								onClick={() => toggleQuick(option.key)}
								data-testid={`guests-filter-${option.key}`}
							>
								{option.label}
							</Button>
						))}
					</div>
					{filtering ? (
						<Button
							type="button"
							variant="ghost"
							className="h-11 md:h-8"
							onClick={() => {
								setQuery('')
								setDebouncedQuery('')
								setTagId('')
								setQuick(new Set<QuickFilter>())
							}}
							data-testid="guests-clear-filters"
						>
							<Trans>Clear</Trans>
						</Button>
					) : null}
				</div>
				{guests.length > 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="guests-count"
					>
						{quickActive ? (
							<Trans>
								<Plural
									value={shownCount}
									one="# guest matches"
									other="# guests match"
								/>{' '}
								among the <bdi>{loadedCount}</bdi> loaded
							</Trans>
						) : (
							<Trans>
								<bdi>{shownCount}</bdi> of <bdi>{total}</bdi> guests
							</Trans>
						)}
						{quickActive && nextCursor ? (
							<>
								{' '}
								<Trans>Load more to search further.</Trans>
							</>
						) : null}
					</p>
				) : null}
			</WorkspaceToolbar>

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
				<Frame data-testid="guests-loading" aria-busy="true">
					<div role="status" className="divide-border flex flex-col divide-y">
						<span className="sr-only">
							<Trans>Loading guests...</Trans>
						</span>
						{[0, 1, 2, 3, 4].map((row) => (
							<div key={row} className="flex items-center gap-4 px-3 py-2.5">
								<Skeleton className="h-4 w-36" />
								<Skeleton className="h-4 w-28" />
								<Skeleton className="ms-auto h-4 w-12" />
							</div>
						))}
					</div>
				</Frame>
			) : null}

			{!loading && !error && visibleGuests.length === 0 ? (
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

			{visibleGuests.length > 0 ? (
				<>
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
										<Trans>Next booking</Trans>
									</TableHead>
									<TableHead>
										<Trans>Flags</Trans>
									</TableHead>
									<TableHead>
										<Trans>Tags</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{visibleGuests.map((guest) => (
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
										<TableCell
											className="text-muted-foreground text-sm"
											data-testid={`guest-next-${guest.id}`}
										>
											{formatInstantDate(guest.nextBookingAt, i18n.locale) ??
												'—'}
										</TableCell>
										<TableCell>
											{guest.hasAllergy ? (
												<Badge
													variant="warning"
													className="h-auto max-w-48 whitespace-normal"
													title={guest.allergyNotes ?? undefined}
													data-testid={`guest-allergy-${guest.id}`}
												>
													<span className="wrap-anywhere">
														{guest.allergyNotes
															? guest.allergyNotes
															: _(msg`Allergy`)}
													</span>
												</Badge>
											) : null}
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
