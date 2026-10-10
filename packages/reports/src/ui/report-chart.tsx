import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from '@repo/ui/chart'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { type Ref } from 'react'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Pie,
	PieChart,
	XAxis,
	YAxis,
} from 'recharts'
import {
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
	type ReportSegment,
	isListReport,
} from '../dsl.ts'
import {
	formatMeasuredValue,
	formatNumber,
	formatOptionalValue,
	formatPercent,
	formatResultHeadline,
	segmentPercent,
	segmentTableColumns,
	shownValueInfo,
} from '../format.ts'

export const SEGMENT_COLORS = [
	'#0f766e',
	'#1d4ed8',
	'#db2777',
	'#ea580c',
	'#7c3aed',
	'#0891b2',
	'#65a30d',
	'#e11d48',
	'#6366f1',
	'#f59e0b',
	'#334155',
	'#0d9488',
]

type ChartMeasure = {
	dataKey: 'count' | 'percent' | 'value'
	label: string
	format: (value: number) => string
	tick?: (value: number) => string
}

function chartMeasure(
	definition: ReportDefinition,
	result: ReportResult,
): ChartMeasure {
	const info = shownValueInfo(result)
	if (info) {
		return {
			dataKey: 'value',
			label: info.label,
			format: (value) => formatMeasuredValue(value, info),
			tick: (value) => formatMeasuredValue(value, info, { compact: true }),
		}
	}
	if (definition.visualization.measure === 'percent') {
		return {
			dataKey: 'percent',
			label: 'Percent',
			format: formatPercent,
			tick: (value) => `${value}%`,
		}
	}
	return {
		dataKey: 'count',
		label: 'Count',
		format: (value) => formatNumber(value),
	}
}

/** Recharts 2 can't size a Y axis to its ticks, so estimate from the data. */
function yAxisWidth(measure: ChartMeasure, data: ReportSegment[]) {
	if (!measure.tick) return undefined
	const tick = measure.tick
	const widest = Math.max(
		1,
		...data.map((segment) => tick(segment[measure.dataKey] ?? 0).length),
	)
	return Math.min(96, Math.max(40, widest * 7 + 16))
}

function tooltipFormatter(measure: ChartMeasure, rowLabel?: string) {
	return (
		value: unknown,
		name: unknown,
		item: { payload?: { fill?: string } },
	) => (
		<div className="flex w-full items-center justify-between gap-3 leading-none">
			<span className="text-muted-foreground flex items-center gap-1.5">
				<span
					className="size-2.5 shrink-0 rounded-xs"
					style={{ backgroundColor: item.payload?.fill }}
				/>
				{rowLabel ?? String(name)}
			</span>
			<span className="text-foreground font-mono font-medium tabular-nums">
				{measure.format(Number(value))}
			</span>
		</div>
	)
}

/**
 * Caveats about the numbers in a result, shown above the visualization so
 * they stay out of exported images.
 */
export function ReportNotices({ result }: { result: ReportResult | null }) {
	if (!result) return null
	const notices: string[] = []
	if (result.valueInfo?.mixedCurrencies) {
		notices.push(
			"These amounts are in more than one currency, so they aren't added together. Charts and tables show record counts instead. Filter by currency to see the amounts.",
		)
	}
	if (result.sourceTruncated) {
		notices.push(
			'There is more data than one report can read, so results only cover the most recent part of this timeframe. Choose a shorter timeframe to include everything.',
		)
	}
	if (notices.length === 0) return null
	return (
		<div className="space-y-1 border-b px-4 py-2">
			{notices.map((notice) => (
				<p
					key={notice}
					className="text-muted-foreground flex items-start gap-2 text-sm leading-relaxed"
				>
					<Icon name="alert-triangle" className="mt-0.5 size-4 shrink-0" />
					{notice}
				</p>
			))}
		</div>
	)
}

function chartConfigFor(result: ReportResult): ChartConfig {
	const config: ChartConfig = {}
	for (const [index, segment] of result.segments.entries()) {
		config[segment.key] = {
			label: segment.label,
			color: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
		}
	}
	return config
}

function Frame({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-80 flex-1 items-center justify-center p-6">
			{children}
		</div>
	)
}

function Message({
	title,
	body,
	icon = 'alert-triangle',
}: {
	title: string
	body: string
	icon?: 'alert-triangle' | 'layout-grid'
}) {
	return (
		<div className="max-w-md space-y-2 text-center">
			<Icon name={icon} className="text-muted-foreground mx-auto size-6" />
			<p className="text-foreground font-medium">{title}</p>
			<p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
		</div>
	)
}

function SegmentTable({
	definition,
	result,
}: {
	definition: ReportDefinition
	result: ReportResult
}) {
	const columns = segmentTableColumns(
		definition.visualization.hideCounts,
		result,
	)
	const valueInfo = columns.value
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Segment</TableHead>
					{columns.count ? (
						<TableHead className="text-right">Count</TableHead>
					) : null}
					{valueInfo ? (
						<TableHead className="text-right">{valueInfo.label}</TableHead>
					) : null}
					{columns.percent ? (
						<TableHead className="text-right">Percent</TableHead>
					) : null}
				</TableRow>
			</TableHeader>
			<TableBody>
				{result.segments.map((segment) => (
					<TableRow key={segment.key}>
						<TableCell className="font-medium">{segment.label}</TableCell>
						{columns.count ? (
							<TableCell className="text-right tabular-nums">
								{segment.count.toLocaleString()}
							</TableCell>
						) : null}
						{valueInfo ? (
							<TableCell className="text-right tabular-nums">
								{formatOptionalValue(segment.value, valueInfo)}
							</TableCell>
						) : null}
						{columns.percent ? (
							<TableCell className="text-right tabular-nums">
								{formatPercent(segmentPercent(segment, result))}
							</TableCell>
						) : null}
					</TableRow>
				))}
			</TableBody>
			{result.segments.length > 1 ? (
				<TableFooter>
					<TableRow>
						<TableCell>Total</TableCell>
						{columns.count ? (
							<TableCell className="text-right tabular-nums">
								{result.total.toLocaleString()}
							</TableCell>
						) : null}
						{valueInfo ? (
							<TableCell className="text-right tabular-nums">
								{formatOptionalValue(result.value, valueInfo)}
							</TableCell>
						) : null}
						{columns.percent ? (
							<TableCell className="text-right tabular-nums">
								{formatPercent(100)}
							</TableCell>
						) : null}
					</TableRow>
				</TableFooter>
			) : null}
		</Table>
	)
}

export function ReportVisualization({
	definition,
	result,
	error,
	loading,
	containerRef,
}: {
	definition: ReportDefinition
	result: ReportResult | null
	error: ReportRunError | string | null
	loading: boolean
	containerRef?: Ref<HTMLDivElement>
}) {
	if (loading && !result) {
		return (
			<Frame>
				<div className="flex w-full max-w-xl flex-col items-center gap-4">
					<Skeleton className="size-56 rounded-full" />
					<div className="flex w-full max-w-sm gap-2">
						<Skeleton className="h-3 flex-1" />
						<Skeleton className="h-3 flex-1" />
						<Skeleton className="h-3 flex-1" />
					</div>
					<p className="text-muted-foreground text-sm">Loading results…</p>
				</div>
			</Frame>
		)
	}

	if (error) {
		const message = typeof error === 'string' ? error : error.message
		const missingGroup =
			typeof error === 'object' && error.error === 'missing_group_by'
		return (
			<Frame>
				<Message
					icon={missingGroup ? 'layout-grid' : 'alert-triangle'}
					title={
						missingGroup
							? 'Missing required segmentation field'
							: 'Cannot run this report'
					}
					body={
						missingGroup
							? 'Select at least one Group Results By field to see results.'
							: message
					}
				/>
			</Frame>
		)
	}

	if (!result) {
		return (
			<Frame>
				<Message
					icon="layout-grid"
					title="Configure the report"
					body="Choose a subject and timeframe to see a live visualization."
				/>
			</Frame>
		)
	}

	if (definition.visualization.chartStyle === 'single_number') {
		return (
			<div
				ref={containerRef}
				className="flex min-h-80 flex-1 flex-col items-center justify-center gap-2 px-6"
			>
				<p className="text-muted-foreground text-sm">
					{definition.settings.title}
				</p>
				<p className="text-foreground text-6xl tabular-nums">
					{formatResultHeadline(result)}
				</p>
			</div>
		)
	}

	if (isListReport(definition)) {
		const columns = result.columns ?? []
		const rows = result.rows ?? []
		if (rows.length === 0) {
			return (
				<Frame>
					<Message
						title="No matching records"
						body="Nothing in this timeframe matches the current filters. Widen the range or clear a filter to see results."
					/>
				</Frame>
			)
		}
		return (
			<div
				ref={containerRef}
				className="flex min-h-80 flex-1 flex-col overflow-hidden"
			>
				{result.truncated ? (
					<p className="text-muted-foreground border-b px-4 py-2 text-sm">
						Showing the first {rows.length.toLocaleString()} of{' '}
						{result.total.toLocaleString()} rows.
					</p>
				) : null}
				<div className="flex-1 overflow-auto p-4">
					<Table>
						<TableHeader>
							<TableRow>
								{columns.map((column) => (
									<TableHead key={column.id}>{column.label}</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row, index) => (
								<TableRow
									key={`${index}-${columns.map((c) => row[c.id]).join('|')}`}
								>
									{columns.map((column) => (
										<TableCell key={column.id}>
											{row[column.id] ?? '—'}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</div>
		)
	}

	if (result.segments.length === 0) {
		return (
			<Frame>
				<Message
					title="No matching records"
					body="Nothing in this timeframe matches the current filters. Widen the range or clear a filter to see results."
				/>
			</Frame>
		)
	}

	if (definition.visualization.chartStyle === 'table') {
		return (
			<div ref={containerRef} className="min-h-80 flex-1 overflow-auto p-4">
				<SegmentTable definition={definition} result={result} />
			</div>
		)
	}

	const data = result.segments.map((segment, index) => ({
		...segment,
		fill: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
	}))
	const config = chartConfigFor(result)
	const measure = chartMeasure(definition, result)

	if (definition.visualization.chartStyle === 'bar') {
		return (
			<div ref={containerRef} className="min-h-0 flex-1 p-4">
				<ChartContainer
					config={config}
					className="aspect-auto h-full max-h-[420px] w-full"
				>
					<BarChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="label"
							tickLine={false}
							axisLine={false}
							interval={data.length > 8 ? 'equidistantPreserveStart' : 0}
							angle={data.length > 6 ? -24 : 0}
							textAnchor={data.length > 6 ? 'end' : 'middle'}
							height={data.length > 6 ? 64 : 32}
							minTickGap={16}
						/>
						<YAxis
							tickLine={false}
							axisLine={false}
							allowDecimals={measure.dataKey !== 'count'}
							tickFormatter={measure.tick}
							width={yAxisWidth(measure, data)}
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									formatter={tooltipFormatter(measure, measure.label)}
								/>
							}
						/>
						<Bar dataKey={measure.dataKey} name={measure.label} radius={6}>
							{data.map((entry) => (
								<Cell key={entry.key} fill={entry.fill} />
							))}
						</Bar>
					</BarChart>
				</ChartContainer>
			</div>
		)
	}

	return (
		<div
			ref={containerRef}
			className="flex h-full min-h-0 flex-1 items-center justify-center p-4"
		>
			<ChartContainer
				config={config}
				className="h-full max-h-[420px] w-full max-w-3xl"
			>
				<PieChart>
					<ChartTooltip
						content={
							<ChartTooltipContent
								hideLabel
								formatter={tooltipFormatter(measure)}
							/>
						}
					/>
					<Pie
						data={data}
						dataKey={measure.dataKey}
						nameKey="label"
						cx="50%"
						cy="50%"
						innerRadius={0}
						outerRadius={140}
						paddingAngle={1}
						label={({ name, payload }) => {
							const slice = payload as ReportSegment
							const pct = formatPercent(segmentPercent(slice, result))
							if (definition.visualization.hideCounts) return `${name} ${pct}`
							const info = shownValueInfo(result)
							const amount = info
								? formatOptionalValue(slice.value, info)
								: slice.count.toLocaleString()
							return `${name} ${pct} (${amount})`
						}}
					>
						{data.map((entry) => (
							<Cell key={entry.key} fill={entry.fill} />
						))}
					</Pie>
				</PieChart>
			</ChartContainer>
		</div>
	)
}
