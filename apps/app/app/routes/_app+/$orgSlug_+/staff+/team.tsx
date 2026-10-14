import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	Link,
	Outlet,
	useLoaderData,
	useNavigate,
	useOutlet,
} from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	StaffRoster,
	StaffRosterSkeleton,
} from '#app/components/staff/staff-roster.tsx'
import { type StaffTeamContext } from '#app/components/staff/team-context.ts'
import { useOnboardingSummary } from '#app/hooks/use-onboarding-summary.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	getStaffingFeatureState,
	requireStaffingAccess,
} from '#app/utils/staffing/access.server.ts'
import { localToday } from '#app/utils/staffing/onboarding-view.ts'
import {
	buildRosterCsv,
	downloadCsv,
} from '#app/utils/staffing/roster-export.ts'
import {
	holdsStaffingGrant,
	STAFF_SECTION_REQUIREMENTS,
} from '#app/utils/staffing/sections.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	positionsSchema,
	staffListSchema,
	type StaffListRow,
} from '#app/utils/staffing/staff-types.ts'
import {
	filterScopesToScope,
	loadStaffScopes,
} from '#app/utils/staffing/team-context.server.ts'
import { type Route } from './+types/team.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.team,
	)
	// A manager limited to some scopes is only offered those: the same list
	// feeds the filter and every "add to scope" picker. tenant-api enforces
	// the scope regardless; this just keeps the screen honest.
	const allScopes = await loadStaffScopes(access.organizationId)
	const scopes = filterScopesToScope(allScopes, access.scopeIds)
	// Onboarding progress on the roster is part of Hiring: it needs that flag and
	// the hiring read grant, and is simply absent otherwise.
	const features = await getStaffingFeatureState(access.organizationId)
	return {
		orgSlug: params.orgSlug,
		onboarding:
			features.hiring && holdsStaffingGrant(access.grants, P.READ_HIRING),
		/** False for a manager limited to selected scopes. */
		allScopes: access.scopeIds === null,
		dataRegion:
			access.dataRegion === 'ksa' ? ('ksa' as const) : ('us' as const),
		scopes,
	}
}

const PAGE_SIZE = 50
const MAX_LIST = 200

type StatusFilter = 'current' | 'active' | 'on_leave' | 'invited' | 'terminated'

function useDebounced<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay)
		return () => clearTimeout(timer)
	}, [value, delay])
	return debounced
}

export default function StaffTeamRoute() {
	const {
		orgSlug,
		dataRegion,
		scopes: rawScopes,
		allScopes,
		onboarding: showOnboarding,
	} = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const direction = useDirection()
	const navigate = useNavigate()
	const outlet = useOutlet()
	const { client, can, ready, unavailable } = useStaffClient('staff')
	const basePath = `/${orgSlug}/staff/team`
	// Scope names may be stored per language; show the operator's language.
	const scopes = useMemo(
		() =>
			rawScopes.map((scope) => ({
				...scope,
				name: pickLocalized(scope.name, i18n.locale, 'en') || scope.name,
			})),
		[rawScopes, i18n.locale],
	)

	const canWrite = can(P.UPDATE_STAFF)
	const canSeePay = can(P.READ_STAFF_PAY)

	const [search, setSearch] = useState('')
	const [status, setStatus] = useState<StatusFilter>('current')
	const [scopeId, setScopeId] = useState('all')
	const [positionId, setPositionId] = useState('all')
	const [limit, setLimit] = useState(PAGE_SIZE)
	const query = useDebounced(search.trim(), 250)

	const listPath = useMemo(() => {
		if (!ready) return null
		const params = new URLSearchParams()
		if (query) params.set('q', query)
		if (status !== 'current') params.set('status', status)
		if (scopeId !== 'all') params.set('scopeId', scopeId)
		if (positionId !== 'all') params.set('positionId', positionId)
		if (canSeePay) params.set('include', 'pay')
		params.set('limit', String(limit))
		return `/?${params.toString()}`
	}, [ready, query, status, scopeId, positionId, canSeePay, limit])

	// Back to the first page whenever a filter changes.
	useEffect(() => {
		setLimit(PAGE_SIZE)
	}, [query, status, scopeId, positionId])

	const list = useStaffQuery(client, listPath, staffListSchema)
	const positionsQuery = useStaffQuery(
		client,
		ready ? '/positions' : null,
		positionsSchema,
	)

	const positions = useMemo(
		() => positionsQuery.data?.positions ?? [],
		[positionsQuery.data],
	)
	const positionMap = useMemo(
		() => new Map(positions.map((position) => [position.id, position])),
		[positions],
	)
	const scopeMap = useMemo(
		() => new Map(scopes.map((scope) => [scope.id, scope])),
		[scopes],
	)

	const { reload: reloadList } = list
	const onboardingSummary = useOnboardingSummary(showOnboarding && ready)
	const { reload: reloadOnboarding } = onboardingSummary
	const today = useMemo(() => localToday(), [])
	const { reload: reloadPositions } = positionsQuery
	const close = useCallback(() => void navigate(basePath), [navigate, basePath])

	const outletContext: StaffTeamContext = {
		orgSlug,
		basePath,
		dataRegion,
		scopes,
		positions,
		reloadRoster: reloadList,
		reloadPositions,
		reloadOnboarding,
		close,
	}

	const filtering =
		query !== '' ||
		status !== 'current' ||
		scopeId !== 'all' ||
		positionId !== 'all'
	const rows = list.data?.staff ?? []
	const total = list.data?.total ?? 0
	const shownCount = rows.length
	const loading = !ready || list.loading
	const [exporting, setExporting] = useState(false)

	function clearFilters() {
		setSearch('')
		setStatus('current')
		setScopeId('all')
		setPositionId('all')
	}

	async function exportCsv() {
		setExporting(true)
		try {
			const collected: StaffListRow[] = []
			for (let offset = 0; offset < 1000; offset += MAX_LIST) {
				const params = new URLSearchParams()
				if (query) params.set('q', query)
				if (status !== 'current') params.set('status', status)
				if (scopeId !== 'all') params.set('scopeId', scopeId)
				if (positionId !== 'all') params.set('positionId', positionId)
				if (canSeePay) params.set('include', 'pay')
				params.set('limit', String(MAX_LIST))
				params.set('offset', String(offset))
				const page = staffListSchema.parse(
					await client.request(`/?${params.toString()}`),
				)
				collected.push(...page.staff)
				if (collected.length >= page.total) break
			}
			const csv = buildRosterCsv({
				staff: collected,
				positions: positionMap,
				scopes: scopeMap,
				includePay: canSeePay,
				labels: {
					name: _(t`Name`),
					status: _(t`Status`),
					email: _(t`Email`),
					phone: _(t`Phone`),
					employeeNumber: _(t`Payroll ID`),
					scopes: _(t`Workplaces`),
					positions: _(t`Positions`),
					hired: _(t`Hire date`),
					payType: _(t`Pay type`),
					rate: _(t`Hourly rate`),
					salary: _(t`Annual salary`),
					currency: _(t`Currency`),
					statuses: {
						active: _(t`Active`),
						invited: _(t`Invited`),
						on_leave: _(t`On leave`),
						terminated: _(t`Left the team`),
					},
					payTypes: { hourly: _(t`Hourly`), salary: _(t`Salary`) },
				},
			})
			downloadCsv(`team-${new Date().toISOString().slice(0, 10)}.csv`, csv)
			const exportedCount = collected.length
			toast.success(_(t`Exported ${exportedCount} people.`))
		} catch (error) {
			toast.error(describeStaffError(error, _))
		} finally {
			setExporting(false)
		}
	}

	const statusOptions = [
		{ value: 'current', label: _(t`Current`) },
		{ value: 'active', label: _(t`Active`) },
		{ value: 'on_leave', label: _(t`On leave`) },
		{ value: 'invited', label: _(t`Invited`) },
		{ value: 'terminated', label: _(t`Left the team`) },
	]
	const scopeOptions = [
		{ value: 'all', label: _(t`All workplaces`) },
		...scopes.map((scope) => ({
			value: scope.id,
			label: scope.name,
		})),
	]
	const positionOptions = [
		{ value: 'all', label: _(t`All positions`) },
		...positions.map((position) => ({
			value: position.id,
			label: position.name,
		})),
	]

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(t`Team`)}
				description={_(
					t`The people who work here, their positions and where they work.`,
				)}
				actions={
					<>
						<Button
							variant="outline"
							render={<Link to={`/${orgSlug}/staff/positions`} />}
						>
							<Trans>Positions</Trans>
						</Button>
						{canWrite ? (
							<Button render={<Link to={`${basePath}/new`} />}>
								<Icon name="plus" />
								<Trans>Add staff</Trans>
							</Button>
						) : null}
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="outline"
										size="icon-sm"
										aria-label={_(t`More team actions`)}
									>
										<Icon name="ellipsis" />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								{canWrite ? (
									<>
										{allScopes ? (
											<DropdownMenuItem
												render={<Link to={`${basePath}/import`} />}
											>
												<Icon name="users" />
												<Trans>Import current members</Trans>
											</DropdownMenuItem>
										) : null}
										<DropdownMenuItem render={<Link to={`${basePath}/bulk`} />}>
											<Icon name="user-plus" />
											<Trans>Bulk add</Trans>
										</DropdownMenuItem>
										<DropdownMenuSeparator />
									</>
								) : null}
								<DropdownMenuItem
									disabled={exporting || rows.length === 0}
									onClick={() => void exportCsv()}
								>
									<Icon name="download" />
									<Trans>Export CSV</Trans>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				}
			/>

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
						placeholder={_(t`Search name, email or phone`)}
						aria-label={_(t`Search team`)}
						className="h-11 ps-8"
					/>
				</div>
				<div className="grid grid-cols-2 gap-2 *:last:odd:col-span-2 md:contents">
					<FilterSelect
						label={_(t`Filter by status`)}
						options={statusOptions}
						value={status}
						onValueChange={(value) => setStatus(value as StatusFilter)}
					/>
					{scopes.length > 1 ? (
						<FilterSelect
							label={_(t`Filter by workplace`)}
							options={scopeOptions}
							value={scopeId}
							onValueChange={setScopeId}
						/>
					) : null}
					{positions.length > 0 ? (
						<FilterSelect
							label={_(t`Filter by position`)}
							options={positionOptions}
							value={positionId}
							onValueChange={setPositionId}
						/>
					) : null}
				</div>
			</div>

			{unavailable ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							We could not confirm your access to staff data. Reload the page to
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
						onClick={reloadList}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : loading ? (
				<StaffRosterSkeleton showPay={canSeePay} />
			) : rows.length === 0 ? (
				filtering ? (
					<EmptyState
						title={
							<>
								<Trans>No one matches</Trans>
							</>
						}
						description={
							<>
								<Trans>Try a different search or clear the filters.</Trans>
							</>
						}
						icons={['search', 'users', 'user']}
					>
						<Button variant="outline" onClick={clearFilters}>
							<Trans>Clear filters</Trans>
						</Button>
					</EmptyState>
				) : (
					<EmptyState
						title={
							<>
								<Trans>Your team starts here</Trans>
							</>
						}
						description={
							<>
								<Trans>
									Add the people who work here with their positions and scopes.
									They do not need a login to be on your team.
								</Trans>
							</>
						}
						icons={['users', 'user-plus', 'user']}
					>
						{canWrite ? (
							<>
								<Button render={<Link to={`${basePath}/new`} />}>
									<Icon name="plus" />
									<Trans>Add staff</Trans>
								</Button>
								{allScopes ? (
									<Button
										variant="outline"
										render={<Link to={`${basePath}/import`} />}
									>
										<Trans>Import current members</Trans>
									</Button>
								) : null}
							</>
						) : null}
					</EmptyState>
				)
			) : (
				<div
					className={
						list.refreshing ? 'opacity-70 transition-opacity' : undefined
					}
					aria-busy={list.refreshing}
				>
					<StaffRoster
						rows={rows}
						positions={positionMap}
						scopes={scopeMap}
						showPay={canSeePay}
						basePath={basePath}
						onboarding={showOnboarding ? onboardingSummary.byStaff : undefined}
						today={today}
					/>
					{rows.length < total || filtering ? (
						<div className="text-muted-foreground mt-3 flex items-center justify-between gap-3 text-sm">
							<span aria-live="polite">
								<Trans>
									Showing {shownCount} of {total}
								</Trans>
							</span>
							{rows.length < total && limit < MAX_LIST ? (
								<Button
									variant="outline"
									onClick={() =>
										setLimit((value) => Math.min(value + PAGE_SIZE, MAX_LIST))
									}
								>
									<Trans>Show more</Trans>
								</Button>
							) : rows.length < total ? (
								<span>
									<Trans>Search or filter to narrow the list.</Trans>
								</span>
							) : null}
						</div>
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
