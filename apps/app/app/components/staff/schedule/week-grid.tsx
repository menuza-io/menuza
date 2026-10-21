import { useDroppable } from '@dnd-kit/core'
import { Plural, Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PositionDot } from '@repo/ui/position-color'
import { memo, useCallback, useMemo } from 'react'
import { Link, useParams } from 'react-router'
import { dayShares, hasShareRow } from '#app/utils/staffing/schedule-labor.ts'
import {
	type ScheduleOverlayRow,
	type ScheduleShiftRow,
} from '#app/utils/staffing/schedule-types.ts'
import {
	cellDropId,
	cellNotes,
	footerFor,
	formatDuration,
	OPEN_ROW,
	positionName,
	type GridRow,
} from '#app/utils/staffing/schedule-view.ts'
import {
	formatMoneyMinor,
	staffDisplayName,
} from '#app/utils/staffing/staff-format.ts'
import {
	formatDateLabel,
	formatPeriodLabel,
} from '#app/utils/staffing/timesheet-view.ts'
import { type BoardProps, type CellRef } from './board-types.ts'
import { DemandBars } from './demand-strip.tsx'
import { bookedUnitsOf, ForecastCells, ShareCell } from './forecast-strip.tsx'
import { ScheduleDnd } from './schedule-dnd.tsx'
import { ShiftBlock } from './shift-block.tsx'
import { useBlockKeys } from './use-block-keys.ts'

const COLUMN_COUNT = 7

type CellProps = {
	row: GridRow
	date: string
	overlay: ScheduleOverlayRow | undefined
	canWrite: boolean
	hasClip: boolean
	rowLabel: string
	dayLabel: string
	today: boolean
	children: React.ReactNode
	onAdd: (cell: CellRef) => void
	onPaste: (cell: CellRef) => void
}

/** One person's day: a drop target holding that day's shifts. */
const GridCell = memo(function GridCell({
	row,
	date,
	overlay,
	canWrite,
	hasClip,
	rowLabel,
	dayLabel,
	today,
	children,
	onAdd,
	onPaste,
}: CellProps) {
	const { _ } = useLingui()
	const { setNodeRef, isOver } = useDroppable({
		id: cellDropId(row.key, date),
		disabled: !canWrite,
	})
	const notes = row.person ? cellNotes(overlay, date) : null
	const empty = !row.cells.get(date)?.length
	const cell: CellRef = { rowKey: row.key, date }
	return (
		<td
			ref={setNodeRef}
			data-cell=""
			className={cn(
				'group/cell border-border relative min-w-30 border-s p-1 align-top',
				today && 'bg-primary/5',
				notes?.unavailable && 'bg-muted/50',
				isOver &&
					'bg-primary/10 outline-primary/50 outline-2 -outline-offset-2',
			)}
		>
			<div className="flex flex-col gap-1">
				{notes?.timeOff ? (
					<span
						className={cn(
							'inline-flex h-5 w-fit max-w-full items-center gap-1 rounded-4xl px-2 text-xs',
							notes.timeOff === 'approved'
								? 'bg-muted text-foreground'
								: 'border-border text-muted-foreground border border-dashed',
						)}
					>
						<span className="truncate">
							{notes.timeOff === 'approved'
								? _(t`Time off`)
								: _(t`Time off asked`)}
						</span>
					</span>
				) : notes?.unavailable ? (
					<span className="text-muted-foreground text-xs">
						{_(t`Unavailable`)}
					</span>
				) : null}
				{children}
				{canWrite ? (
					<div
						className={cn(
							'flex gap-1',
							// Empty cells are one big tap target; busy ones keep a small row below the shifts.
							empty ? 'min-h-11' : 'pointer-coarse:flex',
							!empty &&
								'hidden group-focus-within/cell:flex group-hover/cell:flex',
						)}
					>
						<Button
							type="button"
							variant="ghost"
							tabIndex={-1}
							onClick={() => onAdd(cell)}
							aria-label={_(t`Add a shift for ${rowLabel} on ${dayLabel}`)}
							className={cn(
								'flex-1 rounded-md',
								empty
									? 'min-h-11 opacity-0 group-focus-within/cell:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100'
									: 'h-8 pointer-coarse:h-11',
							)}
						>
							<Icon name="plus" className="size-4" aria-hidden="true" />
						</Button>
						{hasClip ? (
							<Button
								type="button"
								variant="ghost"
								tabIndex={-1}
								onClick={() => onPaste(cell)}
								aria-label={_(
									t`Paste the copied shift for ${rowLabel} on ${dayLabel}`,
								)}
								className="w-9 rounded-md pointer-coarse:min-h-11"
							>
								<Icon name="copy" className="size-4" aria-hidden="true" />
							</Button>
						) : null}
					</div>
				) : null}
			</div>
		</td>
	)
})

/**
 * The week as people by days: group headings by position, an open-shifts row,
 * a demand strip above and totals below. Drafts are dashed, conflicts are red
 * flags that never block, and every shift moves by pointer, touch or keyboard.
 */
export function WeekGrid(props: BoardProps) {
	const {
		week,
		scopeName,
		grid,
		positions,
		locale,
		rtl,
		today,
		group,
		canWrite,
		showConflicts,
		showCost,
		demand,
		forecast,
		clip,
		busyShiftId,
		onOpenShift,
		onAddShift,
		onPaste,
		onCopyShift,
		onChangeShift,
		onPickDate,
	} = props
	const { _ } = useLingui()
	const overlays = useMemo(
		() => new Map(week.overlays.map((overlay) => [overlay.staffId, overlay])),
		[week.overlays],
	)
	const shiftsById = useMemo(
		() => new Map(week.shifts.map((shift) => [shift.id, shift])),
		[week.shifts],
	)
	const nameOf = useCallback(
		(row: GridRow) =>
			row.person ? staffDisplayName(row.person, locale) : _(t`Open shifts`),
		[_, locale],
	)
	const rowsByKey = useMemo(() => {
		const map = new Map<string, GridRow>([[OPEN_ROW, grid.open]])
		for (const g of grid.groups) for (const row of g.rows) map.set(row.key, row)
		return map
	}, [grid])
	const longDay = useCallback(
		(date: string) =>
			formatDateLabel(date, locale, {
				weekday: 'long',
				month: 'long',
				day: 'numeric',
			}),
		[locale],
	)
	const describeCell = useCallback(
		(rowKey: string, date: string) => {
			const row = rowsByKey.get(rowKey)
			const name = row ? nameOf(row) : ''
			return `${name}, ${longDay(date)}`
		},
		[longDay, nameOf, rowsByKey],
	)
	const onKeyAction = useBlockKeys({
		canWrite,
		onCopyShift,
		onPaste,
		onChangeShift,
	})
	const demandByDate = useMemo(
		() => new Map((demand ?? []).map((day) => [day.date, day])),
		[demand],
	)
	const forecastByDate = useMemo(
		() => new Map((forecast?.days ?? []).map((day) => [day.date, day])),
		[forecast],
	)
	const { orgSlug } = useParams()
	const showForecast = forecast !== null && forecast.configured
	// People already booked show even before any standard is set.
	const hasBookedUnits =
		forecast?.days.some((day) => bookedUnitsOf(day) > 0) ?? false
	const showForecastRow = showForecast || hasBookedUnits
	const showShare = showCost && hasShareRow(week)
	const openDayLabel = (date: string) => {
		const day = longDay(date)
		return _(t`Open ${day} as a day`)
	}
	const hasMoney =
		showCost && week.footers.some((footer) => footer.costMinorByCurrency)
	const sourceNote =
		week.laborTarget?.salesSource === 'manual'
			? _(t`Entered sales`)
			: week.laborTarget?.salesSource === 'online_only'
				? _(t`Online orders (all sales)`)
				: _(t`Online orders only, not all sales`)

	const renderShifts = (row: GridRow, date: string, hidePosition: boolean) =>
		(row.cells.get(date) ?? []).map((shift: ScheduleShiftRow) => (
			<ShiftBlock
				key={shift.id}
				shift={shift}
				position={
					shift.positionId ? positions.get(shift.positionId) : undefined
				}
				showConflicts={showConflicts}
				showCost={showCost}
				hidePosition={hidePosition}
				draggable={canWrite}
				busy={busyShiftId === shift.id}
				onOpen={onOpenShift}
				onKeyAction={onKeyAction}
			/>
		))

	const renderRow = (row: GridRow, hidePosition: boolean) => {
		const rowLabel = nameOf(row)
		return (
			<tr key={row.key} className="border-border border-t">
				<th
					scope="row"
					className="bg-background border-border sticky start-0 z-10 w-44 min-w-44 p-2 text-start align-top font-normal"
				>
					{row.person ? (
						<div className="flex flex-col">
							<span className="truncate text-sm font-medium">{rowLabel}</span>
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatDuration(row.person.weekMinutes)}
								{row.person.overtimeMinutes > 0 ? (
									<>
										{' · '}
										<span className="text-destructive">
											<Overtime minutes={row.person.overtimeMinutes} />
										</span>
									</>
								) : null}
								{row.person.status === 'on_leave' ? (
									<>
										{' · '}
										<Trans>On leave</Trans>
									</>
								) : null}
							</span>
						</div>
					) : (
						<div className="flex flex-col">
							<span className="text-sm font-medium">
								<Trans>Open shifts</Trans>
							</span>
							<span className="text-muted-foreground text-xs">
								<Trans>Nobody assigned yet</Trans>
							</span>
						</div>
					)}
				</th>
				{week.dates.map((date) => (
					<GridCell
						key={date}
						row={row}
						date={date}
						overlay={row.person ? overlays.get(row.person.id) : undefined}
						canWrite={canWrite}
						hasClip={clip !== null}
						rowLabel={rowLabel}
						dayLabel={longDay(date)}
						today={date === today}
						onAdd={onAddShift}
						onPaste={onPaste}
					>
						{renderShifts(row, date, hidePosition)}
					</GridCell>
				))}
			</tr>
		)
	}

	return (
		<ScheduleDnd
			shifts={shiftsById}
			positions={positions}
			rtl={rtl}
			showConflicts={showConflicts}
			showCost={showCost}
			describeCell={describeCell}
			onChange={onChangeShift}
		>
			<div
				data-print-root=""
				className="border-border max-h-[75dvh] overflow-auto rounded-lg border print:max-h-none print:overflow-visible"
			>
				<table className="w-full min-w-250 border-collapse text-sm">
					<caption className="sr-only print:not-sr-only print:pb-2 print:text-start print:text-base print:font-semibold">
						<PrintTitle
							name={scopeName}
							range={formatPeriodLabel(week.weekStart, week.weekEnd, locale)}
						/>
					</caption>
					<thead className="bg-background sticky top-0 z-20">
						<tr>
							<th
								scope="col"
								className="bg-background sticky start-0 z-30 w-44 min-w-44 p-2 text-start text-xs font-medium"
							>
								<span className="text-muted-foreground">
									<Trans>Team</Trans>
								</span>
							</th>
							{week.dates.map((date) => {
								const isToday = date === today
								return (
									<th
										key={date}
										scope="col"
										className={cn(
											'border-border min-w-30 border-s p-0 text-start font-normal',
											isToday && 'bg-primary/5',
										)}
									>
										<Button
											type="button"
											variant="ghost"
											onClick={() => onPickDate(date, 'day')}
											aria-label={openDayLabel(date)}
											className="h-auto min-h-11 w-full flex-col items-start justify-center rounded-md px-2 py-1 text-start font-normal print:hover:bg-transparent"
										>
											<span
												className={cn(
													'text-xs font-medium',
													isToday ? 'text-primary' : 'text-muted-foreground',
												)}
											>
												{formatDateLabel(date, locale, { weekday: 'short' })}
											</span>
											<span
												className={cn(
													'text-sm font-semibold tabular-nums',
													isToday && 'text-primary',
												)}
											>
												{formatDateLabel(date, locale, {
													month: 'short',
													day: 'numeric',
												})}
											</span>
										</Button>
									</th>
								)
							})}
						</tr>
						{demand && demand.length > 0 ? (
							<tr className="border-border border-t">
								<th
									scope="row"
									className="bg-background sticky start-0 z-30 w-44 min-w-44 p-2 text-start align-bottom text-xs font-normal"
								>
									<span className="text-muted-foreground">
										<Trans>Typical online orders</Trans>
									</span>
								</th>
								{week.dates.map((date) => {
									const day = demandByDate.get(date)
									return (
										<td
											key={date}
											className="border-border border-s px-1 pt-1 pb-1.5"
										>
											{day ? <DemandBars day={day} /> : null}
										</td>
									)
								})}
							</tr>
						) : null}
						{showForecastRow ? (
							<tr className="border-border border-t">
								<th
									scope="row"
									className="bg-background sticky start-0 z-30 w-44 min-w-44 p-2 text-start align-bottom text-xs font-normal"
								>
									<span className="text-muted-foreground">
										{showForecast ? (
											<Trans>Coverage against typical orders</Trans>
										) : (
											<Trans>Booked ahead</Trans>
										)}
									</span>
								</th>
								{week.dates.map((date) => {
									const day = forecastByDate.get(date)
									return (
										<td
											key={date}
											className="border-border border-s px-1 pt-1 pb-1.5 align-top"
										>
											{day ? (
												<ForecastCells day={day} configured={showForecast} />
											) : null}
										</td>
									)
								})}
							</tr>
						) : null}
					</thead>

					<tbody>
						{renderRow(grid.open, false)}
						{grid.groups.map((g) => (
							<GroupRows
								key={g.key}
								label={
									g.position
										? positionName(g.position, locale)
										: group === 'none'
											? null
											: _(t`No position`)
								}
								colorKey={g.position?.colorKey}
								count={g.rows.length}
							>
								{g.rows.map((row) =>
									renderRow(row, group === 'position' && g.position !== null),
								)}
							</GroupRows>
						))}
					</tbody>

					<tfoot className="bg-muted/40">
						<tr className="border-border border-t">
							<th
								scope="row"
								className="bg-muted sticky start-0 z-10 w-44 min-w-44 p-2 text-start text-xs font-medium"
							>
								<Trans>Hours and people</Trans>
							</th>
							{week.dates.map((date) => {
								const footer = footerFor(week, date)
								return (
									<td
										key={date}
										className="border-border border-s px-2 py-1.5 align-top text-xs tabular-nums"
									>
										<div className="font-medium">
											{formatDuration(footer.minutes)}
										</div>
										<div className="text-muted-foreground">
											<Plural
												value={footer.headcount}
												one="# person"
												other="# people"
											/>
										</div>
										{footer.openShifts > 0 ? (
											<div className="text-foreground">
												<Plural
													value={footer.openShifts}
													one="# open shift"
													other="# open shifts"
												/>
											</div>
										) : null}
										{footer.overtimeMinutes > 0 ? (
											<div className="text-destructive">
												<Overtime minutes={footer.overtimeMinutes} />
											</div>
										) : null}
									</td>
								)
							})}
						</tr>
						{hasMoney ? (
							<tr className="border-border border-t">
								<th
									scope="row"
									className="bg-muted sticky start-0 z-10 w-44 min-w-44 p-2 text-start text-xs font-medium"
								>
									<Trans>Estimated labor cost</Trans>
								</th>
								{week.dates.map((date) => {
									const footer = footerFor(week, date)
									const entries = Object.entries(
										footer.costMinorByCurrency ?? {},
									)
									return (
										<td
											key={date}
											className="border-border border-s px-2 py-1.5 align-top text-xs tabular-nums"
										>
											{entries.map(([currency, minor]) => (
												<div key={currency}>
													{formatMoneyMinor(minor, currency, locale)}
												</div>
											))}
										</td>
									)
								})}
							</tr>
						) : null}
						{showShare ? (
							<tr className="border-border border-t">
								<th
									scope="row"
									className="bg-muted sticky start-0 z-10 w-44 min-w-44 p-2 text-start text-xs font-medium"
								>
									<Trans>Labor share of typical sales</Trans>
									<span className="text-muted-foreground block font-normal">
										{sourceNote}
									</span>
								</th>
								{week.dates.map((date) => {
									const footer = footerFor(week, date)
									return (
										<td
											key={date}
											className="border-border border-s px-2 py-1.5 align-top text-xs"
										>
											<ShareCell
												shares={dayShares(week, date)}
												costByCurrency={footer.costMinorByCurrency ?? {}}
												locale={locale}
											/>
										</td>
									)
								})}
							</tr>
						) : null}
					</tfoot>
				</table>
			</div>
			<p className="text-muted-foreground mt-2 text-xs print:hidden">
				{hasMoney ? (
					<Trans>
						Costs are estimates from pay rates and scheduled hours. They are not
						payroll.
					</Trans>
				) : (
					<Trans>Hours are scheduled hours, not worked hours.</Trans>
				)}{' '}
				{grid.hiddenCount > 0
					? plural(grid.hiddenCount, {
							one: '# person is hidden from the schedule.',
							other: '# people are hidden from the schedule.',
						})
					: null}
			</p>
			{showShare && week.laborTarget && !week.laborTarget.targetColoring ? (
				<p className="text-muted-foreground mt-1 text-xs text-pretty print:hidden">
					<Trans>
						The labor share only counts online orders, so it is higher than it
						really is and is not judged against your target.
					</Trans>
				</p>
			) : null}
			{showForecast ? (
				<p className="text-muted-foreground mt-1 text-xs text-pretty print:hidden">
					<Trans>
						Coverage compares the orders you usually get each hour with who is
						scheduled. Red is short of your staffing standards, grey is clearly
						over.
					</Trans>
				</p>
			) : forecast && !forecast.configured && orgSlug ? (
				<p className="text-muted-foreground mt-1 text-xs text-pretty print:hidden">
					<Trans>
						To see coverage against the orders you usually get, set how many
						orders one person handles in an hour.
					</Trans>{' '}
					<Link
						to={`/${orgSlug}/staff/labor?view=settings`}
						className="text-foreground underline underline-offset-2"
					>
						<Trans>Set it in Labor settings</Trans>
					</Link>
				</p>
			) : null}
		</ScheduleDnd>
	)
}

function Overtime({ minutes }: { minutes: number }) {
	const text = formatDuration(minutes)
	return <Trans>{text} overtime</Trans>
}

function GroupRows({
	label,
	colorKey,
	count,
	children,
}: {
	label: string | null
	colorKey: string | undefined
	count: number
	children: React.ReactNode
}) {
	if (label === null) return <>{children}</>
	return (
		<>
			<tr className="bg-muted/40 border-border border-t">
				<th
					scope="rowgroup"
					colSpan={COLUMN_COUNT + 1}
					className="sticky start-0 px-2 py-1.5 text-start text-xs font-medium"
				>
					<span className="inline-flex items-center gap-2">
						{colorKey ? <PositionDot colorKey={colorKey} /> : null}
						<span>{label}</span>
						<span className="text-muted-foreground font-normal tabular-nums">
							{count}
						</span>
					</span>
				</th>
			</tr>
			{children}
		</>
	)
}

/** The table's name: read aloud, and printed as the page heading. */
export function PrintTitle({ name, range }: { name: string; range: string }) {
	return (
		<Trans>
			Schedule for {name}, {range}
		</Trans>
	)
}
