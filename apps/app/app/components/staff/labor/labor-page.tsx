import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { FieldError } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { useIsNarrow } from '#app/hooks/use-container-width.ts'
import { useVisiblePolling } from '#app/hooks/use-live-clock.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { fetchExport } from '#app/utils/staffing/labor-api.ts'
import { type LaborScope } from '#app/utils/staffing/labor-context.server.ts'
import { describeLaborError } from '#app/utils/staffing/labor-errors.ts'
import {
	positionsSchema,
	salesEntriesSchema,
	settingsSchema,
	summarySchema,
	tipReportSchema,
} from '#app/utils/staffing/labor-types.ts'
import {
	LABOR_RANGE_DAYS,
	type LaborSearch,
	type LaborViewName,
	parseLaborSearch,
	rangeOf,
	shiftRange,
	writeLaborSearch,
} from '#app/utils/staffing/labor-view.ts'
import { downloadCsv } from '#app/utils/staffing/roster-export.ts'
import {
	formatPeriodLabel,
	todayIn,
} from '#app/utils/staffing/timesheet-view.ts'
import { LaborOverview } from './labor-overview.tsx'
import { LaborSales } from './labor-sales.tsx'
import { LaborSettingsForm } from './labor-settings.tsx'
import { LaborTips } from './labor-tips.tsx'
import { SalesImportDialog } from './sales-import-dialog.tsx'
import { TipSettingsDialog } from './tip-settings-dialog.tsx'

const POLL_MS = 60_000
/** Below this much room the daily table gives way to stacked rows. */
const TABLE_MIN_WIDTH = 720

type Props = {
	scopes: ReadonlyArray<
		Pick<LaborScope, 'id' | 'name' | 'timeZone' | 'currency'>
	>
	can: { editSales: boolean; editSettings: boolean; seeTips: boolean }
}

/**
 * Labor: hours, estimated wages and sales by day for one scope, the sales a
 * team enters, the tip-pool report and the settings behind them. Everything is
 * fetched from the regional node by the browser with a short-lived token; the
 * address bar holds only the view, the scope and the range.
 */
export function LaborPage({ scopes: rawScopes, can }: Props) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const direction = useDirection()
	const [params, setParams] = useSearchParams()
	const containerRef = useRef<HTMLDivElement>(null)
	const narrow = useIsNarrow(containerRef, TABLE_MIN_WIDTH)
	const { client, ready, unavailable, can: tokenCan } = useStaffClient('labor')

	const scopes = useMemo(
		() =>
			rawScopes.map((scope) => ({
				...scope,
				name: pickLocalized(scope.name, locale, 'en') || scope.name,
			})),
		[rawScopes, locale],
	)

	const firstId = scopes[0]?.id ?? ''
	const requestedScope = params.get('scope')
	const scope = scopes.find((l) => l.id === requestedScope) ?? scopes[0]
	const today = useMemo(
		() => todayIn(Date.now(), scope?.timeZone ?? 'UTC'),
		[scope?.timeZone],
	)
	const search = parseLaborSearch(params, today, firstId)
	const range = rangeOf(search.end, search.days)

	// What the member may do is what the server said and what the token carries.
	const canEditSales = can.editSales && (!ready || tokenCan(P.UPDATE_TIMESHEET))
	const canEditSettings =
		can.editSettings && (!ready || tokenCan(P.UPDATE_LABOR_POLICY))
	const canSeeTips = can.seeTips && (!ready || tokenCan(P.READ_STAFF_PAY))

	const update = useCallback(
		(patch: Partial<LaborSearch>) => {
			setParams(writeLaborSearch(params, patch, today), {
				replace: true,
				preventScrollReset: true,
			})
		},
		[params, setParams, today],
	)

	const view: LaborViewName =
		search.view === 'tips' && !canSeeTips ? 'overview' : search.view
	const scopeId = scope?.id ?? ''
	const rangeQuery = new URLSearchParams({
		scopeId,
		from: range.from,
		to: range.to,
	}).toString()
	const active = ready && scopeId !== ''

	const summary = useStaffQuery(
		client,
		active && view === 'overview' ? `/summary?${rangeQuery}` : null,
		summarySchema,
	)
	const sales = useStaffQuery(
		client,
		active && view === 'sales' ? `/sales?${rangeQuery}` : null,
		salesEntriesSchema,
	)
	const settings = useStaffQuery(
		client,
		active && (view === 'sales' || view === 'settings')
			? `/settings?scopeId=${encodeURIComponent(scopeId)}`
			: null,
		settingsSchema,
	)
	const tips = useStaffQuery(
		client,
		active && view === 'tips' ? `/tips?${rangeQuery}` : null,
		tipReportSchema,
	)
	const positionsQuery = useStaffQuery(
		client,
		active && (view === 'settings' || view === 'tips') ? '/positions' : null,
		positionsSchema,
	)
	const positions = useMemo(
		() => positionsQuery.data?.positions ?? [],
		[positionsQuery.data],
	)

	const current =
		view === 'overview'
			? summary
			: view === 'sales'
				? sales
				: view === 'tips'
					? tips
					: settings
	const reloadCurrent = current.reload
	useVisiblePolling(
		useCallback(() => {
			if (view === 'overview' || view === 'tips') reloadCurrent()
		}, [view, reloadCurrent]),
		POLL_MS,
	)

	const [importing, setImporting] = useState(false)
	const [editingTips, setEditingTips] = useState(false)
	const [exporting, setExporting] = useState(false)

	async function exportCsv() {
		if (exporting) return
		setExporting(true)
		try {
			const path =
				view === 'tips'
					? `/tips/export?${rangeQuery}`
					: `/summary/export?${rangeQuery}`
			const data = await fetchExport(client, path)
			downloadCsv(data.filename, data.csv)
			const count = data.rowCount
			toast.success(_(t`Exported ${count} rows.`))
		} catch (error) {
			toast.error(describeLaborError(error, _))
		} finally {
			setExporting(false)
		}
	}

	const viewLabels: Record<LaborViewName, string> = {
		overview: _(t`Overview`),
		sales: _(t`Sales`),
		tips: _(t`Tips`),
		settings: _(t`Settings`),
	}
	const views: LaborViewName[] = [
		'overview',
		'sales',
		...(canSeeTips ? (['tips'] as const) : []),
		'settings',
	]

	if (!scope) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title={_(t`Labor`)} />
				<EmptyState
					title={
						<>
							<Trans>No workplaces to show</Trans>
						</>
					}
					description={
						<>
							<Trans>
								Add a scope in settings, or ask an administrator for access to
								one.
							</Trans>
						</>
					}
					icons={['clock', 'users', 'calendar']}
				/>
			</div>
		)
	}

	const rangeLabel = formatPeriodLabel(range.from, range.to, locale)
	const rtl = direction === 'rtl'
	const showRange = view !== 'settings'
	const canExport = view === 'overview' || view === 'tips'

	return (
		<div ref={containerRef} className="flex flex-col gap-5">
			<PageHeader
				title={_(t`Labor`)}
				description={_(
					t`What your hours cost against your sales, the sales you enter, and how tips divide.`,
				)}
				actions={
					canExport ? (
						<Button
							variant="outline"
							disabled={exporting || !ready}
							onClick={() => void exportCsv()}
						>
							<Icon name="download" />
							<Trans>Export (CSV)</Trans>
						</Button>
					) : null
				}
			/>

			<div className="flex flex-col gap-3">
				<Tabs
					value={view}
					onValueChange={(next) => {
						const picked = next as LaborViewName
						if (views.includes(picked)) update({ view: picked })
					}}
				>
					<TabsList aria-label={_(t`Labor view`)}>
						{views.map((value) => (
							<TabsTrigger key={value} value={value}>
								{viewLabels[value]}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>

				<div className="flex flex-wrap items-center gap-2">
					{scopes.length > 1 ? (
						<FilterSelect
							label={_(t`Workplace`)}
							options={scopes.map((l) => ({ value: l.id, label: l.name }))}
							value={scopeId}
							onValueChange={(next) => update({ scopeId: next })}
						/>
					) : null}
					{showRange ? (
						<>
							<Button
								variant="outline"
								size="icon"
								aria-label={_(t`Earlier`)}
								onClick={() =>
									update({
										end: shiftRange(search.end, search.days, -1, today),
									})
								}
							>
								<Icon name={rtl ? 'chevron-right' : 'chevron-left'} />
							</Button>
							<span
								className="min-w-40 text-center text-sm font-medium tabular-nums"
								aria-live="polite"
							>
								{rangeLabel}
							</span>
							<Button
								variant="outline"
								size="icon"
								aria-label={_(t`Later`)}
								disabled={search.end >= today}
								onClick={() =>
									update({
										end: shiftRange(search.end, search.days, 1, today),
									})
								}
							>
								<Icon name={rtl ? 'chevron-left' : 'chevron-right'} />
							</Button>
							<Button
								variant="ghost"
								disabled={search.end >= today}
								onClick={() => update({ end: today })}
							>
								<Trans>Today</Trans>
							</Button>
							<FilterSelect
								label={_(t`Days shown`)}
								options={LABOR_RANGE_DAYS.map((days) => ({
									value: String(days),
									label: _(t`Last ${days} days`),
								}))}
								value={String(search.days)}
								onValueChange={(next) =>
									update({ days: Number(next) as LaborSearch['days'] })
								}
							/>
						</>
					) : null}
				</div>
			</div>

			{unavailable ? (
				<FieldError>
					<Trans>We could not confirm your access. Reload the page.</Trans>
				</FieldError>
			) : !ready || (current.loading && !current.data) ? (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading labor figures</Trans>
					</span>
					<Skeleton className="h-6 w-2/3" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : current.error && !current.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeLaborError(current.error, _)}
					</AlertDescription>
					<AlertAction>
						<Button variant="outline" onClick={current.reload}>
							<Trans>Try again</Trans>
						</Button>
					</AlertAction>
				</Alert>
			) : (
				<div
					className={current.refreshing ? 'opacity-70 transition-opacity' : ''}
					aria-busy={current.refreshing}
				>
					{view === 'overview' && summary.data ? (
						<LaborOverview
							summary={summary.data}
							locale={locale}
							layout={narrow ? 'cards' : 'table'}
							canEditSales={canEditSales}
							canEditSettings={canEditSettings}
							onEnterSales={() => update({ view: 'sales' })}
							onChangeSource={() => update({ view: 'settings' })}
						/>
					) : null}
					{view === 'sales' && sales.data && settings.data ? (
						<div className="flex flex-col gap-4">
							{settings.data.salesSource !== 'manual' ? (
								<p role="status" className="text-sm text-pretty">
									<Trans>
										Entered sales are only used when this scope's sales source
										is "Sales I enter".
									</Trans>{' '}
									{canEditSettings ? (
										<Button
											variant="link"
											className="h-auto p-0 align-baseline"
											onClick={() => update({ view: 'settings' })}
										>
											<Trans>Change the sales source</Trans>
										</Button>
									) : null}
								</p>
							) : null}
							<LaborSales
								client={client}
								scopeId={scopeId}
								currency={scope.currency}
								from={range.from}
								to={range.to}
								entries={sales.data.entries}
								canEdit={canEditSales}
								onChanged={sales.reload}
								onImport={() => setImporting(true)}
							/>
						</div>
					) : null}
					{view === 'tips' && tips.data ? (
						<LaborTips
							report={tips.data}
							locale={locale}
							canEditSettings={canEditSettings}
							onEditRules={() => setEditingTips(true)}
						/>
					) : null}
					{view === 'settings' && settings.data ? (
						<LaborSettingsForm
							// A fresh form whenever the scope or saved settings change.
							key={`${settings.data.scopeId}:${settings.data.updatedAt ?? 0}:${positions.length}`}
							client={client}
							settings={settings.data}
							positions={positions}
							canEdit={canEditSettings}
							onSaved={settings.reload}
						/>
					) : null}
				</div>
			)}

			{importing ? (
				<SalesImportDialog
					client={client}
					scopeId={scopeId}
					currency={scope.currency}
					onClose={() => setImporting(false)}
					onImported={sales.reload}
				/>
			) : null}
			{editingTips && tips.data ? (
				<TipSettingsDialog
					client={client}
					settings={tips.data.settings}
					positions={positions}
					onClose={() => setEditingTips(false)}
					onSaved={tips.reload}
				/>
			) : null}
		</div>
	)
}
