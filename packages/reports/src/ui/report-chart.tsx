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
	isListReport,
} from '../dsl.ts'

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

function formatPercent(value: number) {
	return `${value.toFixed(1)}%`
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
					{result.total.toLocaleString()}
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
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Segment</TableHead>
							{!definition.visualization.hideCounts ? (
								<TableHead className="text-right">Count</TableHead>
							) : null}
							<TableHead className="text-right">Percent</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{result.segments.map((segment) => (
							<TableRow key={segment.key}>
								<TableCell className="font-medium">{segment.label}</TableCell>
								{!definition.visualization.hideCounts ? (
									<TableCell className="text-right tabular-nums">
										{segment.count.toLocaleString()}
									</TableCell>
								) : null}
								<TableCell className="text-right tabular-nums">
									{formatPercent(segment.percent)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		)
	}

	const data = result.segments.map((segment, index) => ({
		...segment,
		fill: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
	}))
	const config = chartConfigFor(result)
	const valueKey =
		definition.visualization.measure === 'percent' ? 'percent' : 'count'

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
						<YAxis tickLine={false} axisLine={false} allowDecimals={false} />
						<ChartTooltip content={<ChartTooltipContent />} />
						<Bar dataKey={valueKey} radius={6}>
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
					<ChartTooltip content={<ChartTooltipContent hideLabel />} />
					<Pie
						data={data}
						dataKey={valueKey}
						nameKey="label"
						cx="50%"
						cy="50%"
						innerRadius={0}
						outerRadius={140}
						paddingAngle={1}
						label={({ name, payload }) => {
							const slice = payload as {
								count?: number
								percent?: number
							}
							const count = slice.count ?? 0
							const pct = formatPercent(slice.percent ?? 0)
							return definition.visualization.hideCounts
								? `${name} ${pct}`
								: `${name} ${pct} (${count})`
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
