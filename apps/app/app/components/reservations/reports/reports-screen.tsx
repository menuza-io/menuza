import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	CancellationsPanel,
	NoShowsPanel,
	PacingPanel,
	SummaryPanel,
	TurnTimesPanel,
	WaitlistPanel,
} from '#app/components/reservations/reports/report-panels.tsx'
import { guestsErrorInfo } from '#app/utils/reservations/guests-errors.ts'
import {
	fetchReport,
	REPORT_KINDS,
	type ReportByKind,
	type ReportKind,
} from '#app/utils/reservations/reports-api.ts'
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
	const { _ } = useLingui()
	const [kind, setKind] = useState<ReportKind>('summary')
	const [to, setTo] = useState(today)
	const [from, setFrom] = useState(addDays(today, 1 - DEFAULT_RANGE_DAYS))
	const [serviceId, setServiceId] = useState('')
	const [services, setServices] = useState<Array<{ id: string; name: string }>>(
		[],
	)
	const [loaded, setLoaded] = useState<Loaded | null>(null)
	const [failure, setFailure] = useState<Failure | null>(null)
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
				setServices(report.services)
				setFailure(null)
			} catch (err) {
				if (signal.aborted || id !== requestId.current) return
				const { status, code } = guestsErrorInfo(err)
				setLoaded(null)
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

	return (
		<div className="flex flex-col gap-4" data-testid="reports-screen">
			<PageHeader
				title={<Trans>Reports</Trans>}
				description={
					<Trans>
						Covers, no-shows, cancellations, turn times, waitlist, and pacing
						for one location. Reports carry no guest contact details.
					</Trans>
				}
			/>

			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => event.preventDefault()}
				aria-label={_(msg`Report filters`)}
			>
				<div className="flex flex-col gap-1">
					<Label htmlFor="report-from" className="text-xs">
						<Trans>From</Trans>
					</Label>
					<Input
						id="report-from"
						type="date"
						value={from}
						max={to || undefined}
						onChange={(event) => setFrom(event.target.value)}
						data-testid="report-from"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="report-to" className="text-xs">
						<Trans>To</Trans>
					</Label>
					<Input
						id="report-to"
						type="date"
						value={to}
						min={from || undefined}
						onChange={(event) => setTo(event.target.value)}
						data-testid="report-to"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="report-service" className="text-xs">
						<Trans>Service</Trans>
					</Label>
					<select
						id="report-service"
						value={serviceId}
						onChange={(event) => setServiceId(event.target.value)}
						disabled={kind === 'waitlist'}
						className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
						data-testid="report-service"
					>
						<option value="">{_(msg`All services`)}</option>
						{services.map((service) => (
							<option key={service.id} value={service.id}>
								{service.name}
							</option>
						))}
					</select>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
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
			</form>

			<Tabs
				value={kind}
				onValueChange={(value) => setKind(value as ReportKind)}
			>
				<TabsList
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
					<ReportPanel loaded={loaded} />
				) : (
					<p
						className="text-muted-foreground text-sm"
						role="status"
						data-testid="report-loading"
					>
						<Trans>Loading report...</Trans>
					</p>
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
