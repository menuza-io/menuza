import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
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
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { FieldError } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
	Link,
	Outlet,
	useNavigate,
	useOutlet,
	useSearchParams,
} from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useIsNarrow } from '#app/hooks/use-container-width.ts'
import { useLiveNow, useVisiblePolling } from '#app/hooks/use-live-clock.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { downloadCsv } from '#app/utils/staffing/roster-export.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { positionsSchema } from '#app/utils/staffing/staff-types.ts'
import { reviewCard, runBatchOp } from '#app/utils/staffing/timesheet-api.ts'
import {
	describeCardCode,
	describeTimesheetError,
} from '#app/utils/staffing/timesheet-errors.ts'
import { buildExportCsv } from '#app/utils/staffing/timesheet-export.ts'
import {
	approvalPoliciesSchema,
	dayViewSchema,
	exportSchema,
	payrollSummarySchema,
	periodViewSchema,
	reviewViewSchema,
	type TimesheetCardRow,
} from '#app/utils/staffing/timesheet-types.ts'
import {
	approvalModeFor,
	cardActions,
	flattenRows,
	filterRows,
	formatHours,
	groupRows,
	isReadyToApprove,
	parseTimesheetSearch,
	serverFilters,
	sumCards,
	summarizeBatch,
	TIMESHEET_VIEWS,
	todayIn,
	writeTimesheetSearch,
	type BatchOp,
	type TimesheetSearch,
	type TimesheetViewName,
} from '#app/utils/staffing/timesheet-view.ts'
import { BulkBar, type BulkCounts, type BulkOp } from './bulk-bar.tsx'
import { PayPeriodDialog } from './pay-period-dialog.tsx'
import {
	ColumnPicker,
	PayrollSummary,
	useSummaryColumns,
} from './payroll-summary.tsx'
import { PeriodNav } from './period-nav.tsx'
import { ReasonDialog } from './reason-dialog.tsx'
import { ReviewQueue } from './review-queue.tsx'
import { TimesheetFilters } from './timesheet-filters.tsx'
import { TimesheetList } from './timesheet-table.tsx'
import {
	type TimesheetScope,
	type TimesheetsContext,
} from './timesheets-context.ts'

const POLL_MS = 60_000
/** Below this much room the table gives way to stacked cards. */
const TABLE_MIN_WIDTH = 720

type Props = {
	orgSlug: string
	scopes: ReadonlyArray<{ id: string; name: string; timeZone: string }>
	/** The manager may change organization-wide settings (the pay period). */
	canChangePayPeriod: boolean
}

type Confirm = { op: BulkOp; cards: TimesheetCardRow[] } | null

export function TimesheetsPage({
	orgSlug,
	scopes: rawScopes,
	canChangePayPeriod,
}: Props) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const direction = useDirection()
	const navigate = useNavigate()
	const outlet = useOutlet()
	const [params, setParams] = useSearchParams()
	const containerRef = useRef<HTMLDivElement>(null)
	const narrow = useIsNarrow(containerRef, TABLE_MIN_WIDTH)
	const { client, ready, unavailable, can } = useStaffClient('timeclock')
	const { client: staffClient, ready: staffReady } = useStaffClient('staff')

	const canUpdate = can(P.UPDATE_TIMESHEET)
	const canApprove = can(P.APPROVE_TIMESHEET)
	const canMoney = can(P.READ_STAFF_PAY)
	const canReadPolicy = can(P.READ_LABOR_POLICY)

	const scopes: TimesheetScope[] = useMemo(
		() =>
			rawScopes.map((scope) => ({
				...scope,
				name: pickLocalized(scope.name, locale, 'en') || scope.name,
			})),
		[rawScopes, locale],
	)
	const scopeNames = useMemo(
		() => new Map(scopes.map((scope) => [scope.id, scope.name])),
		[scopes],
	)

	// ---- Address bar ------------------------------------------------------
	const [today] = useState(() =>
		todayIn(Date.now(), scopes[0]?.timeZone ?? 'UTC'),
	)
	// The search box can hold a name, so it lives in this screen's state and
	// never in the address bar (which every app-server request would carry).
	const [searchText, setSearchText] = useState('')
	const search = { ...parseTimesheetSearch(params, today), q: searchText }
	const view = search.view
	const update = useCallback(
		(patch: Partial<TimesheetSearch>) => {
			const { q, ...rest } = patch
			if (q !== undefined) setSearchText(q.slice(0, 80))
			if (Object.keys(rest).length === 0) return
			setParams(writeTimesheetSearch(params, rest, today), {
				replace: true,
				preventScrollReset: true,
			})
		},
		[params, setParams, today],
	)
	const searchSuffix = params.toString() ? `?${params.toString()}` : ''
	const basePath = `/${orgSlug}/staff/timeclock/timesheets`

	// ---- Data ---------------------------------------------------------------
	const filters = serverFilters(search)
	const withFilters = (path: string, extra: Record<string, string>) => {
		const query = new URLSearchParams(extra)
		for (const [key, value] of filters) query.set(key, value)
		return `${path}?${query.toString()}`
	}
	const day = useStaffQuery(
		client,
		ready && view === 'day'
			? withFilters('/timesheets/day', { date: search.date })
			: null,
		dayViewSchema,
	)
	const period = useStaffQuery(
		client,
		ready && view === 'period'
			? withFilters('/timesheets/period', { date: search.date })
			: null,
		periodViewSchema,
	)
	const reviewPath = (() => {
		if (!ready) return null
		const query = new URLSearchParams()
		if (search.scopeId !== 'all') query.set('scopeId', search.scopeId)
		const suffix = query.toString()
		return `/timesheets/review${suffix ? `?${suffix}` : ''}`
	})()
	const review = useStaffQuery(client, reviewPath, reviewViewSchema)
	const summary = useStaffQuery(
		client,
		ready && view === 'summary'
			? (() => {
					const query = new URLSearchParams({ date: search.date })
					if (search.scopeId !== 'all') query.set('scopeId', search.scopeId)
					if (search.positionId !== 'all')
						query.set('positionId', search.positionId)
					return `/timesheets/summary?${query.toString()}`
				})()
			: null,
		payrollSummarySchema,
	)
	const policies = useStaffQuery(
		client,
		ready && canReadPolicy ? '/policies' : null,
		approvalPoliciesSchema,
	)
	const positionsQuery = useStaffQuery(
		staffClient,
		staffReady ? '/positions' : null,
		positionsSchema,
	)
	const positions = useMemo(
		() => positionsQuery.data?.positions ?? [],
		[positionsQuery.data],
	)

	const active =
		view === 'day'
			? day
			: view === 'period'
				? period
				: view === 'review'
					? review
					: summary
	const data =
		view === 'day' ? day.data : view === 'period' ? period.data : null
	const reloadActive = active.reload
	const reloadReview = review.reload
	const reloadAll = useCallback(() => {
		reloadActive()
		if (view !== 'review') reloadReview()
	}, [reloadActive, reloadReview, view])
	useVisiblePolling(
		useCallback(() => {
			if (!outlet) reloadActive()
		}, [outlet, reloadActive]),
		POLL_MS,
	)

	// The server's clock, as far as this tab can tell, for "has it happened yet".
	const serverNow =
		(view === 'day' ? day.data?.serverNow : undefined) ??
		(view === 'period' ? period.data?.serverNow : undefined) ??
		review.data?.serverNow ??
		summary.data?.serverNow
	const [clock, setClock] = useState<{ server: number; at: number }>()
	if (serverNow !== undefined && clock?.server !== serverNow) {
		setClock({ server: serverNow, at: Date.now() })
	}
	const offset = clock ? clock.server - clock.at : 0
	const now = useLiveNow(60_000, offset)
	const serverClock = useCallback(() => Date.now() + offset, [offset])

	// ---- Rows -----------------------------------------------------------------
	const allRows = useMemo(() => flattenRows(data?.people ?? []), [data])
	const rows = useMemo(
		() => filterRows(allRows, search.q, locale),
		[allRows, search.q, locale],
	)
	const groups = useMemo(
		() => groupRows(rows, search.group, locale),
		[rows, search.group, locale],
	)
	const totals = useMemo(() => sumCards(rows.map((row) => row.card)), [rows])
	const showMoney = canMoney && rows.some((row) => row.card.money)

	const periodInfo =
		view === 'period'
			? (period.data?.period ?? null)
			: view === 'summary'
				? (summary.data?.period ?? null)
				: null

	// ---- Approval ---------------------------------------------------------------
	const approvalMode = useCallback(
		(scopeId: string) =>
			approvalModeFor(
				policies.data
					? {
							default: policies.data.default,
							scopes: policies.data.scopes,
						}
					: null,
				scopeId,
			),
		[policies.data],
	)
	const can2 = useMemo(
		() => ({ approve: canApprove, update: canUpdate }),
		[canApprove, canUpdate],
	)
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
	const byId = useMemo(
		() => new Map(rows.map((row) => [row.card.id, row.card])),
		[rows],
	)
	const picked = useMemo(
		() =>
			[...selected]
				.map((id) => byId.get(id))
				.filter((card): card is TimesheetCardRow => card !== undefined),
		[selected, byId],
	)
	const counts: BulkCounts = useMemo(() => {
		const out: BulkCounts = {
			approve: 0,
			lock: 0,
			unlock: 0,
			reopen: 0,
			review: 0,
		}
		for (const card of picked) {
			const actions = cardActions(card, approvalMode(card.scopeId), can2)
			if (actions.approve) out.approve += 1
			if (actions.lock) out.lock += 1
			if (actions.unlock) out.unlock += 1
			if (actions.reopen) out.reopen += 1
			if (actions.review) out.review += 1
		}
		return out
	}, [picked, approvalMode, can2])
	const readyCards = useMemo(
		() =>
			rows
				.map((row) => row.card)
				.filter(
					(card) =>
						isReadyToApprove(card) &&
						cardActions(card, approvalMode(card.scopeId), can2).approve,
				),
		[rows, approvalMode, can2],
	)
	const lockable = useMemo(
		() =>
			rows
				.map((row) => row.card)
				.filter(
					(card) => cardActions(card, approvalMode(card.scopeId), can2).lock,
				),
		[rows, approvalMode, can2],
	)
	const selectable = canApprove || canUpdate

	const [confirm, setConfirm] = useState<Confirm>(null)
	const [busy, setBusy] = useState(false)
	const [bulkError, setBulkError] = useState<string | null>(null)

	const toggle = useCallback((id: string) => {
		setSelected((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}, [])
	const toggleGroup = useCallback((ids: readonly string[], on: boolean) => {
		setSelected((current) => {
			const next = new Set(current)
			for (const id of ids) {
				if (on) next.add(id)
				else next.delete(id)
			}
			return next
		})
	}, [])

	function cardsFor(op: BulkOp): TimesheetCardRow[] {
		return picked.filter((card) => {
			const actions = cardActions(card, approvalMode(card.scopeId), can2)
			return actions[op]
		})
	}

	function startBulk(op: BulkOp, cards: TimesheetCardRow[]) {
		if (cards.length === 0) return
		setBulkError(null)
		// Marking as reviewed changes no times and takes no reason: just do it.
		if (op === 'review') void execute(op, cards)
		else setConfirm({ op, cards })
	}

	/** Runs `op` over `cards`. True when the request went through (cards may still be skipped). */
	async function execute(
		op: BulkOp,
		cards: TimesheetCardRow[],
		reason?: string,
	): Promise<boolean> {
		setBusy(true)
		setBulkError(null)
		try {
			if (op === 'review') {
				let done = 0
				let failed = 0
				for (const card of cards) {
					try {
						await reviewCard(client, card.id, { expectedVersion: card.version })
						done += 1
					} catch {
						failed += 1
					}
				}
				if (done > 0) {
					toast.success(
						plural(done, {
							one: '# card marked as reviewed',
							other: '# cards marked as reviewed',
						}),
					)
				}
				if (failed > 0) {
					toast.warning(
						plural(failed, {
							one: '# card changed while you were looking. Reloaded.',
							other: '# cards changed while you were looking. Reloaded.',
						}),
					)
				}
			} else {
				const answer = await runBatchOp(
					client,
					op as BatchOp,
					cards.map((card) => ({ id: card.id, version: card.version })),
					reason,
				)
				const result = summarizeBatch(answer.results)
				if (result.done > 0) {
					toast.success(
						op === 'approve'
							? plural(result.done, {
									one: '# card approved',
									other: '# cards approved',
								})
							: op === 'lock'
								? plural(result.done, {
										one: '# card locked',
										other: '# cards locked',
									})
								: op === 'unlock'
									? plural(result.done, {
											one: '# card unlocked',
											other: '# cards unlocked',
										})
									: plural(result.done, {
											one: '# card reopened',
											other: '# cards reopened',
										}),
					)
				}
				if (result.skipped > 0) {
					const [topCode] =
						Object.entries(result.codes).sort(([, a], [, b]) => b - a)[0] ?? []
					toast.warning(
						`${plural(result.skipped, {
							one: '# card was skipped.',
							other: '# cards were skipped.',
						})} ${describeCardCode(topCode, _)}`,
					)
				}
			}
			setSelected(new Set())
			reloadAll()
			return true
		} catch (error) {
			setBulkError(describeTimesheetError(error, _))
			reloadAll()
			return false
		} finally {
			setBusy(false)
		}
	}

	// ---- Export ---------------------------------------------------------------
	const columns = useSummaryColumns(canMoney)
	const [exporting, setExporting] = useState(false)
	async function exportCsv(kind: 'cards' | 'summary') {
		if (exporting) return
		setExporting(true)
		try {
			const query = new URLSearchParams({ kind })
			if (periodInfo) query.set('periodStart', periodInfo.start)
			else query.set('date', search.date)
			if (search.scopeId !== 'all') query.set('scopeId', search.scopeId)
			if (search.positionId !== 'all')
				query.set('positionId', search.positionId)
			const data = exportSchema.parse(
				await client.request(`/timesheets/export?${query.toString()}`),
			)
			const built = buildExportCsv(data, {
				scopeNames,
				keepHeaders:
					kind === 'summary' ? columns.active.map((c) => c.header) : null,
				fallbackName: `time-${kind}-${search.date}.csv`,
			})
			downloadCsv(built.filename, built.csv)
			const count = built.rowCount
			toast.success(_(t`Exported ${count} rows.`))
		} catch (error) {
			toast.error(describeTimesheetError(error, _))
		} finally {
			setExporting(false)
		}
	}

	// ---- Outlet context for the card sheets ---------------------------------------
	const defaultDate = search.date > today ? today : search.date
	const outletContext: TimesheetsContext = {
		orgSlug,
		basePath,
		search: searchSuffix,
		scopes,
		positions,
		can: { update: canUpdate, approve: canApprove, money: canMoney },
		approvalMode,
		defaultScopeId:
			search.scopeId !== 'all' ? search.scopeId : (scopes[0]?.id ?? ''),
		defaultDate,
		now: serverClock,
		reload: reloadAll,
		close: () => void navigate(`${basePath}${searchSuffix}`),
	}
	const cardHref = (id: string) => `${basePath}/${id}${searchSuffix}`

	// ---- Rendering -------------------------------------------------------------
	const [payPeriodOpen, setPayPeriodOpen] = useState(false)
	const reviewCount = review.data?.totals.cards ?? null
	const viewLabels: Record<TimesheetViewName, string> = {
		day: _(t`Day`),
		period: _(t`Pay period`),
		review: _(t`Needs review`),
		summary: _(t`Summary`),
	}
	const scopeOptions = scopes.map((scope) => ({
		value: scope.id,
		label: scope.name,
	}))
	const positionOptions = positions
		.filter((position) => !position.archivedAt)
		.map((position) => ({
			value: position.id,
			label:
				locale.startsWith('ar') && position.nameAr
					? position.nameAr
					: position.name,
		}))
	const layout = narrow ? 'cards' : 'table'
	const filtering =
		search.q !== '' ||
		search.scopeId !== 'all' ||
		search.positionId !== 'all' ||
		search.status !== 'all'

	function clearFilters() {
		update({
			q: '',
			scopeId: 'all',
			positionId: 'all',
			status: 'all',
		})
	}

	const listView = view === 'day' || view === 'period'
	const paidHours = formatHours(totals.paidMinutes, locale)
	const overtimeHours = formatHours(totals.overtimeMinutes, locale)
	const labor =
		data?.labor && Object.keys(data.labor.payMinorByCurrency).length > 0
			? Object.entries(data.labor.payMinorByCurrency)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([currency, minor]) => formatMoneyMinor(minor, currency, locale))
					.join(' + ')
			: null

	return (
		<div ref={containerRef} className="flex flex-col gap-5">
			<h2 className="sr-only">
				<Trans>Timesheets</Trans>
			</h2>

			<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
				<ToggleGroup
					aria-label={_(t`Timesheet view`)}
					value={[view]}
					onValueChange={(next) => {
						const picked = next[0] as TimesheetViewName | undefined
						if (picked && TIMESHEET_VIEWS.includes(picked)) {
							setSelected(new Set())
							update({ view: picked })
						}
					}}
					variant="outline"
					spacing={1}
					className="flex-wrap"
				>
					{TIMESHEET_VIEWS.map((value) => (
						<ToggleGroupItem className="h-11" key={value} value={value}>
							{viewLabels[value]}
							{value === 'review' && reviewCount ? (
								<Badge
									variant="destructive"
									className="h-5 px-1.5 text-xs tabular-nums"
								>
									{reviewCount}
								</Badge>
							) : null}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				<div className="flex flex-wrap items-center gap-2">
					{canUpdate ? (
						<Button render={<Link to={`${basePath}/new${searchSuffix}`} />}>
							<Icon name="plus" />
							<Trans>Add time card</Trans>
						</Button>
					) : null}
					{view === 'period' || view === 'summary' ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button variant="outline" disabled={exporting}>
										<Icon name="download" />
										<Trans>Export</Trans>
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => void exportCsv('cards')}>
									<Trans>Time cards (CSV)</Trans>
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => void exportCsv('summary')}>
									<Trans>Payroll summary (CSV)</Trans>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					{view === 'summary' ? <ColumnPicker columns={columns} /> : null}
				</div>
			</div>

			<div className="flex flex-col gap-3">
				{view !== 'review' ? (
					<PeriodNav
						kind={view === 'day' ? 'day' : 'period'}
						date={search.date}
						period={periodInfo}
						today={today}
						locale={locale}
						onChange={(date) => {
							setSelected(new Set())
							update({ date })
						}}
						onSettings={
							canChangePayPeriod ? () => setPayPeriodOpen(true) : undefined
						}
					/>
				) : null}
				<TimesheetFilters
					search={search}
					onChange={update}
					scopes={scopeOptions}
					positions={positionOptions}
					view={view}
				/>
			</div>

			{unavailable ? (
				<FieldError>
					<Trans>We could not confirm your access. Reload the page.</Trans>
				</FieldError>
			) : !ready || (active.loading && !active.data) ? (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading time cards</Trans>
					</span>
					<Skeleton className="h-8 w-2/3" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
				</div>
			) : active.error && !active.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeTimesheetError(active.error, _)}
					</AlertDescription>
					<AlertAction>
						<Button variant="outline" onClick={active.reload}>
							<Trans>Try again</Trans>
						</Button>
					</AlertAction>
				</Alert>
			) : view === 'review' && review.data ? (
				<ReviewQueue
					data={review.data}
					client={client}
					locale={locale}
					scopeNames={scopeNames}
					showScope={scopes.length > 1}
					canUpdate={canUpdate}
					cardHref={cardHref}
					onChanged={reloadAll}
					now={now}
				/>
			) : view === 'summary' && summary.data ? (
				<PayrollSummary
					data={summary.data}
					columns={columns}
					locale={locale}
					layout={layout}
					onReviewQueue={() => update({ view: 'review' })}
				/>
			) : listView && data ? (
				<div
					className={active.refreshing ? 'opacity-70 transition-opacity' : ''}
					aria-busy={active.refreshing}
				>
					<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
						<p className="text-sm" aria-live="polite">
							{plural(totals.cards, {
								one: '# card',
								other: '# cards',
							})}
							{' · '}
							<Trans>{paidHours} paid hours</Trans>
							{totals.overtimeMinutes > 0 ? (
								<>
									{' · '}
									<Trans>{overtimeHours} overtime (estimate)</Trans>
								</>
							) : null}
							{labor ? (
								<>
									{' · '}
									<Trans>Est. labor {labor}</Trans>
								</>
							) : null}
						</p>
						{totals.needsReview > 0 ? (
							<Button
								variant="link"
								className="h-auto p-0 text-sm"
								onClick={() => update({ view: 'review' })}
							>
								{plural(totals.needsReview, {
									one: '# needs review',
									other: '# need review',
								})}
							</Button>
						) : null}
						{canApprove && readyCards.length > 0 ? (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => startBulk('approve', readyCards)}
							>
								<Icon name="circle-check" />
								{plural(readyCards.length, {
									one: 'Approve # ready card',
									other: 'Approve # ready cards',
								})}
							</Button>
						) : null}
						{canApprove && lockable.length > 0 ? (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => startBulk('lock', lockable)}
							>
								<Icon name="lock" />
								{plural(lockable.length, {
									one: 'Lock # approved card',
									other: 'Lock # approved cards',
								})}
							</Button>
						) : null}
					</div>
					{data.truncated ? (
						<p role="status" className="text-muted-foreground mb-3 text-sm">
							<Trans>
								This range has more cards than we can show. Narrow it with the
								filters or pick a shorter range.
							</Trans>
						</p>
					) : null}
					{rows.length === 0 ? (
						filtering ? (
							<EmptyState
								title={
									<>
										<Trans>No time cards match</Trans>
									</>
								}
								description={
									<>
										<Trans>Try a different search or clear the filters.</Trans>
									</>
								}
								icons={['search', 'clock', 'list-filter-plus']}
							>
								<Button variant="outline" onClick={clearFilters}>
									<Trans>Clear filters</Trans>
								</Button>
							</EmptyState>
						) : (
							<EmptyState
								title={
									<>
										{view === 'day' ? (
											<Trans>No time cards this day</Trans>
										) : (
											<Trans>No time cards in this pay period</Trans>
										)}
									</>
								}
								description={
									<>
										<Trans>
											Cards appear here when people clock in on a tablet. You
											can also add one for a shift nobody punched.
										</Trans>
									</>
								}
								icons={['clock', 'users', 'calendar']}
							>
								{canUpdate ? (
									<>
										<Button
											render={<Link to={`${basePath}/new${searchSuffix}`} />}
										>
											<Icon name="plus" />
											<Trans>Add time card</Trans>
										</Button>
									</>
								) : null}
							</EmptyState>
						)
					) : (
						<TimesheetList
							groups={groups}
							by={search.group}
							locale={locale}
							scopeNames={scopeNames}
							showScope={scopes.length > 1}
							showMoney={showMoney}
							selectable={selectable}
							selected={selected}
							onToggle={toggle}
							onToggleGroup={toggleGroup}
							cardHref={cardHref}
							totals={totals}
							layout={layout}
						/>
					)}
					<p className="text-muted-foreground mt-3 text-xs">
						{showMoney ? (
							<Trans>
								Overtime and pay are estimates from your labor rules and each
								card's rate. They are not payroll.
							</Trans>
						) : (
							<Trans>Overtime is an estimate from your labor rules.</Trans>
						)}
					</p>
				</div>
			) : null}

			{bulkError && !confirm ? <FieldError>{bulkError}</FieldError> : null}

			<BulkBar
				selectedCount={picked.length}
				counts={counts}
				busy={busy}
				onClear={() => setSelected(new Set())}
				onAction={(op) => startBulk(op, cardsFor(op))}
			/>

			<Sheet
				open={outlet !== null}
				onOpenChange={(open) => {
					if (!open) outletContext.close()
				}}
			>
				<SheetContent
					side={direction === 'rtl' ? 'left' : 'right'}
					className="flex w-full flex-col gap-0 data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl"
				>
					<Outlet context={outletContext} />
				</SheetContent>
			</Sheet>

			{confirm && (confirm.op === 'approve' || confirm.op === 'lock') ? (
				<AlertDialog
					open
					onOpenChange={(open) => {
						if (!open && !busy) setConfirm(null)
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{confirm.op === 'approve'
									? plural(confirm.cards.length, {
											one: 'Approve # card?',
											other: 'Approve # cards?',
										})
									: plural(confirm.cards.length, {
											one: 'Lock # card?',
											other: 'Lock # cards?',
										})}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{confirm.op === 'approve' ? (
									<Trans>
										Their hours are frozen as shown. You can reopen a card later
										if something is wrong, and the reason is logged.
									</Trans>
								) : (
									<Trans>
										Locked cards cannot be edited by anyone until they are
										unlocked, and the unlock is logged.
									</Trans>
								)}
							</AlertDialogDescription>
						</AlertDialogHeader>
						{bulkError ? <FieldError>{bulkError}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>
								<Trans>Not yet</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								disabled={busy}
								onClick={(event) => {
									event.preventDefault()
									void execute(confirm.op, confirm.cards).then(
										(ok) => ok && setConfirm(null),
									)
								}}
							>
								{busy ? (
									<Trans>Working…</Trans>
								) : confirm.op === 'approve' ? (
									<Trans>Approve</Trans>
								) : (
									<Trans>Lock</Trans>
								)}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
			{confirm && (confirm.op === 'unlock' || confirm.op === 'reopen') ? (
				<ReasonDialog
					title={
						confirm.op === 'unlock'
							? plural(confirm.cards.length, {
									one: 'Unlock # card?',
									other: 'Unlock # cards?',
								})
							: plural(confirm.cards.length, {
									one: 'Reopen # card?',
									other: 'Reopen # cards?',
								})
					}
					description={
						confirm.op === 'unlock' ? (
							<Trans>
								They go back to approved. The unlock is logged on each card.
							</Trans>
						) : (
							<Trans>
								They go back to review so they can be edited, and have to be
								approved again. The change is logged on each card.
							</Trans>
						)
					}
					confirmLabel={
						confirm.op === 'unlock' ? (
							<Trans>Unlock</Trans>
						) : (
							<Trans>Reopen</Trans>
						)
					}
					pendingLabel={<Trans>Working…</Trans>}
					pending={busy}
					error={bulkError}
					onConfirm={(reason) => execute(confirm.op, confirm.cards, reason)}
					onClose={() => setConfirm(null)}
				/>
			) : null}

			{payPeriodOpen ? (
				<PayPeriodDialog
					client={client}
					onClose={() => setPayPeriodOpen(false)}
					onSaved={reloadAll}
				/>
			) : null}
		</div>
	)
}
