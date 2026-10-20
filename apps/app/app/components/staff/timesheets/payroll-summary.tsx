import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Item, ItemActions, ItemContent, ItemGroup } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@repo/ui/popover'
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
import { useCallback, useMemo, useState } from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { EmptyValue } from '#app/components/staff/empty-value.tsx'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import {
	DEFAULT_SUMMARY_COLUMNS,
	SUMMARY_COLUMNS,
} from '#app/utils/staffing/timesheet-export.ts'
import {
	type PayrollSummaryData,
	type SummaryRow,
} from '#app/utils/staffing/timesheet-types.ts'
import { formatHours } from '#app/utils/staffing/timesheet-view.ts'

const STORAGE_KEY = 'timesheet-summary-columns'
/** Names are what a payroll clerk matches rows by, so they cannot be hidden. */
const LOCKED = new Set(['firstName', 'lastName'])

function readStored(): string[] | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY)
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) &&
			parsed.every((item): item is string => typeof item === 'string')
			? parsed
			: null
	} catch {
		return null
	}
}

function writeStored(columns: readonly string[]) {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(columns))
	} catch {
		// Storage can be blocked; the choice then lasts until the page closes.
	}
}

/**
 * Which summary columns are on. Remembered in this browser only (a per-viewer
 * convenience); money columns drop out for a viewer without the pay grant.
 */
export function useSummaryColumns(moneyVisible: boolean) {
	const [chosen, setChosen] = useState<string[]>(
		() => readStored() ?? [...DEFAULT_SUMMARY_COLUMNS],
	)
	const available = useMemo(
		() => SUMMARY_COLUMNS.filter((column) => moneyVisible || !column.money),
		[moneyVisible],
	)
	const active = useMemo(
		() =>
			available.filter(
				(column) => LOCKED.has(column.id) || chosen.includes(column.id),
			),
		[available, chosen],
	)
	const toggle = useCallback((id: string) => {
		if (LOCKED.has(id)) return
		setChosen((current) => {
			const next = current.includes(id)
				? current.filter((item) => item !== id)
				: [...current, id]
			writeStored(next)
			return next
		})
	}, [])
	const reset = useCallback(() => {
		setChosen([...DEFAULT_SUMMARY_COLUMNS])
		writeStored(DEFAULT_SUMMARY_COLUMNS)
	}, [])
	return { available, active, toggle, reset }
}

export type SummaryColumns = ReturnType<typeof useSummaryColumns>

export function ColumnPicker({ columns }: { columns: SummaryColumns }) {
	const { _ } = useLingui()
	const labels = useColumnLabels()
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button variant="outline">
						<Icon name="settings" />
						<Trans>Columns</Trans>
					</Button>
				}
			/>
			<PopoverContent align="end" className="w-64">
				<PopoverHeader>
					<PopoverTitle>
						<Trans>Columns</Trans>
					</PopoverTitle>
					<PopoverDescription>
						<Trans>Shown in the table and in the CSV file.</Trans>
					</PopoverDescription>
				</PopoverHeader>
				<ul className="flex flex-col">
					{columns.available.map((column) => {
						const locked = LOCKED.has(column.id)
						const on = columns.active.some((item) => item.id === column.id)
						const label = labels[column.id] ?? column.header
						return (
							<li key={column.id}>
								<Label className="min-h-11 cursor-pointer px-1 font-normal md:min-h-8">
									<Checkbox
										checked={on}
										disabled={locked}
										onCheckedChange={() => columns.toggle(column.id)}
										aria-label={label}
									/>
									<span className={cn(locked && 'text-muted-foreground')}>
										{label}
									</span>
								</Label>
							</li>
						)
					})}
				</ul>
				<Button
					variant="ghost"
					className="h-11 justify-start rounded-md md:h-8"
					onClick={columns.reset}
				>
					<Icon name="undo-2" />
					{_(t`Reset to the usual columns`)}
				</Button>
			</PopoverContent>
		</Popover>
	)
}

function useColumnLabels(): Record<string, string> {
	const { _ } = useLingui()
	return {
		employeeId: _(t`Payroll ID`),
		firstName: _(t`First name`),
		lastName: _(t`Last name`),
		cards: _(t`Cards`),
		regular: _(t`Regular`),
		overtime: _(t`Overtime`),
		doubleTime: _(t`Double time`),
		holiday: _(t`Holiday`),
		paid: _(t`Paid hours`),
		unapproved: _(t`To approve`),
		currency: _(t`Currency`),
		rate: _(t`Hourly rate`),
		pay: _(t`Est. pay`),
		cashTips: _(t`Cash tips`),
		creditTips: _(t`Credit tips`),
	}
}

const RIGHT = new Set([
	'cards',
	'regular',
	'overtime',
	'doubleTime',
	'holiday',
	'paid',
	'unapproved',
	'rate',
	'pay',
	'cashTips',
	'creditTips',
])

function moneyList(
	byCurrency: Record<string, number> | undefined,
	locale: string,
): string | null {
	const entries = Object.entries(byCurrency ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	)
	if (entries.length === 0) return null
	return entries
		.map(([currency, minor]) => formatMoneyMinor(minor, currency, locale))
		.join(' + ')
}

function rateList(row: SummaryRow, locale: string): string | null {
	const rates = row.money?.ratesMinor ?? []
	if (rates.length === 0) return null
	return [...rates]
		.sort((a, b) => a.rateMinor - b.rateMinor)
		.map((rate) => formatMoneyMinor(rate.rateMinor, rate.currency, locale))
		.join(' / ')
}

function cellFor(
	id: string,
	row: SummaryRow,
	locale: string,
): string | number | null {
	switch (id) {
		case 'employeeId':
			return row.employeeNumber
		case 'firstName':
			return row.firstName
		case 'lastName':
			return row.lastName
		case 'cards':
			return row.cards
		case 'regular':
			return row.regularMinutes ? formatHours(row.regularMinutes, locale) : null
		case 'overtime':
			return row.overtimeMinutes
				? formatHours(row.overtimeMinutes, locale)
				: null
		case 'doubleTime':
			return row.doubleTimeMinutes
				? formatHours(row.doubleTimeMinutes, locale)
				: null
		case 'holiday':
			return row.holidayMinutes ? formatHours(row.holidayMinutes, locale) : null
		case 'paid':
			return row.paidMinutes ? formatHours(row.paidMinutes, locale) : null
		case 'unapproved':
			return row.unapprovedCards > 0 ? row.unapprovedCards : null
		case 'currency':
			return (
				Object.keys(row.money?.payMinorByCurrency ?? {})
					.sort()
					.join(' + ') || null
			)
		case 'rate':
			return rateList(row, locale)
		case 'pay':
			return moneyList(row.money?.payMinorByCurrency, locale)
		case 'cashTips':
			return moneyList(row.money?.cashTipsMinorByCurrency, locale)
		case 'creditTips':
			return moneyList(row.money?.creditTipsMinorByCurrency, locale)
		default:
			return null
	}
}

export function PayrollSummary({
	data,
	columns,
	locale,
	layout,
	onReviewQueue,
}: {
	data: PayrollSummaryData
	columns: SummaryColumns
	locale: string
	layout: 'table' | 'cards'
	onReviewQueue: () => void
}) {
	const { _ } = useLingui()
	const labels = useColumnLabels()
	const money = columns.available.some((column) => column.money)
	const moneyRows = money && data.rows.some((row) => row.money)
	const labor = moneyList(data.labor?.payMinorByCurrency, locale)

	if (data.rows.length === 0) {
		return (
			<EmptyState
				title={
					<>
						<Trans>No hours in this pay period</Trans>
					</>
				}
				description={
					<>
						<Trans>
							When people clock in or you add time cards, their hours add up
							here.
						</Trans>
					</>
				}
				icons={['clock', 'users', 'calendar']}
			/>
		)
	}

	const status = data.readyForPayroll ? (
		<p className="flex items-center gap-2 text-sm font-medium">
			<Icon name="circle-check" className="size-4" />
			<Trans>Every card is approved. This period is ready for payroll.</Trans>
		</p>
	) : (
		<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
			<Icon name="alert-triangle" className="size-4" />
			<span>
				{plural(data.totals.unapprovedCards, {
					one: '# card is still waiting to be approved or reviewed.',
					other: '# cards are still waiting to be approved or reviewed.',
				})}
			</span>
			<Button variant="link" className="h-auto p-0" onClick={onReviewQueue}>
				<Trans>Open the review queue</Trans>
			</Button>
		</p>
	)

	return (
		<div className="flex flex-col gap-4">
			{status}
			{data.truncated ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>
						This period has more cards than we can add up here. Narrow the
						filters.
					</Trans>
				</p>
			) : null}

			{layout === 'cards' ? (
				<ItemGroup className="gap-2">
					{data.rows.map((row) => {
						const pay = moneyList(row.money?.payMinorByCurrency, locale)
						return (
							<Item key={row.staffId} variant="outline">
								<ItemContent className="min-w-0 flex-1">
									<span className="truncate text-sm font-medium">
										{`${row.firstName} ${row.lastName}`.trim()}
									</span>
									<span className="text-muted-foreground text-xs">
										{row.employeeNumber ?? _(t`No payroll ID`)}
										{row.unapprovedCards > 0
											? ` · ${plural(row.unapprovedCards, { one: '# to approve', other: '# to approve' })}`
											: ''}
									</span>
								</ItemContent>
								<ItemActions>
									<div className="flex flex-col items-end text-sm tabular-nums">
										<span className="font-medium">
											{formatHours(row.paidMinutes, locale)}
										</span>
										{row.overtimeMinutes > 0 ? (
											<span className="text-muted-foreground text-xs">
												{_(t`OT`)} {formatHours(row.overtimeMinutes, locale)}
											</span>
										) : null}
										{pay ? (
											<span className="text-muted-foreground text-xs">
												{pay}
											</span>
										) : null}
									</div>
								</ItemActions>
							</Item>
						)
					})}
				</ItemGroup>
			) : (
				<Table>
					<TableCaption className="sr-only">
						<Trans>Payroll summary</Trans>
					</TableCaption>
					<TableHeader className="sticky top-0 z-10">
						<TableRow>
							{columns.active.map((column) => (
								<TableHead
									key={column.id}
									className={RIGHT.has(column.id) ? 'text-end' : 'text-start'}
								>
									{labels[column.id] ?? column.header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.rows.map((row) => (
							<TableRow key={row.staffId}>
								{columns.active.map((column) => {
									const value = cellFor(column.id, row, locale)
									return (
										<TableCell
											key={column.id}
											className={cn(
												RIGHT.has(column.id) ? 'text-end tabular-nums' : '',
												column.id === 'unapproved' ? 'font-medium' : '',
											)}
										>
											{value === null || value === '' ? <EmptyValue /> : value}
										</TableCell>
									)
								})}
							</TableRow>
						))}
					</TableBody>
					<TableFooter>
						<TableRow>
							{columns.active.map((column, index) => (
								<TableCell
									key={column.id}
									className={cn(
										'font-medium',
										RIGHT.has(column.id) ? 'text-end tabular-nums' : '',
									)}
								>
									{index === 0 ? (
										<Trans>Total</Trans>
									) : column.id === 'cards' ? (
										data.totals.cards
									) : column.id === 'regular' ? (
										formatHours(data.totals.regularMinutes, locale)
									) : column.id === 'overtime' ? (
										formatHours(data.totals.overtimeMinutes, locale)
									) : column.id === 'doubleTime' ? (
										formatHours(data.totals.doubleTimeMinutes, locale)
									) : column.id === 'holiday' ? (
										formatHours(data.totals.holidayMinutes, locale)
									) : column.id === 'paid' ? (
										formatHours(data.totals.paidMinutes, locale)
									) : column.id === 'unapproved' ? (
										data.totals.unapprovedCards
									) : column.id === 'pay' && labor ? (
										labor
									) : null}
								</TableCell>
							))}
						</TableRow>
					</TableFooter>
				</Table>
			)}

			<p className="text-muted-foreground text-xs">
				{moneyRows ? (
					<Trans>
						Overtime and pay are estimates from your labor rules and each card's
						rate, not payroll.
					</Trans>
				) : (
					<Trans>Overtime is an estimate from your labor rules.</Trans>
				)}
			</p>
		</div>
	)
}
