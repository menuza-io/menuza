import { Plural, Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PositionDot } from '@repo/ui/position-color'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useMemo } from 'react'
import {
	type SchedulePositionRow,
	type ScheduleShiftRow,
} from '#app/utils/staffing/schedule-types.ts'
import {
	footerFor,
	formatDuration,
	OPEN_ROW,
	positionName,
} from '#app/utils/staffing/schedule-view.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'
import { type BoardProps } from './board-types.ts'
import {
	blockClassName,
	ShiftBlockFace,
	useShiftLabel,
} from './shift-block.tsx'

type Entry = { shift: ScheduleShiftRow; name: string }

/**
 * The phone layout: one day at a time. A strip of the week's days sits on top
 * (with a dot where someone works), and below it is that day's open shifts and
 * then each person's shifts in time order. Moving a shift is done in the editor
 * here, where a drag would fight with scrolling.
 */
export function DayList(props: BoardProps & { date: string }) {
	const {
		week,
		grid,
		positions,
		locale,
		today,
		canWrite,
		showConflicts,
		showCost,
		date,
		onOpenShift,
		onAddShift,
		onPickDate,
	} = props
	const { _ } = useLingui()
	const label = useShiftLabel()
	const footer = footerFor(week, date)

	const sections = useMemo(() => {
		const out: Array<{
			key: string
			title: string | null
			colorKey?: string
			entries: Entry[]
		}> = []
		const open = (grid.open.cells.get(date) ?? []).map((shift) => ({
			shift,
			name: '',
		}))
		if (open.length > 0) {
			out.push({ key: OPEN_ROW, title: _(t`Open shifts`), entries: open })
		}
		for (const g of grid.groups) {
			const entries: Entry[] = []
			for (const row of g.rows) {
				for (const shift of row.cells.get(date) ?? []) {
					entries.push({
						shift,
						name: row.person ? staffDisplayName(row.person, locale) : '',
					})
				}
			}
			if (entries.length === 0) continue
			entries.sort(
				(a, b) =>
					a.shift.startsAt - b.shift.startsAt ||
					a.name.localeCompare(b.name, locale),
			)
			out.push({
				key: g.key,
				title: g.position ? positionName(g.position, locale) : null,
				colorKey: g.position?.colorKey,
				entries,
			})
		}
		return out
	}, [grid, date, locale, _])

	const hasShifts = sections.length > 0
	const positionOf = (
		shift: ScheduleShiftRow,
	): SchedulePositionRow | undefined =>
		shift.positionId ? positions.get(shift.positionId) : undefined

	return (
		<div className="flex flex-col gap-4" data-print-root="">
			<Tabs
				value={date}
				onValueChange={(next) => onPickDate(next as string, 'day')}
			>
				<TabsList
					aria-label={_(t`Days of the week`)}
					className="grid h-auto! w-full grid-cols-7 gap-1"
				>
					{week.dates.map((d) => {
						const f = footerFor(week, d)
						return (
							<TabsTrigger
								key={d}
								value={d}
								className="h-auto! flex-col gap-1 py-2"
							>
								<span
									className={cn(
										'text-xs',
										d === today
											? 'text-primary font-semibold'
											: 'text-muted-foreground',
									)}
								>
									{formatDateLabel(d, locale, { weekday: 'narrow' })}
								</span>
								<span className="text-sm font-semibold tabular-nums">
									{formatDateLabel(d, locale, { day: 'numeric' })}
								</span>
								<span
									aria-hidden="true"
									className={cn(
										'size-1.5 rounded-full',
										f.headcount + f.openShifts > 0
											? 'bg-foreground/60'
											: 'bg-transparent',
									)}
								/>
							</TabsTrigger>
						)
					})}
				</TabsList>
			</Tabs>

			<div className="flex items-baseline justify-between gap-2">
				<h2 className="text-base font-semibold">
					{formatDateLabel(date, locale, {
						weekday: 'long',
						month: 'long',
						day: 'numeric',
					})}
				</h2>
				<p className="text-muted-foreground text-xs tabular-nums">
					<Plural value={footer.headcount} one="# person" other="# people" />
					{' · '}
					{formatDuration(footer.minutes)}
				</p>
			</div>

			{hasShifts ? (
				<div className="flex flex-col gap-4">
					{sections.map((section) => (
						<section
							key={section.key}
							aria-label={section.title ?? undefined}
							className="flex flex-col gap-1.5"
						>
							{section.title ? (
								<h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
									{section.colorKey ? (
										<PositionDot colorKey={section.colorKey} />
									) : null}
									{section.title}
								</h3>
							) : null}
							<ul className="flex flex-col gap-1.5">
								{section.entries.map(({ shift, name }) => (
									<li key={shift.id}>
										<button
											type="button"
											onClick={() => onOpenShift(shift)}
											aria-label={`${name ? `${name}, ` : ''}${label(shift, positionOf(shift), showConflicts)}`}
											className={cn(
												blockClassName(
													shift,
													positionOf(shift),
													showConflicts && shift.conflicts.length > 0,
												),
												'min-h-14 gap-1',
											)}
										>
											{name ? (
												<span className="text-sm font-medium">{name}</span>
											) : null}
											<ShiftBlockFace
												shift={shift}
												position={positionOf(shift)}
												showConflicts={showConflicts}
												showCost={showCost}
												hidePosition={
													section.key !== OPEN_ROW &&
													section.colorKey !== undefined
												}
											/>
										</button>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			) : (
				<p className="text-muted-foreground border-border rounded-lg border border-dashed p-4 text-sm">
					<Trans>Nobody is scheduled this day yet.</Trans>
				</p>
			)}

			{canWrite ? (
				<Button
					variant="outline"
					className="h-11 md:h-8"
					onClick={() => onAddShift({ rowKey: OPEN_ROW, date })}
				>
					<Icon name="plus" />
					<Trans>Add a shift</Trans>
				</Button>
			) : null}
		</div>
	)
}
