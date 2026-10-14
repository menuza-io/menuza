import { useDraggable, useDroppable } from '@dnd-kit/core'
import { Plural, Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { localMinuteOfDay } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { positionBlockClass, PositionDot } from '@repo/ui/position-color'
import { type CSSProperties, memo, useCallback, useMemo, useState } from 'react'
import {
	type SchedulePositionRow,
	type ScheduleShiftRow,
} from '#app/utils/staffing/schedule-types.ts'
import {
	cellDropId,
	footerFor,
	formatDuration,
	formatHourOfDay,
	formatShiftRange,
	OPEN_ROW,
	positionName,
	resizeTimes,
	shiftDragId,
	TIME_STEP_MINUTES,
	wallLengthMinutes,
	type GridRow,
} from '#app/utils/staffing/schedule-view.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'
import { type BoardProps, type CellRef } from './board-types.ts'
import { ScheduleDnd } from './schedule-dnd.tsx'
import { useShiftLabel } from './shift-block.tsx'
import { useBlockKeys } from './use-block-keys.ts'
import { PrintTitle } from './week-grid.tsx'

/** Pixels per hour on the timeline; wide enough for a finger on a tablet. */
const HOUR_PX = 56
const PX_PER_MINUTE = HOUR_PX / 60
const NAME_COLUMN = 'w-44 min-w-44'

type Range = { from: number; to: number }

/** The hours shown: 8 to midnight by default, wider when a shift starts earlier or ends later. */
function visibleRange(shifts: readonly ScheduleShiftRow[]): Range {
	let from = 8
	let to = 24
	for (const shift of shifts) {
		const start = localMinuteOfDay(shift.startsAt, shift.timeZone)
		from = Math.min(from, Math.floor(start / 60))
	}
	return { from: Math.max(0, from), to }
}

type TimelineShiftProps = {
	shift: ScheduleShiftRow
	position: SchedulePositionRow | undefined
	range: Range
	rtl: boolean
	locale: string
	showConflicts: boolean
	canWrite: boolean
	busy: boolean
	hidePosition: boolean
	onOpen: (shift: ScheduleShiftRow) => void
	onChange: BoardProps['onChangeShift']
	onKeyAction: ReturnType<typeof useBlockKeys>
}

/** A shift as a bar on the timeline: drag to move, drag an end to resize. */
const TimelineShift = memo(function TimelineShift({
	shift,
	position,
	range,
	rtl,
	locale,
	showConflicts,
	canWrite,
	busy,
	hidePosition,
	onOpen,
	onChange,
	onKeyAction,
}: TimelineShiftProps) {
	const label = useShiftLabel()
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: shiftDragId(shift.id),
		disabled: !canWrite || busy,
	})
	const [preview, setPreview] = useState<{
		edge: 'start' | 'end'
		px: number
	} | null>(null)
	const start = localMinuteOfDay(shift.startsAt, shift.timeZone)
	const length = wallLengthMinutes(shift)
	const visibleLength = Math.min(length, range.to * 60 - start)
	let left = (start - range.from * 60) * PX_PER_MINUTE
	let width = Math.max(
		visibleLength * PX_PER_MINUTE,
		TIME_STEP_MINUTES * PX_PER_MINUTE,
	)
	if (preview) {
		// The preview follows the pointer; the real change is sent on release.
		const delta = rtl ? -preview.px : preview.px
		if (preview.edge === 'end')
			width = Math.max(width + delta, TIME_STEP_MINUTES * PX_PER_MINUTE)
		else {
			const moved = Math.min(delta, width - TIME_STEP_MINUTES * PX_PER_MINUTE)
			left += moved
			width -= moved
		}
	}
	const flagged = showConflicts && shift.conflicts.length > 0
	const clipped = start + length > range.to * 60

	const startResize =
		(edge: 'start' | 'end') => (event: React.PointerEvent) => {
			if (!canWrite || busy || event.button !== 0) return
			event.stopPropagation()
			event.preventDefault()
			const target = event.currentTarget as HTMLElement
			target.setPointerCapture(event.pointerId)
			const originX = event.clientX
			const move = (e: PointerEvent) =>
				setPreview({ edge, px: e.clientX - originX })
			const finish = (e: PointerEvent) => {
				target.removeEventListener('pointermove', move)
				target.removeEventListener('pointerup', finish)
				target.removeEventListener('pointercancel', cancel)
				setPreview(null)
				const minutes = ((e.clientX - originX) / PX_PER_MINUTE) * (rtl ? -1 : 1)
				const times = resizeTimes(shift, edge, minutes)
				if (times) onChange(shift, { expectedVersion: shift.version, ...times })
			}
			const cancel = () => {
				target.removeEventListener('pointermove', move)
				target.removeEventListener('pointerup', finish)
				target.removeEventListener('pointercancel', cancel)
				setPreview(null)
			}
			target.addEventListener('pointermove', move)
			target.addEventListener('pointerup', finish)
			target.addEventListener('pointercancel', cancel)
		}

	const handle = (edge: 'start' | 'end') =>
		canWrite ? (
			<span
				aria-hidden="true"
				onPointerDown={startResize(edge)}
				className={cn(
					'absolute inset-y-0 z-10 w-3 cursor-ew-resize touch-none',
					edge === 'start' ? 'start-0' : 'end-0',
				)}
			>
				<span
					className={cn(
						'bg-foreground/30 absolute inset-y-2 w-0.5 rounded-full',
						edge === 'start' ? 'start-1' : 'end-1',
					)}
				/>
			</span>
		) : null

	return (
		<button
			ref={setNodeRef}
			type="button"
			data-shift-id={shift.id}
			aria-label={label(shift, position, showConflicts)}
			{...attributes}
			{...listeners}
			onClick={(event) => {
				event.stopPropagation()
				onOpen(shift)
			}}
			onKeyDown={(event) => {
				listeners?.onKeyDown?.(event)
				onKeyAction(event, shift)
			}}
			// Position and width are data, not styling.
			style={
				{ '--shift-start': `${left}px`, width: `${width}px` } as CSSProperties
			}
			className={cn(
				'absolute inset-y-1 start-(--shift-start) flex min-w-0 flex-col justify-center overflow-hidden rounded-md border px-3 text-start',
				'focus-visible:ring-ring/60 outline-none focus-visible:ring-2',
				positionBlockClass(position?.colorKey, shift.state === 'draft'),
				flagged && 'border-destructive/70',
				shift.state === 'cancel_pending' && 'line-through opacity-60',
				canWrite &&
					!busy &&
					'cursor-grab touch-manipulation active:cursor-grabbing',
				isDragging && 'opacity-40',
				busy && 'animate-pulse',
			)}
		>
			{handle('start')}
			<span className="flex items-center gap-1">
				<bdi className="truncate text-xs leading-4 font-medium tabular-nums">
					{formatShiftRange(shift, locale)}
				</bdi>
				{flagged ? (
					<Icon
						name="alert-triangle"
						className="text-destructive size-3.5 shrink-0"
						aria-hidden="true"
					/>
				) : null}
				{clipped ? (
					<span className="text-muted-foreground text-xs" aria-hidden="true">
						+1
					</span>
				) : null}
			</span>
			{!hidePosition && position ? (
				<span className="text-muted-foreground flex items-center gap-1 text-xs">
					<PositionDot colorKey={position.colorKey} className="size-2" />
					<span className="truncate">{positionName(position, locale)}</span>
				</span>
			) : null}
			{handle('end')}
		</button>
	)
})

function Lane({
	row,
	date,
	canWrite,
	width,
	hours,
	children,
	onAdd,
	label,
}: {
	row: GridRow
	date: string
	canWrite: boolean
	width: number
	hours: number[]
	children: React.ReactNode
	onAdd: (cell: CellRef) => void
	label: string
}) {
	const { _ } = useLingui()
	const { setNodeRef, isOver } = useDroppable({
		id: cellDropId(row.key, date),
		disabled: !canWrite,
	})
	return (
		<td className="border-border border-s p-0">
			<div
				ref={setNodeRef}
				// The lane's width is data: hours on screen times pixels per hour.
				style={{ width: `${width}px` }}
				className={cn('relative h-14', isOver && 'bg-primary/10')}
			>
				{hours.map((hour, index) => (
					<span
						key={hour}
						aria-hidden="true"
						style={{ '--hour-start': `${index * HOUR_PX}px` } as CSSProperties}
						className="border-border/60 absolute inset-y-0 start-(--hour-start) border-s"
					/>
				))}
				{canWrite ? (
					<Button
						type="button"
						variant="ghost"
						tabIndex={-1}
						onClick={() => onAdd({ rowKey: row.key, date })}
						aria-label={label}
						title={_(t`Add a shift`)}
						className="absolute inset-0 h-full w-full opacity-0 hover:opacity-100 focus-visible:opacity-100"
					>
						<Icon
							name="plus"
							className="text-muted-foreground mx-auto size-4"
							aria-hidden="true"
						/>
					</Button>
				) : null}
				{children}
			</div>
		</td>
	)
}

/**
 * One day as a timeline: people down the side, hours across, shifts as bars.
 * Drag a bar sideways to change its time, up or down to hand it to someone
 * else, and drag either end to resize it. Everything snaps to 15 minutes.
 */
export function DayTimeline(props: BoardProps & { date: string }) {
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
		busyShiftId,
		date,
		onOpenShift,
		onAddShift,
		onPaste,
		onCopyShift,
		onChangeShift,
	} = props
	const { _ } = useLingui()
	const dayShifts = useMemo(
		() => week.shifts.filter((shift) => shift.localDate === date),
		[week.shifts, date],
	)
	const shiftsById = useMemo(
		() => new Map(dayShifts.map((shift) => [shift.id, shift])),
		[dayShifts],
	)
	const range = useMemo(() => visibleRange(dayShifts), [dayShifts])
	const hours = useMemo(
		() =>
			Array.from(
				{ length: range.to - range.from },
				(ignored, i) => range.from + i,
			),
		[range],
	)
	const width = hours.length * HOUR_PX
	const footer = footerFor(week, date)
	const dayTitle = formatDateLabel(date, locale, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
	})
	const demandDay = demand?.find((day) => day.date === date)
	const onKeyAction = useBlockKeys({
		canWrite,
		onCopyShift,
		onPaste,
		onChangeShift,
	})

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
	const describeCell = useCallback(
		(rowKey: string, cellDate: string) => {
			const row = rowsByKey.get(rowKey)
			return `${row ? nameOf(row) : ''}, ${formatDateLabel(cellDate, locale, { weekday: 'long', month: 'long', day: 'numeric' })}`
		},
		[locale, nameOf, rowsByKey],
	)

	const renderRow = (row: GridRow, hidePosition: boolean) => {
		const shifts = row.cells.get(date) ?? []
		const rowLabel = nameOf(row)
		return (
			<tr key={row.key} className="border-border border-t">
				<th
					scope="row"
					className={cn(
						NAME_COLUMN,
						'bg-background sticky start-0 z-10 p-2 text-start align-middle font-normal',
					)}
				>
					<span className="block truncate text-sm font-medium">{rowLabel}</span>
					{row.person ? (
						<span className="text-muted-foreground text-xs tabular-nums">
							{formatDuration(row.person.weekMinutes)}
						</span>
					) : null}
				</th>
				<Lane
					row={row}
					date={date}
					canWrite={canWrite}
					width={width}
					hours={hours}
					onAdd={onAddShift}
					label={_(t`Add a shift for ${rowLabel}`)}
				>
					{shifts.map((shift) => (
						<TimelineShift
							key={shift.id}
							shift={shift}
							position={
								shift.positionId ? positions.get(shift.positionId) : undefined
							}
							range={range}
							rtl={rtl}
							locale={locale}
							showConflicts={showConflicts}
							canWrite={canWrite}
							busy={busyShiftId === shift.id}
							hidePosition={hidePosition}
							onOpen={onOpenShift}
							onChange={onChangeShift}
							onKeyAction={onKeyAction}
						/>
					))}
				</Lane>
			</tr>
		)
	}

	return (
		<ScheduleDnd
			shifts={shiftsById}
			positions={positions}
			rtl={rtl}
			pxPerMinute={PX_PER_MINUTE}
			showConflicts={showConflicts}
			showCost={showCost}
			describeCell={describeCell}
			onChange={onChangeShift}
		>
			<div className="flex flex-col gap-2" data-print-root="">
				<p className="text-muted-foreground text-sm tabular-nums">
					<span className="text-foreground font-medium">
						{formatDateLabel(date, locale, {
							weekday: 'long',
							month: 'long',
							day: 'numeric',
						})}
						{date === today ? (
							<>
								{' '}
								· <Trans>Today</Trans>
							</>
						) : null}
					</span>
					{' · '}
					<Plural value={footer.headcount} one="# person" other="# people" />
					{' · '}
					{formatDuration(footer.minutes)}
					{footer.openShifts > 0 ? (
						<>
							{' · '}
							<Plural
								value={footer.openShifts}
								one="# open shift"
								other="# open shifts"
							/>
						</>
					) : null}
				</p>
				<div className="border-border max-h-[75dvh] overflow-auto rounded-lg border print:max-h-none print:overflow-visible">
					<table className="border-collapse text-sm">
						<caption className="sr-only print:not-sr-only print:pb-2 print:text-start print:text-base print:font-semibold">
							<PrintTitle name={scopeName} range={dayTitle} />
						</caption>
						<thead className="bg-background sticky top-0 z-20">
							<tr>
								<th
									scope="col"
									className={cn(
										NAME_COLUMN,
										'bg-background sticky start-0 z-30 p-2 text-start',
									)}
								>
									<span className="text-muted-foreground text-xs font-medium">
										<Trans>Team</Trans>
									</span>
								</th>
								<th
									scope="col"
									className="border-border border-s p-0 font-normal"
								>
									<div style={{ width: `${width}px` }} className="flex">
										{hours.map((hour) => (
											<span
												key={hour}
												style={{ width: `${HOUR_PX}px` }}
												className="text-muted-foreground shrink-0 py-2 ps-1 text-start text-xs tabular-nums"
											>
												{formatHourOfDay(hour, locale)}
											</span>
										))}
									</div>
								</th>
							</tr>
							{demandDay && demandDay.peakHour !== null ? (
								<tr className="border-border border-t">
									<th
										scope="row"
										className={cn(
											NAME_COLUMN,
											'bg-background sticky start-0 z-30 p-2 text-start align-bottom text-xs font-normal',
										)}
									>
										<span className="text-muted-foreground">
											<Trans>Typical online orders</Trans>
										</span>
									</th>
									<td className="border-border border-s p-0">
										<div
											dir="ltr"
											role="img"
											aria-label={_(t`Typical online orders by hour`)}
											style={{ width: `${width}px` }}
											className="flex h-8 items-end"
										>
											{hours.map((hour) => (
												<span
													key={hour}
													style={{ width: `${HOUR_PX}px` }}
													className="flex h-full shrink-0 items-end px-0.5"
												>
													<span
														className="bg-primary/35 w-full rounded-t-xs"
														style={{
															height: `${Math.max((demandDay.bars[hour] ?? 0) * 100, (demandDay.bars[hour] ?? 0) > 0 ? 6 : 0)}%`,
														}}
													/>
												</span>
											))}
										</div>
									</td>
								</tr>
							) : null}
						</thead>
						<tbody>
							{renderRow(grid.open, false)}
							{grid.groups.map((g) => (
								<GroupHeader
									key={g.key}
									label={
										g.position
											? positionName(g.position, locale)
											: group === 'none'
												? null
												: _(t`No position`)
									}
									colorKey={g.position?.colorKey}
								>
									{g.rows.map((row) =>
										renderRow(row, group === 'position' && g.position !== null),
									)}
								</GroupHeader>
							))}
						</tbody>
					</table>
				</div>
				<p className="text-muted-foreground text-xs print:hidden">
					<Trans>
						Drag a shift sideways to change its time, up or down to give it to
						someone else, or drag an end to resize it.
					</Trans>
				</p>
			</div>
		</ScheduleDnd>
	)
}

function GroupHeader({
	label,
	colorKey,
	children,
}: {
	label: string | null
	colorKey: string | undefined
	children: React.ReactNode
}) {
	if (label === null) return <>{children}</>
	return (
		<>
			<tr className="bg-muted/40 border-border border-t">
				<th
					scope="rowgroup"
					colSpan={2}
					className="sticky start-0 px-2 py-1.5 text-start text-xs font-medium"
				>
					<span className="inline-flex items-center gap-2">
						{colorKey ? <PositionDot colorKey={colorKey} /> : null}
						{label}
					</span>
				</th>
			</tr>
			{children}
		</>
	)
}
