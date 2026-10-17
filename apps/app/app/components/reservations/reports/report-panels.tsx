import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Frame } from '@repo/ui/frame'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { type ReactNode } from 'react'
import {
	formatBusinessDate,
	formatInstantDate,
	formatLocalMinutes,
} from '#app/utils/reservations/guests-view.ts'
import {
	CHANNEL_LABELS,
	enumLabel,
	RESERVATION_STATUS_LABELS,
} from '#app/utils/reservations/labels.ts'
import {
	type CancellationsReport,
	type NoShowsReport,
	type PacingReport,
	type SummaryReport,
	type TurnTimesReport,
	type WaitlistReport,
} from '#app/utils/reservations/reports-api.ts'
import {
	CANCELLED_BY_LABELS,
	formatMinutes,
	formatPercent,
	OUTCOME_LABELS,
} from '#app/utils/reservations/reports-view.ts'

function Stat({
	label,
	value,
	testId,
}: {
	label: ReactNode
	value: ReactNode
	testId: string
}) {
	return (
		<div className="bg-card flex flex-col gap-1 rounded-xl border p-4">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="text-2xl font-semibold tabular-nums" data-testid={testId}>
				<bdi>{value}</bdi>
			</dd>
		</div>
	)
}

function Stats({ children }: { children: ReactNode }) {
	return <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</dl>
}

function Section({
	title,
	children,
	testId,
}: {
	title: ReactNode
	children: ReactNode
	testId: string
}) {
	return (
		<section className="flex flex-col gap-2" data-testid={testId}>
			<h3 className="text-sm font-semibold">{title}</h3>
			{children}
		</section>
	)
}

function DataTable({
	head,
	rows,
	empty,
}: {
	head: ReactNode[]
	rows: Array<{ key: string; cells: ReactNode[] }>
	empty?: ReactNode
}) {
	if (rows.length === 0 && empty) {
		return <p className="text-muted-foreground text-sm">{empty}</p>
	}
	return (
		<Frame>
			<Table variant="card">
				<TableHeader>
					<TableRow>
						{head.map((cell, index) => (
							<TableHead
								key={index}
								className={index === 0 ? undefined : 'text-end'}
							>
								{cell}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.key}>
							{row.cells.map((cell, index) => (
								<TableCell
									key={index}
									className={index === 0 ? undefined : 'text-end tabular-nums'}
								>
									{cell}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Frame>
	)
}

const dash = '—'

function useFormat() {
	const { _, i18n } = useLingui()
	return {
		_,
		locale: i18n.locale,
		date: (value: string) => formatBusinessDate(value, i18n.locale),
		time: (value: string) => <bdi dir="ltr">{value}</bdi>,
		minutes: (value: number | null) =>
			formatMinutes(value, i18n.locale) ?? dash,
	}
}

export function SummaryPanel({ report }: { report: SummaryReport }) {
	const f = useFormat()
	return (
		<div className="flex flex-col gap-5" data-testid="report-summary">
			<Stats>
				<Stat
					label={<Trans>Parties</Trans>}
					value={report.totals.parties}
					testId="report-total-parties"
				/>
				<Stat
					label={<Trans>Covers</Trans>}
					value={report.totals.covers}
					testId="report-total-covers"
				/>
			</Stats>
			<Section title={<Trans>By service</Trans>} testId="report-by-service">
				<DataTable
					head={[
						<Trans key="s">Service</Trans>,
						<Trans key="p">Parties</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byService.map((row) => ({
						key: row.serviceId ?? 'none',
						cells: [
							row.name ?? <Trans>No service</Trans>,
							row.parties,
							row.covers,
						],
					}))}
					empty={<Trans>No bookings in this range.</Trans>}
				/>
			</Section>
			<Section title={<Trans>By source</Trans>} testId="report-by-source">
				<DataTable
					head={[
						<Trans key="s">Source</Trans>,
						<Trans key="p">Parties</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.bySource.map((row) => ({
						key: row.channel,
						cells: [
							enumLabel(f._, CHANNEL_LABELS, row.channel),
							row.parties,
							row.covers,
						],
					}))}
					empty={<Trans>No bookings in this range.</Trans>}
				/>
			</Section>
			<Section
				title={<Trans>By party size</Trans>}
				testId="report-by-party-size"
			>
				<DataTable
					head={[
						<Trans key="s">Party size</Trans>,
						<Trans key="p">Parties</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byPartySize.map((row) => ({
						key: String(row.partySize),
						cells: [row.partySize, row.parties, row.covers],
					}))}
					empty={<Trans>No bookings in this range.</Trans>}
				/>
			</Section>
			<Section title={<Trans>By status</Trans>} testId="report-by-status">
				<DataTable
					head={[
						<Trans key="s">Status</Trans>,
						<Trans key="p">Parties</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byStatus.map((row) => ({
						key: row.status,
						cells: [
							enumLabel(f._, RESERVATION_STATUS_LABELS, row.status),
							row.parties,
							row.covers,
						],
					}))}
					empty={<Trans>No bookings in this range.</Trans>}
				/>
			</Section>
		</div>
	)
}

export function NoShowsPanel({ report }: { report: NoShowsReport }) {
	const f = useFormat()
	return (
		<div className="flex flex-col gap-5" data-testid="report-no-shows">
			<Stats>
				<Stat
					label={<Trans>No-shows</Trans>}
					value={report.total}
					testId="report-total"
				/>
				<Stat
					label={<Trans>Covers lost</Trans>}
					value={report.covers}
					testId="report-covers"
				/>
				<Stat
					label={<Trans>No-show rate</Trans>}
					value={formatPercent(report.rate, f.locale)}
					testId="report-rate"
				/>
			</Stats>
			<Section title={<Trans>By service</Trans>} testId="report-by-service">
				<DataTable
					head={[
						<Trans key="s">Service</Trans>,
						<Trans key="p">No-shows</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byService.map((row) => ({
						key: row.serviceId ?? 'none',
						cells: [
							row.name ?? <Trans>No service</Trans>,
							row.parties,
							row.covers,
						],
					}))}
					empty={<Trans>No no-shows in this range.</Trans>}
				/>
			</Section>
			<Section
				title={<Trans>By party size</Trans>}
				testId="report-by-party-size"
			>
				<DataTable
					head={[
						<Trans key="s">Party size</Trans>,
						<Trans key="p">No-shows</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byPartySize.map((row) => ({
						key: String(row.partySize),
						cells: [row.partySize, row.parties, row.covers],
					}))}
					empty={<Trans>No no-shows in this range.</Trans>}
				/>
			</Section>
			<Section title={<Trans>Bookings</Trans>} testId="report-rows">
				<DataTable
					head={[
						<Trans key="d">Date</Trans>,
						<Trans key="t">Time</Trans>,
						<Trans key="s">Service</Trans>,
						<Trans key="p">Party</Trans>,
						<Trans key="c">Source</Trans>,
					]}
					rows={report.rows.map((row) => ({
						key: row.reservationId,
						cells: [
							f.date(row.businessDate),
							f.time(row.time),
							row.service ?? dash,
							row.partySize,
							enumLabel(f._, CHANNEL_LABELS, row.channel),
						],
					}))}
					empty={<Trans>No no-shows in this range.</Trans>}
				/>
			</Section>
		</div>
	)
}

export function CancellationsPanel({
	report,
}: {
	report: CancellationsReport
}) {
	const f = useFormat()
	return (
		<div className="flex flex-col gap-5" data-testid="report-cancellations">
			<Stats>
				<Stat
					label={<Trans>Cancellations</Trans>}
					value={report.total}
					testId="report-total"
				/>
				<Stat
					label={<Trans>Late cancellations</Trans>}
					value={report.late}
					testId="report-late"
				/>
				<Stat
					label={<Trans>On time</Trans>}
					value={report.regular}
					testId="report-regular"
				/>
				<Stat
					label={<Trans>Covers</Trans>}
					value={report.covers}
					testId="report-covers"
				/>
			</Stats>
			<Section
				title={<Trans>Cancelled by</Trans>}
				testId="report-by-cancelled-by"
			>
				<DataTable
					head={[
						<Trans key="s">Cancelled by</Trans>,
						<Trans key="p">Parties</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byCancelledBy.map((row) => ({
						key: row.cancelledBy,
						cells: [
							enumLabel(f._, CANCELLED_BY_LABELS, row.cancelledBy),
							row.parties,
							row.covers,
						],
					}))}
					empty={<Trans>No cancellations in this range.</Trans>}
				/>
			</Section>
			<Section title={<Trans>Bookings</Trans>} testId="report-rows">
				<DataTable
					head={[
						<Trans key="d">Date</Trans>,
						<Trans key="t">Time</Trans>,
						<Trans key="s">Service</Trans>,
						<Trans key="p">Party</Trans>,
						<Trans key="b">Cancelled by</Trans>,
						<Trans key="l">Timing</Trans>,
					]}
					rows={report.rows.map((row) => ({
						key: row.reservationId,
						cells: [
							f.date(row.businessDate),
							f.time(row.time),
							row.service ?? dash,
							row.partySize,
							enumLabel(f._, CANCELLED_BY_LABELS, row.cancelledBy ?? 'unknown'),
							row.late ? (
								<Badge variant="warning">
									<Trans>Late</Trans>
								</Badge>
							) : (
								<Trans>On time</Trans>
							),
						],
					}))}
					empty={<Trans>No cancellations in this range.</Trans>}
				/>
			</Section>
		</div>
	)
}

export function TurnTimesPanel({ report }: { report: TurnTimesReport }) {
	const f = useFormat()
	return (
		<div className="flex flex-col gap-5" data-testid="report-turn-times">
			<Stats>
				<Stat
					label={<Trans>Finished parties</Trans>}
					value={report.total}
					testId="report-total"
				/>
				<Stat
					label={<Trans>Average turn (min)</Trans>}
					value={f.minutes(report.actualAvgMin)}
					testId="report-actual-avg"
				/>
			</Stats>
			<Section
				title={<Trans>Actual versus configured, by party size</Trans>}
				testId="report-by-party-size"
			>
				<DataTable
					head={[
						<Trans key="s">Party size</Trans>,
						<Trans key="n">Parties</Trans>,
						<Trans key="a">Actual (min)</Trans>,
						<Trans key="c">Configured (min)</Trans>,
						<Trans key="b">Booked (min)</Trans>,
						<Trans key="v">Difference (min)</Trans>,
					]}
					rows={report.byPartySize.map((row) => ({
						key: String(row.partySize),
						cells: [
							row.partySize,
							row.count,
							f.minutes(row.actualAvgMin),
							f.minutes(row.configuredMin),
							f.minutes(row.bookedAvgMin),
							f.minutes(row.varianceMin),
						],
					}))}
					empty={<Trans>No finished parties in this range.</Trans>}
				/>
			</Section>
			<Section
				title={<Trans>Configured turn times</Trans>}
				testId="report-configured"
			>
				<DataTable
					head={[
						<Trans key="s">Party size</Trans>,
						<Trans key="m">Minutes</Trans>,
					]}
					rows={report.configured.map((rule, index) => ({
						key: `${rule.serviceId ?? 'all'}-${rule.partyMin}-${index}`,
						cells: [
							`${rule.partyMin}–${rule.partyMax}`,
							f.minutes(rule.minutes),
						],
					}))}
					empty={<Trans>No turn times are configured.</Trans>}
				/>
			</Section>
		</div>
	)
}

export function WaitlistPanel({ report }: { report: WaitlistReport }) {
	const f = useFormat()
	return (
		<div className="flex flex-col gap-5" data-testid="report-waitlist">
			<Stats>
				<Stat
					label={<Trans>Waitlist entries</Trans>}
					value={report.total}
					testId="report-total"
				/>
				<Stat
					label={<Trans>Average quoted wait (min)</Trans>}
					value={f.minutes(report.quotedAvgMin)}
					testId="report-quoted-avg"
				/>
				<Stat
					label={<Trans>Average actual wait (min)</Trans>}
					value={f.minutes(report.actualAvgMin)}
					testId="report-actual-avg"
				/>
			</Stats>
			<Section title={<Trans>Outcomes</Trans>} testId="report-by-outcome">
				<DataTable
					head={[
						<Trans key="o">Outcome</Trans>,
						<Trans key="p">Entries</Trans>,
						<Trans key="c">Covers</Trans>,
					]}
					rows={report.byOutcome.map((row) => ({
						key: row.outcome,
						cells: [
							enumLabel(f._, OUTCOME_LABELS, row.outcome),
							row.parties,
							row.covers,
						],
					}))}
					empty={<Trans>No waitlist entries in this range.</Trans>}
				/>
			</Section>
			<Section title={<Trans>Entries</Trans>} testId="report-rows">
				<DataTable
					head={[
						<Trans key="d">Date</Trans>,
						<Trans key="j">Joined</Trans>,
						<Trans key="p">Party</Trans>,
						<Trans key="o">Outcome</Trans>,
						<Trans key="q">Quoted (min)</Trans>,
						<Trans key="a">Actual (min)</Trans>,
					]}
					rows={report.rows.map((row) => ({
						key: row.entryId,
						cells: [
							f.date(row.businessDate),
							formatInstantDate(row.joinedAt, f.locale) ?? dash,
							row.partySize,
							enumLabel(f._, OUTCOME_LABELS, row.outcome),
							f.minutes(row.quotedMin),
							f.minutes(row.actualMin),
						],
					}))}
					empty={<Trans>No waitlist entries in this range.</Trans>}
				/>
			</Section>
		</div>
	)
}

export function PacingPanel({ report }: { report: PacingReport }) {
	const f = useFormat()
	return (
		<div className="flex flex-col gap-5" data-testid="report-pacing">
			<Stats>
				<Stat
					label={<Trans>Bookings</Trans>}
					value={report.totals.bookings}
					testId="report-total-bookings"
				/>
				<Stat
					label={<Trans>Covers</Trans>}
					value={report.totals.covers}
					testId="report-total-covers"
				/>
			</Stats>
			<Section
				title={<Trans>Bookings by time slot</Trans>}
				testId="report-slots"
			>
				<DataTable
					head={[
						<Trans key="d">Date</Trans>,
						<Trans key="t">Time</Trans>,
						<Trans key="s">Service</Trans>,
						<Trans key="b">Bookings</Trans>,
						<Trans key="c">Covers</Trans>,
						<Trans key="l">Limit</Trans>,
					]}
					rows={report.slots.map((slot) => ({
						key: `${slot.businessDate}-${slot.time}-${slot.service ?? ''}`,
						cells: [
							f.date(slot.businessDate),
							f.time(slot.time),
							slot.service ?? dash,
							slot.bookings,
							slot.covers,
							<span key="l" className="inline-flex items-center gap-1">
								{slot.maxCovers !== null || slot.maxParties !== null ? (
									<bdi>
										{slot.maxCovers ?? dash} / {slot.maxParties ?? dash}
									</bdi>
								) : (
									dash
								)}
								{slot.overLimit ? (
									<Badge variant="warning">
										<Trans>Over limit</Trans>
									</Badge>
								) : null}
							</span>,
						],
					}))}
					empty={<Trans>No bookings in this range.</Trans>}
				/>
			</Section>
			<Section title={<Trans>Pacing limits</Trans>} testId="report-limits">
				<DataTable
					head={[
						<Trans key="s">Service</Trans>,
						<Trans key="w">Window</Trans>,
						<Trans key="c">Max covers</Trans>,
						<Trans key="p">Max parties</Trans>,
					]}
					rows={report.limits.map((limit, index) => ({
						key: `${limit.service ?? ''}-${limit.fromMin ?? 'x'}-${index}`,
						cells: [
							limit.service ?? dash,
							limit.fromMin === null && limit.toMin === null ? (
								<Trans>All day</Trans>
							) : (
								<bdi dir="ltr">
									{limit.fromMin === null
										? '00:00'
										: formatLocalMinutes(limit.fromMin)}
									–
									{limit.toMin === null
										? '24:00'
										: formatLocalMinutes(limit.toMin)}
								</bdi>
							),
							limit.maxCovers ?? dash,
							limit.maxParties ?? dash,
						],
					}))}
					empty={<Trans>No pacing limits are configured.</Trans>}
				/>
			</Section>
		</div>
	)
}
