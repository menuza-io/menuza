import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type CountSummary, listCountsResultSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useEffect, useRef, useState } from 'react'
import {
	Link,
	useLoaderData,
	useLocation,
	useNavigate,
	useSearchParams,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CountStatusBadge } from '#app/components/inventory/count-status-badge.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import { useInventoryRevision } from '#app/components/inventory/inventory-prefs.tsx'
import { StartCountDialog } from '#app/components/inventory/start-count-dialog.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadMemberNames } from '#app/utils/inventory/actors.server.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	inventoryCountPath,
	inventoryCountReviewPath,
} from '#app/utils/inventory/nav.ts'
import { type Route } from './+types/counts.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	return { memberNames: await loadMemberNames(access.organizationId) }
}

const PAST_PAGE_SIZE = 25
const PAST_MAX_LIMIT = 200

export default function InventoryCountsRoute() {
	const { t, i18n } = useLingui()
	const { memberNames } = useLoaderData<typeof loader>()
	const {
		orgSlug,
		activeLocationId,
		canEdit,
		canSeeCost,
		currency,
		locations,
	} = useInventoryLayoutData()
	const { search } = useLocation()
	const navigate = useNavigate()
	const [searchParams, setSearchParams] = useSearchParams()
	const linkSearch = locations.length > 1 ? search : ''
	const [startOpen, setStartOpen] = useState(false)
	const [pastLimit, setPastLimit] = useState(PAST_PAGE_SIZE)

	// `?start=1` (from Today) opens the dialog once, then leaves the URL clean.
	useEffect(() => {
		if (searchParams.get('start') !== '1') return
		if (canEdit) setStartOpen(true)
		const next = new URLSearchParams(searchParams)
		next.delete('start')
		setSearchParams(next, { replace: true })
	}, [canEdit, searchParams, setSearchParams])

	const open = useInventoryQuery(
		`/counts?${new URLSearchParams({ locationId: activeLocationId, status: 'open', limit: '50' })}`,
		listCountsResultSchema,
	)
	const past = useInventoryQuery(
		`/counts?${new URLSearchParams({ locationId: activeLocationId, status: 'closed', limit: String(pastLimit) })}`,
		listCountsResultSchema,
	)
	const { reload: reloadOpen } = open
	const { reload: reloadPast } = past
	const revision = useInventoryRevision()
	const seenRevision = useRef(revision)
	useEffect(() => {
		if (revision !== seenRevision.current) {
			seenRevision.current = revision
			reloadOpen()
			reloadPast()
		}
	}, [revision, reloadOpen, reloadPast])

	const who = (actor: CountSummary['startedBy']) =>
		actor.kind === 'operator' && actor.id
			? (memberNames[actor.id] ?? '')
			: actor.kind === 'staff'
				? t`Staff member`
				: ''
	const when = (at: number) =>
		new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(at))
	const day = (date: string) => {
		const [year, month, dayOfMonth] = date.split('-').map(Number) as [
			number,
			number,
			number,
		]
		return new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
		}).format(new Date(year, month - 1, dayOfMonth))
	}
	const name = (count: CountSummary) => count.listName ?? t`Full count`
	const hrefFor = (count: CountSummary) =>
		`${
			count.status === 'in_review'
				? inventoryCountReviewPath(orgSlug, count.id)
				: inventoryCountPath(orgSlug, count.id)
		}${linkSearch}`

	const openCounts = open.data?.counts ?? []
	const pastCounts = past.data?.counts ?? []
	const showDifference =
		canSeeCost &&
		pastCounts.some((count) => count.differenceValueMinor !== undefined)
	const hasMorePast =
		past.data?.nextCursor !== null && past.data?.nextCursor !== undefined

	const startButton = canEdit ? (
		<Button onClick={() => setStartOpen(true)} data-testid="counts-start">
			<Icon name="plus" />
			<Trans>Start count</Trans>
		</Button>
	) : null

	return (
		<div className="flex flex-col gap-6">
			{startButton ? (
				<InventoryHeaderActions>{startButton}</InventoryHeaderActions>
			) : null}

			<WorkspacePanel title={<Trans>In progress</Trans>}>
				{open.error && !open.data ? (
					<Alert variant="destructive" data-testid="counts-open-error">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(open.error))}
						</AlertDescription>
						<Button
							className="mt-2 justify-self-start"
							variant="outline"
							onClick={open.reload}
						>
							<Trans>Try again</Trans>
						</Button>
					</Alert>
				) : !open.data ? (
					<div role="status" className="flex flex-col gap-2">
						<span className="sr-only">
							<Trans>Loading counts</Trans>
						</span>
						<Skeleton className="h-16 w-full rounded-xl" />
					</div>
				) : openCounts.length === 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="counts-none-open"
					>
						<Trans>No count is in progress.</Trans>
					</p>
				) : (
					<ul className="flex flex-col gap-2" data-testid="counts-open">
						{openCounts.map((count) => (
							<li
								key={count.id}
								className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
								data-testid={`count-card-${count.id}`}
							>
								<div className="flex min-w-0 flex-col gap-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium wrap-anywhere">
											{name(count)}
										</span>
										<CountStatusBadge status={count.status} />
									</div>
									<StartedLine
										startedAt={when(count.createdAt)}
										by={who(count.startedBy)}
									/>
								</div>
								<div className="flex items-center justify-between gap-4 sm:justify-end">
									<CountProgress
										counted={count.itemsCounted}
										total={count.itemTotal}
										testId={`count-card-progress-${count.id}`}
									/>
									<Button
										variant={
											count.status === 'counting' && canEdit
												? 'default'
												: 'outline'
										}
										render={<Link to={hrefFor(count)} />}
										data-testid={`count-card-open-${count.id}`}
									>
										{count.status === 'in_review' ? (
											<Trans>Review</Trans>
										) : canEdit ? (
											<Trans>Resume</Trans>
										) : (
											<Trans>View</Trans>
										)}
									</Button>
								</div>
							</li>
						))}
					</ul>
				)}
			</WorkspacePanel>

			<WorkspacePanel title={<Trans>Past counts</Trans>}>
				{past.error && !past.data ? (
					<Alert variant="destructive" data-testid="counts-past-error">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(past.error))}
						</AlertDescription>
						<Button
							className="mt-2 justify-self-start"
							variant="outline"
							onClick={past.reload}
						>
							<Trans>Try again</Trans>
						</Button>
					</Alert>
				) : !past.data ? (
					<div role="status" className="flex flex-col gap-2">
						<span className="sr-only">
							<Trans>Loading past counts</Trans>
						</span>
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : pastCounts.length === 0 && openCounts.length === 0 ? (
					<EmptyState
						title={<Trans>No counts yet</Trans>}
						description={
							<Trans>
								Walk your fridges and shelves, enter what is there, and see what
								is missing compared with what you expected.
							</Trans>
						}
						icons={['list', 'check-circle', 'layers']}
					>
						{startButton}
					</EmptyState>
				) : pastCounts.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Approved and cancelled counts will show here.</Trans>
					</p>
				) : (
					<div
						className={
							past.refreshing ? 'opacity-70 transition-opacity' : undefined
						}
						aria-busy={past.refreshing}
					>
						<Frame className="hidden w-full md:flex">
							<Table variant="card" data-testid="counts-past">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Date</Trans>
										</TableHead>
										<TableHead>
											<Trans>Count</Trans>
										</TableHead>
										<TableHead>
											<Trans>By</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Items</Trans>
										</TableHead>
										{showDifference ? (
											<TableHead className="text-end">
												<Trans>Difference</Trans>
											</TableHead>
										) : null}
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pastCounts.map((count) => (
										<TableRow
											key={count.id}
											className="cursor-pointer"
											data-testid={`count-row-${count.id}`}
											onClick={() => void navigate(hrefFor(count))}
										>
											<TableCell className="tabular-nums">
												<bdi dir="ltr">{day(count.businessDate)}</bdi>
											</TableCell>
											<TableCell>
												<Link
													to={hrefFor(count)}
													className="focus-visible:ring-ring/50 rounded-sm font-medium wrap-anywhere outline-none focus-visible:ring-3"
													onClick={(event) => event.stopPropagation()}
												>
													{name(count)}
												</Link>
											</TableCell>
											<TableCell className="wrap-anywhere">
												{who(count.approvedBy ?? count.startedBy)}
											</TableCell>
											<TableCell className="text-end tabular-nums">
												<bdi dir="ltr">{count.itemsCounted}</bdi>
											</TableCell>
											{showDifference ? (
												<TableCell className="text-end tabular-nums">
													{count.status === 'approved' &&
													count.differenceValueMinor !== undefined ? (
														<bdi dir="ltr">
															{formatMoney(
																count.differenceValueMinor,
																count.currency ?? currency,
																i18n.locale,
															)}
														</bdi>
													) : (
														<span className="text-muted-foreground">—</span>
													)}
												</TableCell>
											) : null}
											<TableCell>
												<CountStatusBadge status={count.status} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</Frame>

						<ItemGroup className="md:hidden">
							{pastCounts.map((count) => (
								<Item
									key={count.id}
									variant="outline"
									render={<Link to={hrefFor(count)} />}
									data-testid={`count-item-${count.id}`}
								>
									<ItemContent>
										<ItemTitle className="wrap-anywhere">
											{name(count)}
										</ItemTitle>
										<ItemDescription>
											<bdi dir="ltr">{day(count.businessDate)}</bdi>
											{' · '}
											<Plural
												value={count.itemsCounted}
												one="# item"
												other="# items"
											/>
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<div className="flex flex-col items-end gap-1">
											{showDifference &&
											count.status === 'approved' &&
											count.differenceValueMinor !== undefined ? (
												<bdi dir="ltr" className="text-sm tabular-nums">
													{formatMoney(
														count.differenceValueMinor,
														count.currency ?? currency,
														i18n.locale,
													)}
												</bdi>
											) : null}
											<CountStatusBadge status={count.status} />
										</div>
									</ItemActions>
								</Item>
							))}
						</ItemGroup>

						{hasMorePast && pastLimit < PAST_MAX_LIMIT ? (
							<div className="mt-3 flex justify-end">
								<Button
									variant="outline"
									onClick={() =>
										setPastLimit((current) =>
											Math.min(current + PAST_PAGE_SIZE, PAST_MAX_LIMIT),
										)
									}
									data-testid="counts-show-more"
								>
									<Trans>Show more</Trans>
								</Button>
							</div>
						) : null}
					</div>
				)}
			</WorkspacePanel>

			{canEdit ? (
				<StartCountDialog
					open={startOpen}
					onOpenChange={setStartOpen}
					orgSlug={orgSlug}
					locationId={activeLocationId}
					search={linkSearch}
				/>
			) : null}
		</div>
	)
}

function CountProgress({
	counted,
	total,
	testId,
}: {
	counted: number
	total: number
	testId: string
}) {
	return (
		<span className="text-sm tabular-nums" data-testid={testId}>
			<Trans>
				<bdi dir="ltr">{counted}</bdi> of <bdi dir="ltr">{total}</bdi>
			</Trans>
		</span>
	)
}

function StartedLine({ startedAt, by }: { startedAt: string; by: string }) {
	return (
		<span className="text-muted-foreground text-xs">
			{by ? (
				<Trans>
					Started {startedAt} by <span className="wrap-anywhere">{by}</span>
				</Trans>
			) : (
				<Trans>Started {startedAt}</Trans>
			)}
		</span>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
