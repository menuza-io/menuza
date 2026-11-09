import { useLingui } from '@lingui/react/macro'
import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from '@repo/ui/chart'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { formatMoney } from '#app/utils/inventory/format.ts'

export type BarRow = {
	key: string
	label: string
	count: number
	valueMinor?: number
}

/** A horizontal bar per row: money when the member may see it, else counts. */
export function WasteBars({
	rows,
	currency,
	testId,
}: {
	rows: readonly BarRow[]
	currency: string
	testId: string
}) {
	const { t, i18n } = useLingui()
	const withMoney =
		rows.length > 0 && rows.every((row) => row.valueMinor !== undefined)
	const data = rows
		.map((row) => ({
			key: row.key,
			label: row.label,
			value: withMoney ? (row.valueMinor ?? 0) / 100 : row.count,
		}))
		.sort((a, b) => b.value - a.value)
	const config = {
		value: {
			label: withMoney ? t`Cost` : t`Times`,
			color: 'var(--chart-1)',
		},
	} satisfies ChartConfig
	const height = Math.min(Math.max(data.length * 36 + 24, 96), 400)
	const heightClass =
		height <= 96
			? 'h-24'
			: height <= 160
				? 'h-40'
				: height <= 240
					? 'h-60'
					: height <= 320
						? 'h-80'
						: 'h-96'
	return (
		<ChartContainer
			config={config}
			className={`aspect-auto w-full ${heightClass}`}
			data-testid={testId}
		>
			<BarChart
				accessibilityLayer
				data={data}
				layout="vertical"
				margin={{ left: 8, right: 16 }}
			>
				<CartesianGrid horizontal={false} />
				<YAxis
					dataKey="label"
					type="category"
					tickLine={false}
					axisLine={false}
					width={110}
				/>
				<XAxis type="number" hide />
				<ChartTooltip
					cursor={false}
					content={
						<ChartTooltipContent
							hideLabel
							formatter={(value, _name, item) => (
								<span className="flex w-full items-center justify-between gap-4">
									<span className="text-muted-foreground">
										{(item.payload as { label: string }).label}
									</span>
									<bdi dir="ltr" className="font-medium tabular-nums">
										{withMoney
											? formatMoney(Number(value) * 100, currency, i18n.locale)
											: String(value)}
									</bdi>
								</span>
							)}
						/>
					}
				/>
				<Bar dataKey="value" fill="var(--color-value)" radius={4} />
			</BarChart>
		</ChartContainer>
	)
}
