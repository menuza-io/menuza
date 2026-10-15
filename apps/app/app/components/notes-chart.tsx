import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from '@repo/ui/chart'
import { Icon } from '@repo/ui/icon'
import { memo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts'

const chartConfig = {
	notes: {
		label: 'Notes Created',
		color: 'var(--chart-4)',
	},
} satisfies ChartConfig

interface NotesChartProps {
	data: Array<{
		date: string
		day: string
		label: string
		notes: number
	}>
	daysShown: number
	totalNotes: number
	avgPerDay: number
	trend: number
	className?: string
}

/** Fills the height it is given; the chart takes the space left by the text. */
export const NotesChart = memo(function NotesChart({
	data,
	daysShown,
	totalNotes,
	avgPerDay,
	trend,
	className,
}: NotesChartProps) {
	const { _: ignored_ } = useLingui()
	const absTrend = Math.abs(trend)

	return (
		<Card className={className}>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>
							<Trans>Daily Notes Created</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>Last {daysShown} days</Trans>
						</CardDescription>
					</div>
					<div className="flex items-center gap-4 text-sm">
						<div className="text-right">
							<div className="text-muted-foreground text-xs">
								<Trans>Total</Trans>
							</div>
							<div className="font-semibold tabular-nums">{totalNotes}</div>
						</div>
						<div className="text-right">
							<div className="text-muted-foreground text-xs">
								<Trans>Avg/day</Trans>
							</div>
							<div className="font-semibold tabular-nums">{avgPerDay}</div>
						</div>
					</div>
				</div>
			</CardHeader>
			<CardContent className="min-h-0 flex-1">
				<ChartContainer
					config={chartConfig}
					className="aspect-auto h-full min-h-40 w-full"
				>
					<AreaChart
						accessibilityLayer
						data={data}
						margin={{ left: 12, right: 12 }}
					>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="label"
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							tickFormatter={(value) => value}
						/>
						<ChartTooltip
							cursor={false}
							content={<ChartTooltipContent indicator="dot" />}
						/>
						<Area
							dataKey="notes"
							type="step"
							fill="var(--color-notes)"
							fillOpacity={0.4}
							stroke="var(--color-notes)"
							strokeWidth={2}
						/>
					</AreaChart>
				</ChartContainer>
			</CardContent>
			<CardFooter className="text-muted-foreground text-sm">
				{trend >= 0 ? (
					<span className="flex items-center gap-2">
						<Trans>Trending up by {trend}% this period</Trans>
						<Icon name="trending-up" className="text-primary h-4 w-4" />
					</span>
				) : (
					<span className="flex items-center gap-2">
						<Trans>Down by {absTrend}% this period</Trans>
						<Icon
							name="trending-up"
							className="h-4 w-4 rotate-180 text-red-600 dark:text-red-400"
						/>
					</span>
				)}
			</CardFooter>
		</Card>
	)
})
