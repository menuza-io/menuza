import { Trans, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Item, ItemContent, ItemGroup } from '@repo/ui/item'
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { EmptyState } from '#app/components/empty-state.tsx'
import { EmptyValue } from '#app/components/staff/empty-value.tsx'
import {
	type LaborDayRow,
	type LaborMoneyRow,
	type LaborSummary,
} from '#app/utils/staffing/labor-types.ts'
import {
	currenciesOf,
	formatTarget,
	hoursOf,
	moneyIn,
	SOURCE_NOTES,
} from '#app/utils/staffing/labor-view.ts'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'
import { MoneyLines, ShareValue, useSourceName } from './labor-parts.tsx'

/**
 * The labor picture of one scope over a range: a quiet row of figures, the
 * sales source stated beside them, and one row per day. Every figure is an
 * estimate (rates and the shared overtime math, never payroll). The share is
 * only ever marked within or over its target when the server says the sales
 * are complete; with online orders alone the screen says plainly what the
 * share leaves out.
 */
export function LaborOverview({
	summary,
	locale,
	layout,
	canEditSales,
	canEditSettings,
	onEnterSales,
	onChangeSource,
}: {
	summary: LaborSummary
	locale: string
	layout: 'table' | 'cards'
	canEditSales: boolean
	canEditSettings: boolean
	onEnterSales: () => void
	onChangeSource: () => void
}) {
	const sourceName = useSourceName(summary.salesSource)
	const manual = summary.salesSource === 'manual'
	const { totals } = summary
	const currencies = currenciesOf(totals.money)
	// With no sales to compare against, the share columns would be a wall of dashes.
	const showShare = summary.days.some((day) =>
		day.money.some((row) => row.laborBp !== null),
	)

	if (summary.totals.cards === 0 && totals.money.every((m) => !m.salesMinor)) {
		return (
			<div className="flex flex-col gap-4">
				<SourceLine
					summary={summary}
					canEditSettings={canEditSettings}
					onChangeSource={onChangeSource}
				/>
				<EmptyState
					title={
						<>
							<Trans>No hours or sales in this range</Trans>
						</>
					}
					description={
						<>
							<Trans>
								When people clock in, or you add time cards, their hours and
								wages add up here against your sales.
							</Trans>
						</>
					}
					icons={['clock', 'users', 'calendar']}
				/>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-5">
			<SourceLine
				summary={summary}
				canEditSettings={canEditSettings}
				onChangeSource={onChangeSource}
			/>

			{summary.currencyMismatch ? (
				<p role="status" className="text-sm text-pretty">
					<Trans>
						Wages and sales are in different currencies, so they are shown
						separately and left out of the share. Amounts are never converted.
					</Trans>
				</p>
			) : null}

			{currencies.length === 0 ? (
				<Figures
					summary={summary}
					currency={null}
					locale={locale}
					sourceName={sourceName}
				/>
			) : (
				currencies.map((currency) => (
					<Figures
						key={currency}
						summary={summary}
						currency={currency}
						locale={locale}
						sourceName={sourceName}
						label={currencies.length > 1 ? currency : null}
					/>
				))
			)}

			{layout === 'cards' ? (
				<DayCards
					days={summary.days}
					locale={locale}
					manual={manual}
					canEditSales={canEditSales}
					onEnterSales={onEnterSales}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableCaption className="sr-only">
							<Trans>Labor by day</Trans>
						</TableCaption>
						<TableHeader className="sticky top-0 z-10">
							<TableRow>
								<TableHead className="text-start">
									<Trans>Day</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Hours</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Wages (estimate)</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Sales</Trans>
								</TableHead>
								{showShare ? (
									<>
										<TableHead className="text-end">
											<Trans>Labor share</Trans>
										</TableHead>
										<TableHead className="text-end">
											<Trans>Sales per hour</Trans>
										</TableHead>
									</>
								) : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{summary.days.map((day) => (
								<TableRow key={day.date}>
									<TableCell className="whitespace-nowrap">
										{formatDateLabel(day.date, locale)}
									</TableCell>
									<TableCell className="text-end tabular-nums">
										<HoursCell day={day} locale={locale} />
									</TableCell>
									<TableCell className="text-end">
										<MoneyLines
											rows={day.money}
											pick={(row) => (row.costMinor > 0 ? row.costMinor : null)}
											locale={locale}
										/>
									</TableCell>
									<TableCell className="text-end">
										<SalesCell
											day={day}
											locale={locale}
											manual={manual}
											canEditSales={canEditSales}
											onEnterSales={onEnterSales}
										/>
									</TableCell>
									{showShare ? (
										<>
											<TableCell className="text-end">
												<ShareLines day={day} locale={locale} />
											</TableCell>
											<TableCell className="text-end">
												<MoneyLines
													rows={day.money}
													pick={(row) => row.salesPerLaborHourMinor}
													locale={locale}
												/>
											</TableCell>
										</>
									) : null}
								</TableRow>
							))}
						</TableBody>
						<TableFooter>
							<TableRow>
								<TableCell className="font-medium">
									<Trans>Total</Trans>
								</TableCell>
								<TableCell className="text-end font-medium tabular-nums">
									{hoursOf(totals.paidMinutes, locale)}
								</TableCell>
								<TableCell className="text-end font-medium">
									<MoneyLines
										rows={totals.money}
										pick={(row) => row.costMinor}
										locale={locale}
									/>
								</TableCell>
								<TableCell className="text-end font-medium">
									<MoneyLines
										rows={totals.money}
										pick={(row) => row.salesMinor}
										locale={locale}
									/>
								</TableCell>
								{showShare ? (
									<>
										<TableCell className="text-end font-medium">
											{totals.money.length === 0 ? (
												<EmptyValue />
											) : (
												totals.money.map((row) => (
													<ShareValue
														key={row.currency}
														row={row}
														locale={locale}
														className="block"
													/>
												))
											)}
										</TableCell>
										<TableCell className="text-end font-medium">
											<MoneyLines
												rows={totals.money}
												pick={(row) => row.salesPerLaborHourMinor}
												locale={locale}
											/>
										</TableCell>
									</>
								) : null}
							</TableRow>
						</TableFooter>
					</Table>
				</Frame>
			)}

			<ul className="text-muted-foreground flex flex-col gap-1 text-xs text-pretty">
				<li>
					<Trans>
						Wages are estimates from each card's rate and your overtime rules,
						not payroll. The share is wages divided by sales over the days that
						have sales, not an average of daily shares.
					</Trans>
				</li>
				{totals.daysWithoutSales > 0 ? (
					<li>
						{plural(totals.daysWithoutSales, {
							one: '# day has no sales yet and is left out of the share.',
							other: '# days have no sales yet and are left out of the share.',
						})}
					</li>
				) : null}
				{summary.openCards > 0 ? (
					<li>
						{plural(summary.openCards, {
							one: '# card is still open; its hours are counted up to now.',
							other:
								'# cards are still open; their hours are counted up to now.',
						})}
					</li>
				) : null}
				{summary.unpricedMinutes > 0 ? (
					<li>
						{plural(Math.round(summary.unpricedMinutes / 60), {
							one: '# hour has no pay rate, so it has no wage figure.',
							other: '# hours have no pay rate, so they have no wage figure.',
						})}
					</li>
				) : null}
				{summary.truncated ? (
					<li>
						<Trans>
							This range has more cards than can be added up here. Choose a
							shorter range.
						</Trans>
					</li>
				) : null}
			</ul>
		</div>
	)
}

/** Which sales these are, and what they leave out. Always in view with the share. */
function SourceLine({
	summary,
	canEditSettings,
	onChangeSource,
}: {
	summary: LaborSummary
	canEditSettings: boolean
	onChangeSource: () => void
}) {
	const { _ } = useLingui()
	const name = useSourceName(summary.salesSource)
	return (
		<p className="text-sm text-pretty">
			<span className="font-medium">
				<Trans>Sales: {name}.</Trans>
			</span>{' '}
			<span className="text-muted-foreground">
				{_(SOURCE_NOTES[summary.salesSource])}
			</span>{' '}
			{canEditSettings ? (
				<Button
					variant="link"
					className="h-auto p-0 align-baseline"
					onClick={onChangeSource}
				>
					<Trans>Change</Trans>
				</Button>
			) : null}
		</p>
	)
}

/**
 * The figures of one currency, side by side with equal weight: wages, sales,
 * the labor share and sales per labor hour. A plain list, not a scoreboard.
 */
function Figures({
	summary,
	currency,
	locale,
	sourceName,
	label,
}: {
	summary: LaborSummary
	currency: string | null
	locale: string
	sourceName: string
	label?: string | null
}) {
	const row = currency ? moneyIn(summary.totals.money, currency) : undefined
	const share = row?.laborBp ?? null
	const overtime = hoursOf(summary.totals.overtimeMinutes, locale)
	const target =
		summary.targetBp !== null ? formatTarget(summary.targetBp, locale) : ''
	return (
		<section aria-label={label ?? undefined}>
			{label ? (
				<h3 className="text-muted-foreground mb-1 text-xs font-medium">
					{label}
				</h3>
			) : null}
			<div className="bg-border grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:auto-cols-fr lg:grid-flow-col">
				<Figure term={<Trans>Hours</Trans>}>
					{hoursOf(summary.totals.paidMinutes, locale)}
					{summary.totals.overtimeMinutes > 0 ? (
						<span className="text-muted-foreground block text-xs font-normal">
							<Trans>{overtime} overtime</Trans>
						</span>
					) : null}
				</Figure>
				<Figure term={<Trans>Wages (estimate)</Trans>}>
					{row ? (
						formatMoneyMinor(row.costMinor, row.currency, locale)
					) : (
						<EmptyValue />
					)}
				</Figure>
				<Figure term={<Trans>Sales</Trans>}>
					{row && row.salesMinor !== null ? (
						formatMoneyMinor(row.salesMinor, row.currency, locale)
					) : (
						<EmptyValue />
					)}
				</Figure>
				<Figure term={<Trans>Labor share</Trans>}>
					{row ? <ShareValue row={row} locale={locale} /> : <EmptyValue />}
					<span className="text-muted-foreground block text-xs font-normal text-pretty">
						{share !== null ? (
							<Trans>of {sourceName}</Trans>
						) : (
							<Trans>No sales to compare</Trans>
						)}
						{summary.targetBp !== null ? (
							<>
								{' · '}
								{summary.targetColoring ? (
									<Trans>Target {target}</Trans>
								) : (
									<Trans>Target {target}, not applied</Trans>
								)}
							</>
						) : null}
					</span>
				</Figure>
				{row && row.salesPerLaborHourMinor !== null ? (
					<Figure term={<Trans>Sales per labor hour</Trans>}>
						{formatMoneyMinor(row.salesPerLaborHourMinor, row.currency, locale)}
					</Figure>
				) : null}
			</div>
		</section>
	)
}

function Figure({
	term,
	children,
}: {
	term: React.ReactNode
	children: React.ReactNode
}) {
	return (
		<div className="bg-card flex min-w-0 flex-col gap-1.5 px-4 py-3 sm:odd:last:col-span-2 lg:odd:last:col-span-1">
			<div className="text-foreground/75 text-[13px]">{term}</div>
			<div className="text-xl leading-tight font-semibold tracking-tight tabular-nums">
				{children}
			</div>
		</div>
	)
}

function HoursCell({ day, locale }: { day: LaborDayRow; locale: string }) {
	if (day.paidMinutes === 0) return <EmptyValue />
	const overtime = hoursOf(day.overtimeMinutes, locale)
	return (
		<>
			{hoursOf(day.paidMinutes, locale)}
			{day.overtimeMinutes > 0 ? (
				<span className="text-muted-foreground block text-xs">
					<Trans>{overtime} overtime</Trans>
				</span>
			) : null}
		</>
	)
}

function SalesCell({
	day,
	locale,
	manual,
	canEditSales,
	onEnterSales,
}: {
	day: LaborDayRow
	locale: string
	manual: boolean
	canEditSales: boolean
	onEnterSales: () => void
}) {
	if (!day.hasSales) {
		return manual && canEditSales && day.paidMinutes > 0 ? (
			<Button
				variant="link"
				className="h-auto min-h-11 p-0 align-baseline md:min-h-0"
				onClick={onEnterSales}
			>
				<Trans>Enter sales</Trans>
			</Button>
		) : (
			<span className="text-muted-foreground">
				<Trans>Not entered</Trans>
			</span>
		)
	}
	return (
		<MoneyLines
			rows={day.money}
			pick={(row) => row.salesMinor}
			locale={locale}
			empty={<EmptyValue />}
		/>
	)
}

function ShareLines({ day, locale }: { day: LaborDayRow; locale: string }) {
	const rows = day.money.filter((row) => row.laborBp !== null)
	if (rows.length === 0) return <EmptyValue />
	return (
		<>
			{rows.map((row) => (
				<ShareValue
					key={row.currency}
					row={row}
					locale={locale}
					className="block"
				/>
			))}
		</>
	)
}

function DayCards({
	days,
	locale,
	manual,
	canEditSales,
	onEnterSales,
}: {
	days: readonly LaborDayRow[]
	locale: string
	manual: boolean
	canEditSales: boolean
	onEnterSales: () => void
}) {
	return (
		<ItemGroup className="gap-2">
			{days.map((day) => {
				const hours = hoursOf(day.paidMinutes, locale)
				return (
					<Item key={day.date} variant="outline">
						<ItemContent>
							<div className="flex items-baseline justify-between gap-3">
								<span className="text-sm font-medium">
									{formatDateLabel(day.date, locale)}
								</span>
								<span className="text-muted-foreground text-xs tabular-nums">
									{day.paidMinutes > 0 ? (
										<Trans>{hours} hours</Trans>
									) : (
										<EmptyValue />
									)}
								</span>
							</div>
							<div
								className={cn(
									'grid grid-cols-3 gap-2 text-sm',
									day.money.length === 0 && 'hidden',
								)}
							>
								<Mini term={<Trans>Wages</Trans>}>
									<MoneyLines
										rows={day.money}
										pick={(row) => (row.costMinor > 0 ? row.costMinor : null)}
										locale={locale}
									/>
								</Mini>
								<Mini term={<Trans>Sales</Trans>}>
									<SalesCell
										day={day}
										locale={locale}
										manual={manual}
										canEditSales={canEditSales}
										onEnterSales={onEnterSales}
									/>
								</Mini>
								<Mini term={<Trans>Share</Trans>}>
									<ShareLines day={day} locale={locale} />
								</Mini>
							</div>
						</ItemContent>
					</Item>
				)
			})}
		</ItemGroup>
	)
}

function Mini({
	term,
	children,
}: {
	term: React.ReactNode
	children: React.ReactNode
}) {
	return (
		<div className="min-w-0">
			<div className="text-muted-foreground text-xs">{term}</div>
			<div className="tabular-nums">{children}</div>
		</div>
	)
}

export type { LaborMoneyRow }
