import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspacePage, WorkspaceToolbar } from '@repo/ui/workspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { PersonTagBadge } from '#app/components/customers/person-tag-badge.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { type PeopleAccess } from '#app/utils/people/people-access.ts'
import {
	fetchPeoplePage,
	type PeopleClient,
	type PeopleQuickFilter,
	type PeopleSort,
	PEOPLE_SORTS,
	type PersonRow,
	type PersonStatus,
} from '#app/utils/people/people-api.ts'
import { peopleErrorInfo } from '#app/utils/people/people-errors.ts'
import {
	formatInstantDate,
	PEOPLE_SORT_LABELS,
} from '#app/utils/people/people-view.ts'

const SEARCH_DEBOUNCE_MS = 300

/** Exclusive pairs: a person is either signed in or guest-only, never both. */
const EXCLUSIVE: Partial<Record<PeopleQuickFilter, PeopleQuickFilter>> = {
	signed_in: 'guest_only',
	guest_only: 'signed_in',
}

export function StatusBadge({ status }: { status: PersonStatus }) {
	if (status === 'signed_in') {
		return (
			<Badge variant="success" data-testid="person-status-signed-in">
				<Trans>Signed in</Trans>
			</Badge>
		)
	}
	if (status === 'guest_no_sign_in') {
		return (
			<Badge variant="outline" data-testid="person-status-guest">
				<Trans>Guest, no sign-in</Trans>
			</Badge>
		)
	}
	return (
		<Badge variant="outline" data-testid="person-status-unverified">
			<Trans>Not verified</Trans>
		</Badge>
	)
}

export function PeopleListScreen({
	client,
	orgSlug,
	access,
	canBook,
}: {
	client: PeopleClient
	orgSlug: string
	access: PeopleAccess
	/** Reservations are on and the member may book: shows New reservation. */
	canBook: boolean
}) {
	const { _, i18n } = useLingui()
	const dining = access.dining !== 'none'
	const fullDining = access.dining === 'full'
	const [query, setQuery] = useState('')
	const [debouncedQuery, setDebouncedQuery] = useState('')
	const [sort, setSort] = useState<PeopleSort>('recent')
	const [filters, setFilters] = useState<ReadonlySet<PeopleQuickFilter>>(
		new Set<PeopleQuickFilter>(),
	)
	const [people, setPeople] = useState<PersonRow[]>([])
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const [total, setTotal] = useState(0)
	const [hasOrders, setHasOrders] = useState(false)
	const [walkInCount, setWalkInCount] = useState<number | null>(null)
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

	const load = useCallback(
		async (cursor: string | null, signal?: AbortSignal) => {
			const current = (requestId.current += 1)
			try {
				const page = await fetchPeoplePage(
					client,
					{ q: debouncedQuery, filters, sort, cursor },
					signal,
				)
				if (current !== requestId.current) return
				setPeople((prev) => (cursor ? [...prev, ...page.people] : page.people))
				setNextCursor(page.nextCursor)
				setTotal(page.total)
				setHasOrders(page.hasOrders)
				setWalkInCount(page.walkInCount)
				setError(null)
			} catch (err) {
				if (signal?.aborted || current !== requestId.current) return
				setError(peopleErrorInfo(err).status === 403 ? 'denied' : 'failed')
			} finally {
				if (current === requestId.current) {
					setLoading(false)
					setLoadingMore(false)
				}
			}
		},
		[client, debouncedQuery, filters, sort],
	)

	useEffect(() => {
		const controller = new AbortController()
		setLoading(true)
		void load(null, controller.signal)
		return () => controller.abort()
	}, [load])

	const toggle = (key: PeopleQuickFilter) =>
		setFilters((prev) => {
			const next = new Set(prev)
			if (next.has(key)) {
				next.delete(key)
			} else {
				next.add(key)
				const other = EXCLUSIVE[key]
				if (other) next.delete(other)
			}
			return next
		})

	const filterOptions: Array<{ key: PeopleQuickFilter; label: string }> = [
		...(dining ? [{ key: 'vip' as const, label: _(msg`VIP`) }] : []),
		...(fullDining
			? [{ key: 'allergy' as const, label: _(msg`Has allergy`) }]
			: []),
		...(dining
			? [
					{ key: 'lapsed' as const, label: _(msg`Lapsed 90d`) },
					{ key: 'upcoming' as const, label: _(msg`Upcoming booking`) },
				]
			: []),
		{ key: 'signed_in', label: _(msg`Signed in`) },
		...(dining
			? [
					{ key: 'guest_only' as const, label: _(msg`Guest only`) },
					{
						key: 'walk_ins' as const,
						label: _(msg`Show walk-ins without contact details`),
					},
				]
			: []),
	]
	const filtering = debouncedQuery.trim() !== '' || filters.size > 0
	const sortOptions = PEOPLE_SORTS.filter(
		(value) => dining || (value !== 'visits' && value !== 'last_visit'),
	).map((value) => ({ value, label: _(PEOPLE_SORT_LABELS[value]) }))
	const showOrders = hasOrders && access.customers
	const shownCount = people.length

	return (
		<WorkspacePage>
			<PageHeader
				title={<Trans>Customers</Trans>}
				description={
					<Trans>
						Everyone who has ordered, signed in or booked a table, in one list.
						Data is served from your tenant region.
					</Trans>
				}
				actions={
					canBook ? (
						<Button
							render={<Link to={`/${orgSlug}/reservations/book`} />}
							data-testid="customers-new-reservation"
						>
							<Icon name="plus" />
							<Trans>New reservation</Trans>
						</Button>
					) : null
				}
			/>
			<div className="flex flex-col gap-6" data-testid="customers-screen">
				<WorkspaceToolbar>
					<div
						role="search"
						className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center"
					>
						<div className="relative md:w-72">
							<Icon
								name="search"
								className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
							/>
							<Input
								id="customers-search"
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={_(msg`Name, phone or email`)}
								aria-label={_(msg`Search customers`)}
								autoComplete="off"
								className="ps-8"
								data-testid="customers-search"
							/>
						</div>
						<FilterSelect
							label={_(msg`Sort by`)}
							options={sortOptions}
							value={sort}
							onValueChange={(next) => setSort(next as PeopleSort)}
							testId="customers-sort"
						/>
						<div
							role="group"
							aria-label={_(msg`Quick filters`)}
							className="flex flex-wrap gap-1.5"
						>
							{filterOptions.map((option) => (
								<Button
									key={option.key}
									type="button"
									variant={filters.has(option.key) ? 'secondary' : 'outline'}
									className="h-11 md:h-8"
									aria-pressed={filters.has(option.key)}
									onClick={() => toggle(option.key)}
									data-testid={`customers-filter-${option.key}`}
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
									setFilters(new Set<PeopleQuickFilter>())
								}}
								data-testid="customers-clear-filters"
							>
								<Trans>Clear</Trans>
							</Button>
						) : null}
					</div>
					{people.length > 0 || filtering ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="customers-count"
						>
							<Trans>
								<bdi>{shownCount}</bdi> of <bdi>{total}</bdi>{' '}
								<Plural value={total} one="person" other="people" />
							</Trans>
						</p>
					) : null}
				</WorkspaceToolbar>

				{error === 'denied' ? (
					<Alert variant="destructive" data-testid="customers-denied">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Trans>You do not have access to customer data.</Trans>
						</AlertDescription>
					</Alert>
				) : error === 'failed' ? (
					<Alert variant="destructive" data-testid="customers-error">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<div className="flex flex-wrap items-center gap-3">
								<Trans>The customer list could not be loaded.</Trans>
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

				{loading && people.length === 0 && !error ? (
					<Frame data-testid="customers-loading" aria-busy="true">
						<div role="status" className="divide-border flex flex-col divide-y">
							<span className="sr-only">
								<Trans>Loading customers...</Trans>
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

				{!loading && !error && people.length === 0 ? (
					<div
						data-testid={
							filtering ? 'customers-empty-search' : 'customers-empty'
						}
					>
						<EmptyState
							title={
								filtering ? (
									<Trans>No customers match your search</Trans>
								) : (
									<Trans>No customers yet</Trans>
								)
							}
							description={
								filtering ? (
									<Trans>
										Try a different name, part of a phone number, or an email
										address, or clear the filters.
									</Trans>
								) : (
									<Trans>
										People appear here after they sign in on your site, order or
										book a table.
									</Trans>
								)
							}
							icons={['users', 'calendar', 'clock']}
						/>
						{walkInCount !== null &&
						walkInCount > 0 &&
						!filters.has('walk_ins') ? (
							<p className="text-muted-foreground mt-3 text-center text-sm">
								<Trans>
									Walk-ins without contact details are hidden.{' '}
									<Button
										type="button"
										variant="link"
										className="h-auto p-0"
										onClick={() => toggle('walk_ins')}
									>
										Show them
									</Button>
								</Trans>
							</p>
						) : null}
					</div>
				) : null}

				{people.length > 0 ? (
					<>
						<Frame>
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Name</Trans>
										</TableHead>
										<TableHead>
											<Trans>Contact</Trans>
										</TableHead>
										{dining ? (
											<>
												<TableHead className="text-end">
													<Trans>Visits</Trans>
												</TableHead>
												<TableHead>
													<Trans>Last visit</Trans>
												</TableHead>
												<TableHead>
													<Trans>Next booking</Trans>
												</TableHead>
											</>
										) : null}
										{showOrders ? (
											<TableHead className="text-end">
												<Trans>Orders</Trans>
											</TableHead>
										) : null}
										<TableHead>
											<Trans>Flags</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{people.map((person) => (
										<TableRow
											key={person.key}
											data-testid={`person-row-${person.key}`}
										>
											<TableCell>
												<div className="flex flex-col items-start gap-1">
													<Link
														to={customersHref(orgSlug, {
															personKey: person.key,
														})}
														className="text-foreground font-medium underline-offset-4 hover:underline"
														data-testid={`person-link-${person.key}`}
													>
														<span className="wrap-anywhere">{person.name}</span>
													</Link>
													<StatusBadge status={person.status} />
												</div>
											</TableCell>
											<TableCell className="text-muted-foreground text-sm">
												<div className="flex flex-col">
													{person.phone ? (
														<bdi dir="ltr" className="text-start">
															{person.phone}
														</bdi>
													) : null}
													{person.email ? (
														<bdi dir="ltr" className="text-start wrap-anywhere">
															{person.email}
														</bdi>
													) : null}
													{!person.phone && !person.email ? '—' : null}
												</div>
											</TableCell>
											{dining ? (
												<>
													<TableCell className="text-end tabular-nums">
														{person.dining ? (
															<bdi>{person.dining.visits}</bdi>
														) : (
															'—'
														)}
													</TableCell>
													<TableCell className="text-muted-foreground text-sm">
														{formatInstantDate(
															person.dining?.lastVisitAt ?? null,
															i18n.locale,
														) ?? '—'}
													</TableCell>
													<TableCell
														className="text-muted-foreground text-sm"
														data-testid={`person-next-${person.key}`}
													>
														{formatInstantDate(
															person.dining?.nextBookingAt ?? null,
															i18n.locale,
														) ?? '—'}
													</TableCell>
												</>
											) : null}
											{showOrders ? (
												<TableCell className="text-end tabular-nums">
													{person.orders ? (
														<bdi>{person.orders.count}</bdi>
													) : (
														'—'
													)}
												</TableCell>
											) : null}
											<TableCell>
												<div className="flex flex-wrap gap-1">
													{person.tags
														.filter(
															(tag) =>
																tag.category === 'vip' || /vip/i.test(tag.name),
														)
														.slice(0, 1)
														.map((tag) => (
															<PersonTagBadge key={tag.id} tag={tag} />
														))}
													{person.flags.allergy ? (
														<Badge
															variant="warning"
															data-testid={`person-allergy-${person.key}`}
														>
															<Trans>Allergy</Trans>
														</Badge>
													) : null}
													{person.flags.noShowRisk ? (
														<Badge
															variant="destructive"
															data-testid={`person-no-show-risk-${person.key}`}
														>
															<Trans>No-show risk</Trans>
														</Badge>
													) : null}
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
									data-testid="customers-load-more"
								>
									<Trans>Load more</Trans>
								</Button>
							</div>
						) : null}
					</>
				) : null}
			</div>
		</WorkspacePage>
	)
}
