import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	HIRING_STAGES,
	type HiringOpenStage,
	type HiringStage,
} from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Toggle } from '@repo/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useIsMobile } from '@repo/ui/use-mobile'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	Link,
	Outlet,
	useNavigate,
	useOutlet,
	useSearchParams,
} from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { moveApplicant } from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import {
	applicantListSchema,
	type ApplicantScope,
	type ApplicantSummary,
} from '#app/utils/hiring/applicant-types.ts'
import { groupByStage, isOpenStage } from '#app/utils/hiring/applicant-view.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { ApplicantBoard, ApplicantBoardSkeleton } from './applicant-board.tsx'
import { type ApplicantsContext } from './applicant-context.ts'
import { useApplicantLabels } from './applicant-labels.ts'
import { ApplicantList, ApplicantListSkeleton } from './applicant-list.tsx'

const LIMIT = 200
type View = 'board' | 'list'
type StageFilter = 'open' | HiringStage

function useDebounced<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay)
		return () => clearTimeout(timer)
	}, [value, delay])
	return debounced
}

/**
 * The applicant pipeline: a board of columns or a list, the same data either
 * way. Everything is fetched browser-direct from the regional node; the filters
 * live in the address bar, so a refresh or the back button keeps the view. A
 * candidate opens in a side sheet (a child route) and the page keeps its place.
 */
export function ApplicantsPage({
	orgSlug,
	scopes,
	canWrite,
	canInvite,
	userId,
}: {
	orgSlug: string
	scopes: ApplicantScope[]
	canWrite: boolean
	canInvite: boolean
	userId: string
}) {
	const { _ } = useLingui()
	const direction = useDirection()
	const navigate = useNavigate()
	const outlet = useOutlet()
	const isMobile = useIsMobile()
	const labels = useApplicantLabels()
	const { client, ready, unavailable } = useStaffClient('hiring')
	const [params, setParams] = useSearchParams()
	const basePath = `/${orgSlug}/staff/hiring/applicants`

	const scopeById = useMemo(
		() => new Map(scopes.map((scope) => [scope.id, scope])),
		[scopes],
	)

	// A phone gets the list unless the address says otherwise.
	const view: View =
		params.get('view') === 'board'
			? 'board'
			: params.get('view') === 'list'
				? 'list'
				: isMobile
					? 'list'
					: 'board'
	const stageParam = params.get('stage')
	const stage: StageFilter =
		stageParam && (HIRING_STAGES as readonly string[]).includes(stageParam)
			? (stageParam as HiringStage)
			: 'open'
	const postingId = params.get('job') ?? 'all'
	const scopeId = params.get('scope') ?? 'all'
	const flagged = params.get('flagged') === '1'

	const [search, setSearch] = useState(params.get('q') ?? '')
	const query = useDebounced(search.trim(), 250)

	const setParam = useCallback(
		(changes: Record<string, string | null>) => {
			setParams(
				(current) => {
					const next = new URLSearchParams(current)
					for (const [key, value] of Object.entries(changes)) {
						if (value === null || value === '') next.delete(key)
						else next.set(key, value)
					}
					return next
				},
				{ replace: true },
			)
		},
		[setParams],
	)
	useEffect(() => {
		if (query !== (params.get('q') ?? '')) setParam({ q: query })
		// `params` changes on every filter; only a typed query should write.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query])

	const listPath = useMemo(() => {
		if (!ready) return null
		const next = new URLSearchParams()
		next.set('stage', view === 'board' ? 'open' : stage)
		if (postingId !== 'all') next.set('postingId', postingId)
		if (scopeId !== 'all') next.set('scopeId', scopeId)
		if (flagged) next.set('flagged', '1')
		if (query) next.set('q', query)
		next.set('limit', String(LIMIT))
		return `/applications?${next.toString()}`
	}, [ready, view, stage, postingId, scopeId, flagged, query])

	const list = useStaffQuery(client, listPath, applicantListSchema)
	const { reload } = list

	// Cards the manager just moved show in their new column straight away; the
	// override clears as soon as the server's own answer arrives.
	const [moves, setMoves] = useState<Record<string, HiringOpenStage>>({})
	useEffect(() => {
		setMoves({})
	}, [list.data])

	const applicants = useMemo<ApplicantSummary[]>(
		() =>
			(list.data?.applications ?? []).map((applicant) =>
				moves[applicant.id]
					? { ...applicant, stage: moves[applicant.id]! }
					: applicant,
			),
		[list.data, moves],
	)
	const groups = useMemo(() => groupByStage(applicants), [applicants])
	const counts = list.data?.counts ?? {}
	const total = list.data?.total ?? 0

	async function move(applicant: ApplicantSummary, to: HiringOpenStage) {
		if (!isOpenStage(applicant.stage) || applicant.stage === to) return
		setMoves((current) => ({ ...current, [applicant.id]: to }))
		try {
			await moveApplicant(client, applicant.id, to)
			reload()
		} catch (error) {
			setMoves((current) => {
				const { [applicant.id]: ignoredMove, ...rest } = current
				return rest
			})
			toast.error(describeApplicantError(error, _))
		}
	}

	const search_ = params.toString()
	const searchSuffix = search_ ? `?${search_}` : ''
	const hrefFor = useCallback(
		(applicant: ApplicantSummary) =>
			`${basePath}/${applicant.id}${searchSuffix}`,
		[basePath, searchSuffix],
	)
	// With one workplace there is nothing to tell apart, so no name is shown.
	const scopeName = useCallback(
		(id: string | null) =>
			scopes.length > 1 && id ? (scopeById.get(id)?.name ?? null) : null,
		[scopeById, scopes.length],
	)
	const timeZoneOf = useCallback(
		(id: string | null) => (id ? (scopeById.get(id)?.timeZone ?? null) : null),
		[scopeById],
	)
	const close = useCallback(
		() => void navigate(`${basePath}${searchSuffix}`),
		[navigate, basePath, searchSuffix],
	)

	const outletContext: ApplicantsContext = {
		orgSlug,
		basePath,
		search: searchSuffix,
		scopes,
		canWrite,
		userId,
		canInvite,
		reload,
		close,
	}

	const filtering =
		query !== '' || postingId !== 'all' || scopeId !== 'all' || flagged
	const loading = !ready || list.loading
	const postings = list.data?.postings ?? []
	const shown = applicants.length

	function clearFilters() {
		setSearch('')
		setParam({ q: null, job: null, scope: null, flagged: null })
	}

	const stageChips: Array<{
		value: StageFilter
		label: string
		count: number
	}> = [
		{
			value: 'open',
			label: _(t`In progress`),
			count: HIRING_STAGES.filter(isOpenStage).reduce(
				(sum, key) => sum + (counts[key] ?? 0),
				0,
			),
		},
		...HIRING_STAGES.map((key) => ({
			value: key as StageFilter,
			label: labels.stage[key],
			count: counts[key] ?? 0,
		})),
	]

	const jobOptions = [
		{ value: 'all', label: _(t`All jobs`) },
		...postings.map((posting) => ({
			value: posting.postingId,
			label: `${posting.title} (${posting.count})`,
		})),
	]
	const scopeOptions = [
		{ value: 'all', label: _(t`All workplaces`) },
		...scopes.map((scope) => ({
			value: scope.id,
			label: scope.name,
		})),
	]

	return (
		<div className="flex flex-col gap-4">
			<PageHeader
				title={_(t`Applicants`)}
				headingLevel="h2"
				size="section"
				description={_(
					t`People who applied through your website. Move them along, book interviews and hire.`,
				)}
			/>

			<div className="flex flex-col gap-2">
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
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={_(t`Search name or job`)}
							aria-label={_(t`Search applicants`)}
							className="h-11 ps-8 md:h-8"
						/>
					</div>
					<div className="grid grid-cols-2 gap-2 *:last:odd:col-span-2 md:contents">
						{postings.length > 1 || postingId !== 'all' ? (
							<FilterSelect
								label={_(t`Filter by job`)}
								options={jobOptions}
								value={postingId}
								onValueChange={(value) =>
									setParam({ job: value === 'all' ? null : value })
								}
							/>
						) : null}
						{scopes.length > 1 ? (
							<FilterSelect
								label={_(t`Filter by workplace`)}
								options={scopeOptions}
								value={scopeId}
								onValueChange={(value) =>
									setParam({ scope: value === 'all' ? null : value })
								}
							/>
						) : null}
						<Toggle
							pressed={flagged}
							onPressedChange={(pressed) =>
								setParam({ flagged: pressed ? '1' : null })
							}
							variant="outline"
						>
							<Icon name="alert-triangle" />
							<Trans>Answers to check</Trans>
						</Toggle>
					</div>
					<ToggleGroup
						aria-label={_(t`Applicant view`)}
						value={[view]}
						onValueChange={(next) => {
							const picked = next[0]
							if (picked === 'board' || picked === 'list') {
								setParam({ view: picked })
							}
						}}
						variant="segmented"
						className="md:ms-auto"
					>
						<ToggleGroupItem className="h-11 md:h-7" value="board">
							<Icon name="layout-grid" />
							<Trans>Board</Trans>
						</ToggleGroupItem>
						<ToggleGroupItem className="h-11 md:h-7" value="list">
							<Icon name="logs" />
							<Trans>List</Trans>
						</ToggleGroupItem>
					</ToggleGroup>
				</div>

				{view === 'list' ? (
					<div className="-mx-4 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
						<ToggleGroup
							aria-label={_(t`Filter by stage`)}
							value={[stage]}
							onValueChange={(next) => {
								const picked = next[0]
								if (picked)
									setParam({ stage: picked === 'open' ? null : picked })
							}}
							variant="segmented"
						>
							{stageChips.map((chip) => (
								<ToggleGroupItem
									className="h-11 md:h-7"
									key={chip.value}
									value={chip.value}
								>
									{chip.label}
									<span className="text-muted-foreground ms-1.5 text-xs tabular-nums">
										{chip.count}
									</span>
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</div>
				) : null}
			</div>

			{unavailable ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							We could not confirm your access to applicants. Reload the page to
							try again.
						</Trans>
					</AlertDescription>
				</Alert>
			) : list.error ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeStaffError(list.error, _)}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : loading ? (
				view === 'board' ? (
					<ApplicantBoardSkeleton />
				) : (
					<ApplicantListSkeleton />
				)
			) : applicants.length === 0 ? (
				<EmptyState
					title={
						<>
							{filtering ? (
								<Trans>No one matches</Trans>
							) : (
								<Trans>No applicants yet</Trans>
							)}
						</>
					}
					description={
						<>
							{filtering ? (
								<Trans>Try a different search or clear the filters.</Trans>
							) : (
								<Trans>
									When someone applies on your careers page, they show up here
									and you get a notification. Share a job to get started.
								</Trans>
							)}
						</>
					}
					icons={['users', 'user-plus', 'search']}
				>
					<>
						{filtering ? (
							<Button variant="outline" onClick={clearFilters}>
								<Trans>Clear filters</Trans>
							</Button>
						) : (
							<Button render={<Link to={`/${orgSlug}/staff/hiring`} />}>
								<Trans>See your jobs</Trans>
							</Button>
						)}
					</>
				</EmptyState>
			) : (
				<div
					className={
						list.refreshing ? 'opacity-70 transition-opacity' : undefined
					}
					aria-busy={list.refreshing}
				>
					{view === 'board' ? (
						<ApplicantBoard
							groups={groups}
							counts={
								total <= LIMIT
									? Object.fromEntries(
											(Object.keys(groups) as HiringOpenStage[]).map((key) => [
												key,
												groups[key].length,
											]),
										)
									: counts
							}
							labels={labels}
							scopeName={scopeName}
							timeZoneOf={timeZoneOf}
							hrefFor={hrefFor}
							canMove={canWrite}
							onMove={(applicant, to) => void move(applicant, to)}
						/>
					) : (
						<ApplicantList
							rows={applicants}
							labels={labels}
							scopeName={scopeName}
							timeZoneOf={timeZoneOf}
							hrefFor={hrefFor}
						/>
					)}
					{total > applicants.length ? (
						<p
							className="text-muted-foreground mt-3 text-sm"
							aria-live="polite"
						>
							<Trans>
								Showing the newest {shown} of {total}. Search or filter to
								narrow the list.
							</Trans>
						</p>
					) : null}
				</div>
			)}

			<Sheet
				open={outlet !== null}
				onOpenChange={(open) => {
					if (!open) close()
				}}
			>
				<SheetContent
					side={direction === 'rtl' ? 'left' : 'right'}
					className="flex w-full flex-col gap-0 data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl"
				>
					<Outlet context={outletContext} />
				</SheetContent>
			</Sheet>
		</div>
	)
}
