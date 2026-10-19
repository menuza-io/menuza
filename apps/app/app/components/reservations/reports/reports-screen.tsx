import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspaceToolbar } from '@repo/ui/workspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { ReportInsight } from '#app/components/reservations/reports/report-insight.tsx'
import {
	CancellationsPanel,
	NoShowsPanel,
	PacingPanel,
	SummaryPanel,
	TurnTimesPanel,
	WaitlistPanel,
} from '#app/components/reservations/reports/report-panels.tsx'
import { ReservationsHeaderActions } from '#app/components/reservations/shell-context.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { DateRangeField } from '#app/components/staff/schedule/date-range-field.tsx'
import { guestsErrorInfo } from '#app/utils/reservations/guests-errors.ts'
import {
	fetchReport,
	REPORT_KINDS,
	type ReportByKind,
	type ReportKind,
} from '#app/utils/reservations/reports-api.ts'
import {
	downloadCsv,
	reportCsv,
	reportTable,
} from '#app/utils/reservations/reports-export.ts'
import {
	addDays,
	REPORT_ERROR_MESSAGES,
	REPORT_TITLES,
} from '#app/utils/reservations/reports-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

type Loaded = {
	[K in ReportKind]: { kind: K; report: ReportByKind[K] }
}[ReportKind]
type Failure = { kind: 'denied' | 'failed' | 'range'; code: string | null }

const DEFAULT_RANGE_DAYS = 7
const PRESET_DAYS = [7, 30, 90] as const
/** `FilterSelect` cannot hold an empty value, so "all services" travels as this key. */
const ALL_SERVICES = 'all'

export function ReportsScreen({
	client,
	locationId,
	today,
}: {
	client: ReservationsScopedClient
	locationId: string
	/** Business date "now" falls on at the active location. */
	today: string
}) {
	const { _, i18n } = useLingui()
	const [kind, setKind] = useState<ReportKind>('summary')
	const [to, setTo] = useState(today)
	const [from, setFrom] = useState(addDays(today, 1 - DEFAULT_RANGE_DAYS))
	const [serviceId, setServiceId] = useState('')
	const [services, setServices] = useState<Array<{ id: string; name: string }>>(
		[],
	)
	const [loaded, setLoaded] = useState<Loaded | null>(null)
	const [failure, setFailure] = useState<Failure | null>(null)
	const [previous, setPrevious] = useState<ReportByKind['summary'] | null>(null)
	const [loading, setLoading] = useState(true)
	const requestId = useRef(0)

	useEffect(() => {
		setServiceId('')
		setServices([])
	}, [locationId])

	const run = useCallback(
		async (signal: AbortSignal) => {
			if (!locationId || !from || !to) return
			const id = ++requestId.current
			setLoading(true)
			// The period just before this one, for the insight line (summary only).
			// Started first so the report the screen shows is always the last call.
			const priorPromise: Promise<ReportByKind['summary'] | null> =
				kind === 'summary'
					? fetchReport(
							client,
							'summary',
							{ locationId, ...priorRange(from, to), serviceId },
							signal,
						).catch(() => null)
					: Promise.resolve(null)
			try {
				const report = await fetchReport(
					client,
					kind,
					{
						locationId,
						from,
						to,
						serviceId: kind === 'waitlist' ? '' : serviceId,
					},
					signal,
				)
				if (signal.aborted || id !== requestId.current) return
				setLoaded({ kind, report } as Loaded)
				void priorPromise.then((prior) => {
					if (!signal.aborted && id === requestId.current) setPrevious(prior)
				})
				setServices(report.services)
				setFailure(null)
			} catch (err) {
				if (signal.aborted || id !== requestId.current) return
				const { status, code } = guestsErrorInfo(err)
				setLoaded(null)
				setPrevious(null)
				setFailure({
					kind:
						status === 403 || status === 401
							? 'denied'
							: status === 400 && code && REPORT_ERROR_MESSAGES[code]
								? 'range'
								: 'failed',
					code,
				})
			} finally {
				if (id === requestId.current) setLoading(false)
			}
		},
		[client, kind, locationId, from, to, serviceId],
	)

	useEffect(() => {
		const controller = new AbortController()
		void run(controller.signal)
		return () => controller.abort()
	}, [run])

	const serviceOptions = [
		{ value: ALL_SERVICES, label: _(msg`All services`) },
		...services.map((service) => ({ value: service.id, label: service.name })),
	]
	const presetValue =
		PRESET_DAYS.find(
			(days) => to === today && from === addDays(today, 1 - days),
		) ?? null

	const exportCsv = () => {
		if (!loaded || loaded.kind !== kind) return
		const table = reportTable(kind, loaded.report as never)
		const ok = downloadCsv(
			`reservations-${kind}-${from}-${to}.csv`,
			reportCsv(table, _),
		)
		if (ok) toast.success(_(msg`Report exported.`))
	}

	return (
		<div className="flex flex-col gap-6" data-testid="reports-screen">
			<ReservationsHeaderActions>
				<Button
					type="button"
					variant="outline"
					disabled={loading || !loaded || loaded.kind !== kind}
					onClick={exportCsv}
					data-testid="report-export"
				>
					<Icon name="download" />
					<Trans>Export CSV</Trans>
				</Button>
			</ReservationsHeaderActions>

			<Tabs
				value={kind}
				onValueChange={(value) => setKind(value as ReportKind)}
			>
				<TabsList
					variant="line"
					className="h-auto flex-wrap"
					aria-label={_(msg`Reports`)}
					data-testid="report-tabs"
				>
					{REPORT_KINDS.map((key) => (
						<TabsTrigger
							key={key}
							value={key}
							data-testid={`report-tab-${key}`}
						>
							{_(REPORT_TITLES[key])}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<WorkspaceToolbar>
				<form
					className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center"
					onSubmit={(event) => event.preventDefault()}
					aria-label={_(msg`Report filters`)}
				>
					<ToggleGroup
						aria-label={_(msg`Date range`)}
						variant="segmented"
						value={presetValue === null ? [] : [String(presetValue)]}
						onValueChange={(next) => {
							const days = Number(next[0])
							if (!PRESET_DAYS.some((preset) => preset === days)) return
							setTo(today)
							setFrom(addDays(today, 1 - days))
						}}
					>
						{PRESET_DAYS.map((days) => (
							<ToggleGroupItem
								key={days}
								value={String(days)}
								className="h-11 md:h-7"
								data-testid={`report-range-${days}`}
							>
								{days === 7 ? (
									<Trans>7 days</Trans>
								) : days === 30 ? (
									<Trans>30 days</Trans>
								) : (
									<Trans>90 days</Trans>
								)}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					<div className="md:w-72" data-testid="report-dates">
						<DateRangeField
							label={_(msg`Dates`)}
							value={{ from, to }}
							locale={i18n.locale}
							onChange={(next) => {
								if (!next.from) return
								setFrom(next.from)
								setTo(next.to ?? next.from)
							}}
						/>
					</div>
					{kind === 'waitlist' ? null : (
						<FilterSelect
							label={_(msg`Service`)}
							options={serviceOptions}
							value={serviceId || ALL_SERVICES}
							onValueChange={(next) =>
								setServiceId(next === ALL_SERVICES ? '' : next)
							}
							testId="report-service"
						/>
					)}
				</form>
				<Button
					type="button"
					variant="ghost"
					disabled={loading}
					onClick={() => {
						const controller = new AbortController()
						void run(controller.signal)
					}}
					data-testid="report-refresh"
				>
					<Icon name="refresh-cw" />
					<Trans>Run again</Trans>
				</Button>
			</WorkspaceToolbar>

			<div
				aria-live="polite"
				aria-busy={loading}
				data-testid="report-result"
				data-report={kind}
			>
				{failure ? (
					<Alert variant="destructive" data-testid="report-error">
						<Icon name="alert-triangle" />
						<AlertDescription>
							{failure.kind === 'denied' ? (
								<Trans>You do not have access to reservation reports.</Trans>
							) : failure.kind === 'range' && failure.code ? (
								_(REPORT_ERROR_MESSAGES[failure.code]!)
							) : (
								<Trans>The report could not be loaded. Try again.</Trans>
							)}
						</AlertDescription>
					</Alert>
				) : loaded && loaded.kind === kind ? (
					<div className="flex flex-col gap-4">
						{reportIsEmpty(loaded) ? (
							<ReportEmpty
								kind={kind}
								canWiden={presetValue !== 90}
								serviceFiltered={Boolean(serviceId) && kind !== 'waitlist'}
								onWiden={() => {
									setTo(today)
									setFrom(addDays(today, 1 - 90))
								}}
								onAllServices={() => setServiceId('')}
							/>
						) : (
							<>
								<ReportInsight
									loaded={loaded}
									previous={kind === 'summary' ? previous : null}
								/>
								<ReportPanel loaded={loaded} />
							</>
						)}
					</div>
				) : (
					<div
						className="flex flex-col gap-6"
						role="status"
						data-testid="report-loading"
					>
						<span className="sr-only">
							<Trans>Loading report...</Trans>
						</span>
						<Skeleton className="h-24 w-full rounded-xl" />
						<Skeleton className="h-48 w-full rounded-xl" />
					</div>
				)}
			</div>
		</div>
	)
}

function ReportPanel({ loaded }: { loaded: Loaded }) {
	switch (loaded.kind) {
		case 'summary':
			return <SummaryPanel report={loaded.report} />
		case 'no-shows':
			return <NoShowsPanel report={loaded.report} />
		case 'cancellations':
			return <CancellationsPanel report={loaded.report} />
		case 'turn-times':
			return <TurnTimesPanel report={loaded.report} />
		case 'waitlist':
			return <WaitlistPanel report={loaded.report} />
		case 'pacing':
			return <PacingPanel report={loaded.report} />
	}
}

/** The span of days from `from` to `to`, counting both ends. */
function spanDays(from: string, to: string): number {
	const start = Date.parse(`${from}T00:00:00Z`)
	const end = Date.parse(`${to}T00:00:00Z`)
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 1
	return Math.round((end - start) / 86_400_000) + 1
}

/** The equally long period that ends the day before `from`. */
function priorRange(from: string, to: string) {
	const days = spanDays(from, to)
	return { from: addDays(from, -days), to: addDays(from, -1) }
}

function reportIsEmpty(loaded: Loaded): boolean {
	switch (loaded.kind) {
		case 'summary':
			return loaded.report.totals.parties === 0
		case 'pacing':
			return loaded.report.totals.bookings === 0
		default:
			return loaded.report.total === 0
	}
}

function ReportEmpty({
	kind,
	canWiden,
	serviceFiltered,
	onWiden,
	onAllServices,
}: {
	kind: ReportKind
	canWiden: boolean
	serviceFiltered: boolean
	onWiden: () => void
	onAllServices: () => void
}) {
	const title =
		kind === 'no-shows' ? (
			<Trans>No no-shows in this range</Trans>
		) : kind === 'cancellations' ? (
			<Trans>No cancellations in this range</Trans>
		) : kind === 'waitlist' ? (
			<Trans>No waitlist parties in this range</Trans>
		) : (
			<Trans>No bookings in this range</Trans>
		)
	return (
		<div data-testid="report-empty">
			<EmptyState
				title={title}
				description={
					<Trans>
						Pick a longer range or another service, or check back after your
						next service.
					</Trans>
				}
				icons={['calendar', 'trending-up', 'clock']}
			>
				<div className="flex flex-wrap justify-center gap-2">
					{canWiden ? (
						<Button
							type="button"
							variant="outline"
							onClick={onWiden}
							data-testid="report-empty-widen"
						>
							<Trans>Show the last 90 days</Trans>
						</Button>
					) : null}
					{serviceFiltered ? (
						<Button
							type="button"
							variant="outline"
							onClick={onAllServices}
							data-testid="report-empty-all-services"
						>
							<Trans>Show all services</Trans>
						</Button>
					) : null}
				</div>
			</EmptyState>
		</div>
	)
}
