import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Checkbox } from '@repo/ui/checkbox'
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
import { Link } from 'react-router'
import { EmptyValue } from '#app/components/staff/empty-value.tsx'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'
import { formatClockTime } from '#app/utils/staffing/timeclock-format.ts'
import { type TimesheetCardRow } from '#app/utils/staffing/timesheet-types.ts'
import {
	dayOffset,
	displayName,
	formatDateLabel,
	formatHours,
	positionLabel,
	type RowGroup,
	type RowTotals,
	type TimesheetGroup,
	type TimesheetRow,
} from '#app/utils/staffing/timesheet-view.ts'
import { IssueChips, OvertimeChip, StatusBadge } from './card-status.tsx'

export type TimesheetListProps = {
	groups: readonly RowGroup[]
	by: TimesheetGroup
	locale: string
	/** Names for the scope ids a card carries. */
	scopeNames: ReadonlyMap<string, string>
	showScope: boolean
	showMoney: boolean
	/** The row checkboxes: only offered to someone who can approve or review. */
	selectable: boolean
	selected: ReadonlySet<string>
	onToggle: (id: string) => void
	onToggleGroup: (ids: readonly string[], on: boolean) => void
	cardHref: (id: string) => string
	totals: RowTotals
	/** Cards (stacked) when the room is narrow, a table otherwise. */
	layout: 'table' | 'cards'
}

function useCardText(locale: string) {
	const { _ } = useLingui()
	return {
		range(card: TimesheetCardRow) {
			const from = formatClockTime(card.clockInAt, card.timeZone, locale)
			if (card.clockOutAt === null) return { from, to: null, next: 0 }
			return {
				from,
				to: formatClockTime(card.clockOutAt, card.timeZone, locale),
				next: Math.max(
					0,
					dayOffset(card.clockInAt, card.clockOutAt, card.timeZone),
				),
			}
		},
		pay(card: TimesheetCardRow): string | null {
			const money = card.money
			if (!money || money.payMinor === null || money.currency === null) {
				return null
			}
			return formatMoneyMinor(money.payMinor, money.currency, locale)
		},
		unpriced: _(t`No rate`),
	}
}

function totalPay(totals: RowTotals, locale: string): string | null {
	if (!totals.payMinorByCurrency) return null
	const parts = Object.entries(totals.payMinorByCurrency)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([currency, minor]) => formatMoneyMinor(minor, currency, locale))
	return parts.length > 0 ? parts.join(' + ') : null
}

function Hours({ minutes, locale }: { minutes: number; locale: string }) {
	return minutes > 0 ? (
		<span className="tabular-nums">{formatHours(minutes, locale)}</span>
	) : (
		<EmptyValue />
	)
}

function Overtime({
	card,
	locale,
}: {
	card: Pick<TimesheetCardRow, 'minutes'>
	locale: string
}) {
	const { overtimeMinutes, doubleTimeMinutes } = card.minutes
	if (overtimeMinutes + doubleTimeMinutes === 0) return <EmptyValue />
	return (
		<span className="flex flex-wrap items-center justify-end gap-1">
			{overtimeMinutes > 0 ? (
				<OvertimeChip hours={formatHours(overtimeMinutes, locale)} />
			) : null}
			{doubleTimeMinutes > 0 ? (
				<OvertimeChip hours={`${formatHours(doubleTimeMinutes, locale)} x2`} />
			) : null}
		</span>
	)
}

/** What names the row, given what the group already says. */
function useRowIdentity(
	by: TimesheetGroup,
	locale: string,
	scopeNames: ReadonlyMap<string, string>,
	showScope: boolean,
) {
	return (row: TimesheetRow) => {
		const { person, card } = row
		const position = positionLabel(card, locale)
		const place = showScope ? scopeNames.get(card.scopeId) : undefined
		if (by === 'person') {
			return {
				primary: formatDateLabel(card.localDate, locale),
				secondary: [position, place].filter(Boolean).join(' · '),
			}
		}
		if (by === 'date') {
			return {
				primary: displayName(person, locale),
				secondary: [position, place].filter(Boolean).join(' · '),
			}
		}
		return {
			primary: displayName(person, locale),
			secondary: [formatDateLabel(card.localDate, locale), place]
				.filter(Boolean)
				.join(' · '),
		}
	}
}

function groupTitle(group: RowGroup, locale: string, none: string): string {
	if (group.by === 'person' && group.person) {
		return displayName(group.person, locale)
	}
	if (group.by === 'date' && group.date) {
		return formatDateLabel(group.date, locale, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
		})
	}
	return group.positionName ?? none
}

export function TimesheetList(props: TimesheetListProps) {
	return props.layout === 'cards' ? (
		<CardList {...props} />
	) : (
		<TimesheetTable {...props} />
	)
}

// ---------------------------------------------------------------------------
// Table (room for columns)
// ---------------------------------------------------------------------------

function TimesheetTable({
	groups,
	by,
	locale,
	scopeNames,
	showScope,
	showMoney,
	selectable,
	selected,
	onToggle,
	onToggleGroup,
	cardHref,
	totals,
}: TimesheetListProps) {
	const { _ } = useLingui()
	const text = useCardText(locale)
	const identify = useRowIdentity(by, locale, scopeNames, showScope)
	const none = _(t`No position`)
	const lead = selectable ? 1 : 0
	const grandPay = showMoney ? totalPay(totals, locale) : null

	return (
		<Table>
			<TableCaption className="sr-only">
				<Trans>Time cards</Trans>
			</TableCaption>
			<TableHeader className="sticky top-0 z-10">
				<TableRow>
					{selectable ? (
						<TableHead className="w-10">
							<span className="sr-only">
								<Trans>Select</Trans>
							</span>
						</TableHead>
					) : null}
					<TableHead>
						{by === 'person' ? <Trans>Date</Trans> : <Trans>Person</Trans>}
					</TableHead>
					<TableHead>
						<Trans>In</Trans>
					</TableHead>
					<TableHead>
						<Trans>Out</Trans>
					</TableHead>
					<TableHead className="text-end">
						<Trans>Break</Trans>
					</TableHead>
					<TableHead className="text-end">
						<Trans>Hours</Trans>
					</TableHead>
					<TableHead className="text-end">
						<Trans>Overtime</Trans>
					</TableHead>
					{showMoney ? (
						<TableHead className="text-end">
							<Trans>Est. pay</Trans>
						</TableHead>
					) : null}
					<TableHead>
						<Trans>Status</Trans>
					</TableHead>
				</TableRow>
			</TableHeader>
			{groups.map((group) => {
				const ids = group.rows.map((row) => row.card.id)
				const allSelected = ids.every((id) => selected.has(id))
				const title = groupTitle(group, locale, none)
				const groupPay = showMoney ? totalPay(group.totals, locale) : null
				return (
					<TableBody key={group.key}>
						<TableRow className="bg-muted/40">
							{selectable ? (
								<TableCell className="ps-3">
									<Checkbox
										checked={allSelected}
										onCheckedChange={(on) => onToggleGroup(ids, on)}
										aria-label={_(t`Select all of ${title}`)}
									/>
								</TableCell>
							) : null}
							<th
								scope="rowgroup"
								colSpan={3}
								className="p-2 text-start text-sm font-medium"
							>
								{title}
								<span className="text-muted-foreground ms-2 text-xs font-normal">
									{group.rows.length}
								</span>
							</th>
							<TableCell />
							<TableCell className="text-end font-medium">
								<Hours minutes={group.totals.paidMinutes} locale={locale} />
							</TableCell>
							<TableCell className="text-end">
								<Overtime card={{ minutes: group.totals }} locale={locale} />
							</TableCell>
							{showMoney ? (
								<TableCell className="text-end tabular-nums">
									{groupPay ?? <EmptyValue />}
								</TableCell>
							) : null}
							<TableCell />
						</TableRow>
						{group.rows.map((row) => {
							const { card } = row
							const identity = identify(row)
							const primary = identity.primary
							const range = text.range(card)
							const pay = text.pay(card)
							const name = displayName(row.person, locale)
							return (
								<TableRow
									key={card.id}
									data-state={selected.has(card.id) ? 'selected' : undefined}
									className="group/row"
								>
									{selectable ? (
										<TableCell className="ps-3">
											<Checkbox
												checked={selected.has(card.id)}
												onCheckedChange={() => onToggle(card.id)}
												aria-label={_(t`Select ${name}, ${primary}`)}
											/>
										</TableCell>
									) : null}
									<TableCell className="whitespace-normal">
										<Link
											to={cardHref(card.id)}
											className="focus-visible:ring-ring/50 -mx-1 flex min-h-11 flex-col justify-center rounded px-1 outline-none focus-visible:ring-3 md:min-h-9"
										>
											<span className="font-medium">{identity.primary}</span>
											{identity.secondary ? (
												<span className="text-muted-foreground text-xs">
													{identity.secondary}
												</span>
											) : null}
										</Link>
									</TableCell>
									<TableCell className="tabular-nums">{range.from}</TableCell>
									<TableCell className="tabular-nums">
										{range.to ? (
											<>
												{range.to}
												{range.next > 0 ? (
													<span className="text-muted-foreground ms-1 text-xs">
														+{range.next}
													</span>
												) : null}
											</>
										) : (
											<span className="text-muted-foreground">
												<Trans>Open</Trans>
											</span>
										)}
									</TableCell>
									<TableCell className="text-end tabular-nums">
										{card.minutes.unpaidBreakMinutes > 0 ? (
											<>
												{card.minutes.unpaidBreakMinutes}
												<span className="text-muted-foreground ms-0.5 text-xs">
													<Trans>m</Trans>
												</span>
											</>
										) : (
											<EmptyValue />
										)}
									</TableCell>
									<TableCell className="text-end">
										<Hours minutes={card.minutes.paidMinutes} locale={locale} />
									</TableCell>
									<TableCell className="text-end">
										<Overtime card={card} locale={locale} />
									</TableCell>
									{showMoney ? (
										<TableCell className="text-end tabular-nums">
											{pay ?? (
												<span className="text-muted-foreground text-xs">
													{text.unpriced}
												</span>
											)}
										</TableCell>
									) : null}
									<TableCell className="whitespace-normal">
										<div className="flex flex-col items-start gap-1">
											<StatusBadge status={card.status} />
											<IssueChips issues={card.issues} />
											{card.figuresChanged ? <FiguresChanged /> : null}
										</div>
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				)
			})}
			<TableFooter>
				<TableRow>
					<th
						scope="row"
						colSpan={lead + 4}
						className="p-2 text-start text-sm font-medium"
					>
						<Trans>Total</Trans>
						<span className="text-muted-foreground ms-2 text-xs font-normal">
							{totals.cards}
						</span>
					</th>
					<TableCell className="text-end font-medium">
						<Hours minutes={totals.paidMinutes} locale={locale} />
					</TableCell>
					<TableCell className="text-end">
						<Overtime card={{ minutes: totals }} locale={locale} />
					</TableCell>
					{showMoney ? (
						<TableCell className="text-end font-medium tabular-nums">
							{grandPay ?? <EmptyValue />}
						</TableCell>
					) : null}
					<TableCell />
				</TableRow>
			</TableFooter>
		</Table>
	)
}

function FiguresChanged() {
	const { _ } = useLingui()
	return (
		<span
			className="text-muted-foreground text-xs"
			title={_(
				t`Overtime moved after this card was approved. Reopen it to review the new figures before you pay.`,
			)}
		>
			<Trans>Figures changed</Trans>
		</span>
	)
}

// ---------------------------------------------------------------------------
// Stacked cards (narrow rooms)
// ---------------------------------------------------------------------------

function CardList({
	groups,
	by,
	locale,
	scopeNames,
	showScope,
	showMoney,
	selectable,
	selected,
	onToggle,
	onToggleGroup,
	cardHref,
	totals,
}: TimesheetListProps) {
	const { _ } = useLingui()
	const text = useCardText(locale)
	const identify = useRowIdentity(by, locale, scopeNames, showScope)
	const none = _(t`No position`)
	const grandPay = showMoney ? totalPay(totals, locale) : null

	return (
		<div className="flex flex-col gap-5">
			{groups.map((group) => {
				const ids = group.rows.map((row) => row.card.id)
				const allSelected = ids.every((id) => selected.has(id))
				const title = groupTitle(group, locale, none)
				const groupPay = showMoney ? totalPay(group.totals, locale) : null
				return (
					<section key={group.key} aria-label={title}>
						<div className="flex min-h-11 items-center gap-3 px-1">
							{selectable ? (
								<Checkbox
									checked={allSelected}
									onCheckedChange={(on) => onToggleGroup(ids, on)}
									aria-label={_(t`Select all of ${title}`)}
								/>
							) : null}
							<h3 className="min-w-0 flex-1 truncate text-sm font-medium">
								{title}
							</h3>
							<span className="text-muted-foreground flex items-center gap-2 text-xs tabular-nums">
								<span>{formatHours(group.totals.paidMinutes, locale)}</span>
								{group.totals.overtimeMinutes > 0 ? (
									<OvertimeChip
										hours={formatHours(group.totals.overtimeMinutes, locale)}
									/>
								) : null}
								{groupPay ? <span>{groupPay}</span> : null}
							</span>
						</div>
						<ItemGroup className="gap-2">
							{group.rows.map((row) => {
								const { card } = row
								const identity = identify(row)
								const primary = identity.primary
								const range = text.range(card)
								const pay = text.pay(card)
								const name = displayName(row.person, locale)
								return (
									<Item
										key={card.id}
										variant={selected.has(card.id) ? 'muted' : 'outline'}
										data-state={selected.has(card.id) ? 'selected' : undefined}
										className="items-start"
									>
										{selectable ? (
											<Checkbox
												className="mt-1"
												checked={selected.has(card.id)}
												onCheckedChange={() => onToggle(card.id)}
												aria-label={_(t`Select ${name}, ${primary}`)}
											/>
										) : null}
										<ItemContent className="min-w-0 flex-1">
											<div className="flex flex-col gap-1.5">
												<Link
													to={cardHref(card.id)}
													className="focus-visible:ring-ring/50 -m-1 flex min-h-11 items-start justify-between gap-3 rounded p-1 outline-none focus-visible:ring-3"
												>
													<span className="flex min-w-0 flex-col">
														<span className="truncate text-sm font-medium">
															{identity.primary}
														</span>
														{identity.secondary ? (
															<span className="text-muted-foreground truncate text-xs">
																{identity.secondary}
															</span>
														) : null}
													</span>
													<span className="flex shrink-0 flex-col items-end text-sm tabular-nums">
														<span className="font-medium">
															{formatHours(card.minutes.paidMinutes, locale)}
														</span>
														{pay ? (
															<span className="text-muted-foreground text-xs">
																{pay}
															</span>
														) : showMoney ? (
															<span className="text-muted-foreground text-xs">
																{text.unpriced}
															</span>
														) : null}
													</span>
												</Link>
												<p className="text-muted-foreground text-xs tabular-nums">
													{range.from} –{' '}
													{range.to ? (
														<>
															{range.to}
															{range.next > 0 ? ` +${range.next}` : ''}
														</>
													) : (
														<Trans>Open</Trans>
													)}
													{card.minutes.unpaidBreakMinutes > 0
														? ` · ${card.minutes.unpaidBreakMinutes}${_(t`m`)} ${_(t`break`)}`
														: ''}
												</p>
												<div className="flex flex-wrap items-center gap-1.5">
													<StatusBadge status={card.status} />
													<IssueChips issues={card.issues} />
													{card.minutes.overtimeMinutes > 0 ? (
														<OvertimeChip
															hours={formatHours(
																card.minutes.overtimeMinutes,
																locale,
															)}
														/>
													) : null}
													{card.figuresChanged ? <FiguresChanged /> : null}
												</div>
											</div>
										</ItemContent>
									</Item>
								)
							})}
						</ItemGroup>
					</section>
				)
			})}
			<p className="flex items-center justify-between gap-3 px-1 text-sm font-medium">
				<span>
					<Trans>Total</Trans>
					<span className="text-muted-foreground ms-2 text-xs font-normal">
						{totals.cards}
					</span>
				</span>
				<span className="flex items-center gap-2 tabular-nums">
					{formatHours(totals.paidMinutes, locale)}
					{grandPay ? <span>{grandPay}</span> : null}
				</span>
			</p>
		</div>
	)
}
